use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::db;
use crate::error::Result;

pub const TEMPLATE_DATABASE: &str = "orbit_template_rs";
pub const DEFAULT_ADMIN_URL: &str = "postgres://orbit:orbit@localhost:5432/postgres";

/// The template database actually used: `orbit_template_rs_<migration hash>`.
///
/// A template is a migrated snapshot, so a template built by an older checkout
/// is missing whatever the newest migration added and would silently serve a
/// stale schema to every test. Keying the name on the embedded migration set
/// means a migration change produces a new name and a fresh template, with no
/// manual `DROP DATABASE orbit_template_rs` ever required. Superseded templates
/// are left in place (a concurrently running suite on the previous revision
/// still uses its own) and only cost disk.
///
/// The digest is only a cache key: it uses the standard-library hasher, so a
/// toolchain upgrade may produce a new (harmless, freshly migrated) template.
pub fn template_database_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for migration in crate::db::MIGRATOR.iter() {
            migration.version.hash(&mut hasher);
            migration.description.hash(&mut hasher);
            migration.checksum.hash(&mut hasher);
        }
        format!("{TEMPLATE_DATABASE}_{:016x}", hasher.finish())
    })
}

pub fn admin_url() -> String {
    std::env::var("ORBITID_TEST_PG_ADMIN_URL").unwrap_or_else(|_| DEFAULT_ADMIN_URL.to_string())
}

pub(super) fn random_suffix() -> String {
    use rand::Rng;
    format!("{:012x}", rand::rng().random::<u64>())
}

pub(super) fn database_url(admin: &str, name: &str) -> String {
    match url::Url::parse(admin) {
        Ok(mut url) => {
            url.set_path(&format!("/{name}"));
            url.to_string()
        }
        Err(_) => format!("{}/{name}", admin.trim_end_matches('/')),
    }
}

async fn admin_pool() -> Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&admin_url())
        .await?)
}

async fn create_database(admin: &PgPool, name: &str, template: Option<&str>) -> Result<()> {
    let statement = match template {
        Some(template) => format!("CREATE DATABASE \"{name}\" TEMPLATE \"{template}\""),
        None => format!("CREATE DATABASE \"{name}\""),
    };
    sqlx::query(&statement).execute(admin).await?;
    Ok(())
}

async fn drop_database(name: &str) {
    let Ok(admin) = admin_pool().await else {
        return;
    };
    let Ok(mut conn) = admin.acquire().await else {
        let _ = admin.close().await;
        return;
    };
    // `DROP DATABASE … WITH (FORCE)` sends a cluster-wide ProcSignalBarrier.
    // Running several of them at once (a test suite finishing in parallel, or
    // two test processes) makes those barriers wait on each other for tens of
    // seconds, so all test databases in the cluster drop one at a time.
    // A session-level lock is released automatically if a process dies.
    let _ = sqlx::query("SELECT pg_advisory_lock(hashtext('orbit_test_db_drop')::bigint)")
        .execute(&mut *conn)
        .await;
    let terminate = format!(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
         WHERE datname = '{name}' AND pid <> pg_backend_pid()"
    );
    let _ = sqlx::query(&terminate).execute(&mut *conn).await;
    let _ = sqlx::query(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
        .execute(&mut *conn)
        .await;
    let _ = sqlx::query("SELECT pg_advisory_unlock(hashtext('orbit_test_db_drop')::bigint)")
        .execute(&mut *conn)
        .await;
    drop(conn);
    let _ = admin.close().await;
}

/// Drops `t_*` databases left behind by crashed or killed test runs.
///
/// Only databases whose files are more than an hour old are touched, so a
/// concurrently running test suite never loses its own database. Failures are
/// ignored: the sweep is housekeeping, not part of the test contract.
async fn sweep_stale_databases(admin: &PgPool) {
    let names = sqlx::query_scalar::<_, String>(
        "SELECT datname FROM pg_database \
         WHERE datname LIKE 't\\_%' \
           AND datname NOT LIKE 'orbit\\_template\\_rs%' \
           AND (pg_stat_file('base/' || oid::text || '/PG_VERSION', true)).modification \
               < now() - interval '1 hour'",
    )
    .fetch_all(admin)
    .await;
    let Ok(names) = names else {
        // `pg_stat_file` needs superuser (or pg_read_server_files); without it
        // the synchronous Drop below is still the primary cleanup path.
        return;
    };
    for name in names {
        let escaped = name.replace('"', "\"\"");
        let _ = sqlx::query(&format!(
            "DROP DATABASE IF EXISTS \"{escaped}\" WITH (FORCE)"
        ))
        .execute(admin)
        .await;
    }
}

/// Ensures the template database exists and is migrated, guarded by an advisory
/// lock so concurrent test processes (or test binaries) do not race. The same
/// lock lets exactly one process sweep stale databases per run.
pub async fn ensure_template() -> Result<()> {
    static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let admin = admin_pool().await?;
    sqlx::query("SELECT pg_advisory_lock(hashtext('orbit_template_rs_init')::bigint)")
        .execute(&admin)
        .await?;
    let result = async {
        if !SWEPT.swap(true, std::sync::atomic::Ordering::SeqCst) {
            sweep_stale_databases(&admin).await;
        }
        let template = template_database_name();
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
                .bind(template)
                .fetch_one(&admin)
                .await?;
        if !exists {
            create_database(&admin, template, None).await?;
        }
        let url = database_url(&admin_url(), template);
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&url)
            .await?;
        let migration = db::run_migrations(&pool).await;
        let _ = pool.close().await;
        migration?;
        Ok::<(), crate::error::OrbitError>(())
    }
    .await;
    let _ = sqlx::query("SELECT pg_advisory_unlock(hashtext('orbit_template_rs_init')::bigint)")
        .execute(&admin)
        .await;
    let _ = admin.close().await;
    result
}

/// An ephemeral database copied from the migrated template.
pub struct EphemeralDb {
    pub name: String,
    pub url: String,
    /// Shared with every `AppState` clone through `Extensions`, so a test that
    /// drops the context but keeps using a router does not lose its database.
    pub(super) guard: Arc<TestDatabaseGuard>,
}

/// Drops its database when the last reference (the `EphemeralDb` or any
/// `AppState` clone built from it) is gone.
pub(super) struct TestDatabaseGuard {
    name: String,
}

impl Drop for TestDatabaseGuard {
    fn drop(&mut self) {
        let name = self.name.clone();
        // Drop synchronously on a dedicated thread with its own short-lived
        // runtime: the test's runtime (or a panic) may be unwinding, and a
        // spawned task on it would be killed before it ran. `WITH (FORCE)`
        // terminates the test state's still-open pool connections.
        let thread = std::thread::Builder::new()
            .name("orbitid-test-db-drop".to_string())
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                runtime.block_on(drop_database(&name));
            });
        if let Ok(handle) = thread {
            let _ = handle.join();
        }
    }
}

impl EphemeralDb {
    pub async fn create() -> Result<Self> {
        ensure_template().await?;
        let admin = admin_pool().await?;
        let mut last_error = None;
        for attempt in 0..41 {
            let name = format!("t_{}", random_suffix());
            match create_database(&admin, &name, Some(template_database_name())).await {
                Ok(()) => {
                    let url = database_url(&admin_url(), &name);
                    let _ = admin.close().await;
                    return Ok(Self {
                        name: name.clone(),
                        url,
                        guard: Arc::new(TestDatabaseGuard { name }),
                    });
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt == 40 {
                        break;
                    }
                    let jitter = 25 + (rand::Rng::random_range(&mut rand::rng(), 0..75) as u64);
                    tokio::time::sleep(std::time::Duration::from_millis(jitter)).await;
                }
            }
        }
        let _ = admin.close().await;
        Err(last_error.unwrap_or_else(|| {
            crate::error::OrbitError::internal("could not create test database")
        }))
    }

    /// Explicit asynchronous cleanup. The guard will only issue a harmless
    /// `DROP … IF EXISTS` later if an `AppState` clone outlives this call.
    pub async fn cleanup(self) {
        drop_database(&self.name).await;
    }
}

pub(super) struct TempDir(pub(super) std::path::PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
