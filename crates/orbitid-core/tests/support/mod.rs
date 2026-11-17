//! Ephemeral Postgres + AppState helpers for `orbitid-core` integration tests.
//!
//! This is a copy of the public `orbitid_core::testing` harness (which is
//! behind the `test-util` feature and therefore unavailable to a crate's own
//! integration tests). Other crates should use `orbitid_core::testing`.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use orbitid_core::config::EnvOverrides;
use orbitid_core::db;
use orbitid_core::state::{create_context, AppState};

pub const TEMPLATE_DATABASE: &str = "orbit_template_rs";
pub const DEFAULT_ADMIN_URL: &str = "postgres://orbit:orbit@localhost:5432/postgres";

/// The template database actually used: `orbit_template_rs_<migration hash>`.
///
/// Same rule as `orbitid_core::testing::template_database_name`: a migration
/// change yields a new name and a freshly migrated template, so a stale
/// template can never leak an old schema into a test run.
pub fn template_database_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for migration in orbitid_core::db::MIGRATOR.iter() {
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

fn random_suffix() -> String {
    use rand::Rng;
    format!("{:012x}", rand::rng().random::<u64>())
}

fn database_url(admin: &str, name: &str) -> String {
    let mut url = url::Url::parse(admin).unwrap();
    url.set_path(&format!("/{name}"));
    url.to_string()
}

pub async fn admin_pool() -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&admin_url())
        .await
        .unwrap()
}

pub async fn ensure_template() {
    static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let admin = admin_pool().await;
    sqlx::query("SELECT pg_advisory_lock(hashtext('orbit_template_rs_init')::bigint)")
        .execute(&admin)
        .await
        .unwrap();
    if !SWEPT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        sweep_stale_databases(&admin).await;
    }
    let template = template_database_name();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)")
            .bind(template)
            .fetch_one(&admin)
            .await
            .unwrap();
    if !exists {
        sqlx::query(&format!("CREATE DATABASE \"{template}\""))
            .execute(&admin)
            .await
            .unwrap();
    }
    let url = database_url(&admin_url(), template);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    db::run_migrations(&pool).await.unwrap();
    pool.close().await;
    sqlx::query("SELECT pg_advisory_unlock(hashtext('orbit_template_rs_init')::bigint)")
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
}

/// Drops `t_*` databases older than an hour, so crashed test runs cannot
/// accumulate. Only one process sweeps per run, under the template lock.
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

pub struct EphemeralDb {
    pub name: String,
    pub url: String,
    /// Shared with every `AppState` clone through `Extensions`.
    guard: Arc<TestDatabaseGuard>,
}

/// Drops its database when the last reference is gone.
struct TestDatabaseGuard {
    name: String,
}

impl EphemeralDb {
    pub async fn create() -> Self {
        Self::create_impl(Some(template_database_name())).await
    }

    pub async fn create_empty() -> Self {
        Self::create_impl(None).await
    }

    async fn create_impl(template: Option<&str>) -> Self {
        if template.is_some() {
            ensure_template().await;
        }
        let admin = admin_pool().await;
        let mut last = None;
        for attempt in 0..41 {
            let name = format!("t_{}", random_suffix());
            let statement = match template {
                Some(template) => format!("CREATE DATABASE \"{name}\" TEMPLATE \"{template}\""),
                None => format!("CREATE DATABASE \"{name}\""),
            };
            match sqlx::query(&statement).execute(&admin).await {
                Ok(_) => {
                    let url = database_url(&admin_url(), &name);
                    admin.close().await;
                    return Self {
                        name: name.clone(),
                        url,
                        guard: Arc::new(TestDatabaseGuard { name }),
                    };
                }
                Err(error) => {
                    last = Some(error);
                    if attempt == 40 {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(
                        25 + (rand::Rng::random_range(&mut rand::rng(), 0..75) as u64),
                    ))
                    .await;
                }
            }
        }
        panic!("could not create test database: {last:?}");
    }
}

impl Drop for TestDatabaseGuard {
    fn drop(&mut self) {
        let name = self.name.clone();
        // See `orbitid_core::testing`: a dedicated thread and runtime make the
        // DROP run even while the test runtime is shutting down or unwinding.
        let thread = std::thread::Builder::new()
            .name("orbitid-test-db-drop".to_string())
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return;
                };
                runtime.block_on(async move {
                    let admin = admin_pool().await;
                    let _ = sqlx::query(&format!(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{name}' AND pid <> pg_backend_pid()"
                    ))
                    .execute(&admin)
                    .await;
                    let _ = sqlx::query(&format!(
                        "DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"
                    ))
                    .execute(&admin)
                    .await;
                    admin.close().await;
                });
            });
        if let Ok(handle) = thread {
            let _ = handle.join();
        }
    }
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct TestContext {
    pub state: AppState,
    pub db: EphemeralDb,
    pub data_dir: PathBuf,
    _temp: TempDir,
}

/// The `ORBITID_TEST_POOL_MAX` gate, duplicated from `orbitid_core::testing`
/// (which is behind `test-util` and unavailable to this crate's own tests).
fn test_pool_limits() -> (Option<u32>, Option<u64>) {
    let Ok(raw) = std::env::var("ORBITID_TEST_POOL_MAX") else {
        return (None, None);
    };
    let max: u32 = raw.parse().unwrap_or_else(|_| {
        panic!("ORBITID_TEST_POOL_MAX must be a positive integer, got {raw:?}")
    });
    assert!(max > 0, "ORBITID_TEST_POOL_MAX must be a positive integer");
    let acquire = match std::env::var("ORBITID_TEST_POOL_ACQUIRE_MS") {
        Ok(raw) => raw.parse::<u64>().unwrap_or_else(|_| {
            panic!("ORBITID_TEST_POOL_ACQUIRE_MS must be a non-negative integer, got {raw:?}")
        }),
        Err(_) => 2_000,
    };
    (Some(max), Some(acquire))
}

/// Applies the `ORBITID_TEST_POOL_MAX` gate to explicit overrides that go
/// straight to `create_context`; caller-set pool values win.
pub fn with_pool_gate(mut overrides: EnvOverrides) -> EnvOverrides {
    let (max_connections, acquire_timeout_ms) = test_pool_limits();
    if overrides.db_max_connections.is_none() {
        overrides.db_max_connections = max_connections;
    }
    if overrides.db_acquire_timeout_ms.is_none() {
        overrides.db_acquire_timeout_ms = acquire_timeout_ms;
    }
    overrides
}

pub fn test_overrides(database_url: &str, data_dir: PathBuf) -> EnvOverrides {
    // Same `ORBITID_TEST_POOL_MAX` gate as `orbitid_core::testing`.
    let (db_max_connections, db_acquire_timeout_ms) = test_pool_limits();
    EnvOverrides {
        database_url: Some(database_url.to_string()),
        secret_key: Some("sk_test_testsecret".to_string()),
        base_url: Some("http://localhost:4000".to_string()),
        node_env: Some("test".to_string()),
        encryption_key: Some("test-encryption-key-for-orbitid-0123456789".to_string()),
        data_dir: Some(data_dir),
        db_max_connections,
        db_acquire_timeout_ms,
        ..Default::default()
    }
}

pub async fn try_test_state_with(overrides: EnvOverrides) -> orbitid_core::Result<TestContext> {
    let db = EphemeralDb::create().await;
    let data_dir = std::env::temp_dir().join(format!("orbitid-rs-test-{}", random_suffix()));
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut options = test_overrides(&db.url, data_dir.clone());
    macro_rules! take {
        ($field:ident) => {
            if overrides.$field.is_some() {
                options.$field = overrides.$field;
            }
        };
    }
    take!(port);
    take!(base_url);
    take!(trust_proxy);
    take!(database_url);
    take!(encryption_key);
    take!(secret_key);
    take!(data_dir);
    take!(dashboard_dir);
    take!(node_env);
    take!(resend_api_key);
    take!(smtp_url);
    take!(email_from);
    take!(db_max_connections);
    take!(db_acquire_timeout_ms);
    take!(allow_private_networks);
    let state = create_context(options).await?;
    // Keep the database alive while any clone of this state (e.g. a router) is.
    state.extensions.set(Arc::clone(&db.guard));
    Ok(TestContext {
        state,
        db,
        data_dir: data_dir.clone(),
        _temp: TempDir(data_dir),
    })
}

pub async fn test_state() -> TestContext {
    try_test_state_with(EnvOverrides::default()).await.unwrap()
}

pub async fn test_state_with(overrides: EnvOverrides) -> TestContext {
    try_test_state_with(overrides).await.unwrap()
}
