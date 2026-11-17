//! Database access: pool creation, migrations and helpers shared by services.
//!
//! Migrations are embedded from `crates/orbitid-core/migrations`. Migration
//! 0001 is the exact schema the TypeScript server's drizzle migrations produce;
//! an existing drizzle-managed database is *baselined* (recorded as applied)
//! instead of having its tables re-created. a Postgres session advisory lock
//! serialises the whole startup sequence, so several replicas may boot at once.

pub mod helpers;
pub mod retry;

pub use helpers::*;
pub use retry::{retryable_conflict, with_retry, MAX_TRANSACTION_ATTEMPTS};

use std::time::Duration;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::config::Env;
use crate::error::{OrbitError, Result};

/// The migration set, embedded at compile time.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// `created_at` of drizzle migration `0009_next_silver_sable`.
const DRIZZLE_0009_WHEN: i64 = 1_794_386_538_117;
const DRIZZLE_MIGRATION_COUNT: i64 = 10;

/// Opens the pool. Every statement is parameterised; no compile-time query macros
/// are used, so a schema change does not require the SQL to be re-checked at build time.
pub async fn connect(env: &Env) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(env.db_max_connections)
        .acquire_timeout(Duration::from_millis(env.db_acquire_timeout_ms))
        .connect_with(env.database.connect_options())
        .await
        .map_err(|error| {
            OrbitError::internal(format!(
                "Could not connect to the database at {}: {error}",
                env.database.label()
            ))
        })
}

/// Runs migrations, baselining a drizzle-managed Postgres deployment.
///
/// The whole startup sequence (invalid-index inspection and cleanup, drizzle
/// baseline, migrations) runs on ONE dedicated connection under ONE session
/// advisory lock, so several replicas starting at once are serialised: a replica
/// that waits sees the migrations already applied and does nothing, and nobody
/// drops an index another replica is still building concurrently. sqlx's own
/// migration lock is disabled for this run (a private `Migrator` copy) because
/// ours is held for the same span on the same connection; nothing needs a second
/// pool connection, so a pool of one works. `orbitid migrate` and the server's
/// `start` both come through here.
pub async fn run_migrations(pool: &PgPool) -> Result<()> {
    let mut connection = pool.acquire().await?;
    // From here the session may hold the startup lock. If this future is
    // cancelled (or the unlock fails) the connection must not go back to the
    // pool still holding it: closing the session releases a session lock.
    connection.close_on_drop();
    // Poll with `pg_try_advisory_lock` instead of blocking in `pg_advisory_lock`:
    // a session blocked in a statement counts as a running transaction, and the
    // lock holder's `CREATE INDEX CONCURRENTLY` waits for every such transaction
    // to finish, which would be a deadlock. Each try is a statement that ends at
    // once, so a waiting replica never holds a snapshot while it waits.
    let waiting_since = std::time::Instant::now();
    let mut next_notice = Duration::ZERO;
    loop {
        let acquired: bool =
            sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1)::bigint)")
                .bind(STARTUP_LOCK)
                .fetch_one(&mut *connection)
                .await?;
        if acquired {
            break;
        }
        // No timeout: a healthy slow migration on another instance must not
        // make this one fail. Say why it is waiting, now and every 10 s.
        if waiting_since.elapsed() >= next_notice {
            tracing::info!(
                waited_seconds = waiting_since.elapsed().as_secs(),
                "another instance is migrating the database; waiting for it to finish"
            );
            next_notice = waiting_since.elapsed() + STARTUP_WAIT_NOTICE;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let result = migrate_locked(&mut connection).await;
    // The connection is closed on drop either way, which also releases the
    // lock; the explicit unlock only makes the common path prompt.
    let _ = sqlx::query("SELECT pg_advisory_unlock(hashtext($1)::bigint)")
        .bind(STARTUP_LOCK)
        .execute(&mut *connection)
        .await;
    result
}

/// How often a waiting instance repeats that it is waiting.
const STARTUP_WAIT_NOTICE: Duration = Duration::from_secs(10);

/// Read-only check that `pool`'s database is at exactly the schema this binary
/// embeds, for callers that must never write to it (`orbitid export` and the
/// source of `orbitid copy`). Nothing is migrated or baselined.
pub async fn assert_schema_current(pool: &PgPool) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;
    let applied: Vec<i64> = if exists {
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
            .fetch_all(pool)
            .await?
    } else {
        Vec::new()
    };
    let newest_embedded = MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0);
    let newest_applied = applied.last().copied().unwrap_or(0);
    if applied
        .iter()
        .any(|v| !MIGRATOR.iter().any(|m| m.version == *v))
    {
        return Err(OrbitError::internal(format!(
            "The source database is at migration {newest_applied}, newer than this binary \
             supports ({newest_embedded}). Use the newer OrbitID release; nothing was changed."
        )));
    }
    let drizzle_managed: bool =
        sqlx::query_scalar("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;
    if !exists && drizzle_managed {
        return Err(OrbitError::internal(
            "The source database is still managed by the TypeScript server (a drizzle \
             migration ledger and no sqlx ledger). Either run `orbitid migrate` against it, which \
             adopts and upgrades it in place (this WRITES to that database), or export it with \
             the TypeScript server and `orbitid import` the file instead; nothing was changed."
                .to_string(),
        ));
    }
    if MIGRATOR.iter().any(|m| !applied.contains(&m.version)) {
        let state = if applied.is_empty() {
            "has no migrations applied (it is empty or not an OrbitID database)".to_string()
        } else {
            format!("is at migration {newest_applied}")
        };
        return Err(OrbitError::internal(format!(
            "The source database {state}, older than this binary \
             expects ({newest_embedded}). Run `orbitid migrate` against it first (it is never \
             migrated implicitly because copying and exporting must not write to the source); \
             nothing was changed."
        )));
    }
    Ok(())
}

/// Session advisory lock key held for the whole startup/migration sequence.
const STARTUP_LOCK: &str = "orbitid_startup_migrations";

async fn migrate_locked(connection: &mut sqlx::PgConnection) -> Result<()> {
    baseline_drizzle_if_needed(connection).await?;
    drop_invalid_concurrent_indexes(connection).await?;
    let migrator = sqlx::migrate::Migrator {
        migrations: MIGRATOR.migrations.clone(),
        ignore_missing: MIGRATOR.ignore_missing,
        locking: false,
        no_tx: MIGRATOR.no_tx,
    };
    migrator
        .run_direct(&mut *connection)
        .await
        .map_err(|error| OrbitError::internal(format!("Database migration failed: {error}")))?;
    ensure_required_indexes(connection).await
}

/// `-- no-transaction` migrations whose index must exist after startup, as
/// `(index name, migration source)`. The statement is taken from the migration
/// file itself ([`index_statement`]), so there is one definition. A migration
/// recorded as applied proves nothing about its index: an interrupted repair
/// (drop, then rebuild) or an operator's `DROP INDEX` leaves the ledger intact.
const REQUIRED_INDEXES: [(&str, &str); 4] = [
    (
        "email_addresses_verified_domain_idx",
        include_str!("../../migrations/0010_email_domain_index.sql"),
    ),
    (
        "oauth_grants_user_idx",
        include_str!("../../migrations/0013_oauth_grants_user_idx.sql"),
    ),
    (
        "oauth_grants_session_idx",
        include_str!("../../migrations/0014_oauth_grants_session_idx.sql"),
    ),
    (
        "oauth_grants_application_idx",
        include_str!("../../migrations/0015_oauth_grants_application_idx.sql"),
    ),
];

/// The single `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` statement of a
/// migration file: its non-comment lines, without the trailing semicolon.
fn index_statement(migration: &str) -> String {
    migration
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .trim_end_matches(';')
        .to_string()
}

/// Creates every [`REQUIRED_INDEXES`] entry that is missing (after migrations,
/// under the startup lock, autocommit). An INVALID one was already dropped.
async fn ensure_required_indexes(connection: &mut sqlx::PgConnection) -> Result<()> {
    for (name, migration) in REQUIRED_INDEXES {
        let present: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("public.{name}"))
            .fetch_one(&mut *connection)
            .await?;
        if present {
            continue;
        }
        tracing::warn!("recreating missing index {name} (its migration is already recorded)");
        sqlx::query(&index_statement(migration))
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

/// Indexes that migrations build with `CREATE INDEX CONCURRENTLY`. A failed or
/// cancelled concurrent build leaves an INVALID index of the same name, which
/// `IF NOT EXISTS` would then skip forever. It is dropped and rebuilt here from
/// its own definition (`pg_get_indexdef`, so the migration file stays the only
/// place that defines it), whether or not its migration is already recorded as
/// applied: startup always ends with the index present and valid. Runs under
/// the startup lock, so an INVALID index here is a leftover, never another
/// replica's build in progress.
const CONCURRENT_INDEXES: [&str; 4] = [
    "email_addresses_verified_domain_idx",
    "oauth_grants_user_idx",
    "oauth_grants_session_idx",
    "oauth_grants_application_idx",
];

async fn drop_invalid_concurrent_indexes(connection: &mut sqlx::PgConnection) -> Result<()> {
    for name in CONCURRENT_INDEXES {
        let invalid: Option<String> = sqlx::query_scalar(
            "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i \
             JOIN pg_class c ON c.oid = i.indexrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = 'public' AND c.relname = $1 AND NOT i.indisvalid",
        )
        .bind(name)
        .fetch_optional(&mut *connection)
        .await?;
        if let Some(definition) = invalid {
            tracing::warn!("rebuilding invalid index {name} left by a failed concurrent build");
            // Autocommit: neither statement can run in a transaction.
            sqlx::query(&format!("DROP INDEX CONCURRENTLY IF EXISTS public.{name}"))
                .execute(&mut *connection)
                .await?;
            let rebuild = definition.replacen("INDEX ", "INDEX CONCURRENTLY IF NOT EXISTS ", 1);
            sqlx::query(&rebuild).execute(&mut *connection).await?;
        }
    }
    Ok(())
}

async fn table_exists(connection: &mut sqlx::PgConnection, name: &str) -> Result<bool> {
    let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
        .bind(name)
        .fetch_one(&mut *connection)
        .await?;
    Ok(exists)
}

async fn applied_migration_count_on(connection: &mut sqlx::PgConnection) -> Result<i64> {
    if !table_exists(connection, "public._sqlx_migrations").await? {
        return Ok(0);
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&mut *connection)
        .await?;
    Ok(count)
}

/// Baselines a drizzle-managed database (caller holds the startup lock).
async fn baseline_drizzle_if_needed(connection: &mut sqlx::PgConnection) -> Result<()> {
    if !table_exists(connection, "drizzle.__drizzle_migrations").await? {
        return Ok(());
    }
    if applied_migration_count_on(connection).await? > 0 {
        return Ok(());
    }
    let (count, newest): (i64, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*)::bigint, MAX(created_at) FROM drizzle.__drizzle_migrations",
    )
    .fetch_one(&mut *connection)
    .await?;
    let newest = newest.unwrap_or(0);
    if count < DRIZZLE_MIGRATION_COUNT || newest < DRIZZLE_0009_WHEN {
        return Err(OrbitError::internal(format!(
                "This database was migrated by the TypeScript server but is not at migration 0009 \
                 (found {count} drizzle migrations, newest commit timestamp {newest}). \
                 Start the TypeScript server once to finish its migrations, then start the Rust server."
            )));
    }
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
                success BOOLEAN NOT NULL,
                checksum BYTEA NOT NULL,
                execution_time BIGINT NOT NULL
            )",
    )
    .execute(&mut *connection)
    .await?;
    let baseline = MIGRATOR
        .iter()
        .find(|migration| migration.version == 1)
        .ok_or_else(|| OrbitError::internal("Baseline migration is missing"))?;
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
             VALUES ($1, $2, true, $3, 0) ON CONFLICT (version) DO NOTHING",
    )
    .bind(baseline.version)
    .bind(baseline.description.as_ref())
    .bind(baseline.checksum.to_vec())
    .execute(&mut *connection)
    .await?;
    tracing::info!(
        "Existing drizzle-managed database detected at migration 0009; recording the Rust baseline"
    );
    Ok(())
}

/// Password-free database label, safe to print (mirrors `redact` in `db/index.ts`).
pub fn redact_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if !parsed.username().is_empty() {
                let _ = parsed.set_password(None);
            }
            parsed.to_string().trim_end_matches('/').to_string()
        }
        Err(_) => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_passwords() {
        assert_eq!(
            redact_url("postgres://orbit:secret@localhost:5432/orbit"),
            "postgres://orbit@localhost:5432/orbit"
        );
        assert_eq!(redact_url("not a url"), "not a url");
    }

    #[test]
    fn required_index_statements_are_the_migration_statements() {
        for (name, migration) in REQUIRED_INDEXES {
            let statement = index_statement(migration);
            assert!(
                statement.starts_with("CREATE INDEX CONCURRENTLY IF NOT EXISTS "),
                "{statement}"
            );
            assert!(statement.contains(name), "{statement}");
            assert!(
                !statement.contains(';'),
                "exactly one statement: {statement}"
            );
        }
        assert!(CONCURRENT_INDEXES.iter().all(|name| REQUIRED_INDEXES
            .iter()
            .any(|(required, _)| required == name)));
    }

    #[test]
    fn baseline_migration_is_version_one() {
        assert!(MIGRATOR.iter().any(|m| m.version == 1));
        assert!(MIGRATOR.iter().any(|m| m.version == 2));
    }
}
