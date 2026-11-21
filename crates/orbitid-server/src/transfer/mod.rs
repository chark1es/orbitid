//! `orbitid export` / `orbitid import` / `orbitid copy`.
//!
//! Ported from the retired TypeScript server.
//! The wire format is the same JSON Lines document: one header line
//! (`orbitid_export: 1`, dialect, schema version, encryption-key canary, table
//! list, per-table row counts) followed by one `{"t": table, "r": row}` line per
//! row. Values are portable (epoch milliseconds are already `bigint` columns,
//! JSONB columns are JSON), so an export taken from the TypeScript server on
//! Postgres imports here unchanged, secrets included.
//!
//! Only Postgres is supported: SQLite/PGlite sources are dropped, which the CLI
//! help says explicitly.

mod endpoint;
mod export;
mod import;
mod import_batch;
mod tables;

pub use endpoint::{resolve_endpoint, EndpointVars, FROM_VARS, TO_VARS};
pub use export::ExportResult;
pub use import::{ImportCount, ImportResult};

use orbitid_core::crypto::random_token;
use orbitid_core::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};

pub const EXPORT_FORMAT: i64 = 1;
pub const PAGE_SIZE: i64 = 500;
pub const INSERT_BATCH: usize = 200;
pub const CANARY_PREFIX: &str = "orbitid-export-canary-v1:";
/// The TypeScript Postgres journal this schema matches (0001–0009).
pub const SCHEMA_VERSION: &str = "postgres:10:0009_next_silver_sable";

/// Ephemeral or environment-local tables that never move. `operator_sessions`
/// are dashboard logins (copying them would revive cookies on the target);
/// `rate_limits` (TS) and `rate_limit_windows` (this port) describe live traffic,
/// not data.
pub const SKIPPED_TABLES: [&str; 4] = [
    "operator_sessions",
    "rate_limits",
    "rate_limit_windows",
    "worker_cursors",
];
/// Tables bootstrap fills on a fresh database; they do not make a target
/// "occupied" and are cleared before a normal import.
pub const BOOTSTRAP_TABLES: [&str; 4] = ["instance", "roles", "permissions", "role_permissions"];
/// Tables this port adds that a TypeScript export cannot contain.
pub const RUST_ONLY_TABLES: [&str; 1] = ["uploads"];

pub type TransferResult<T> = Result<T, String>;

/// Streams every copied table to JSON Lines.
pub async fn export_database(
    state: &AppState,
    out: &str,
    progress: &dyn Fn(&str),
) -> TransferResult<ExportResult> {
    export::run(&state.pool, out, &state.env.encryption_key, progress).await
}

/// Exports the database `overrides` points at **without migrating it**: the
/// source of an export is never written to. Fails with an actionable message
/// when its schema is not exactly the one this binary embeds. Returns the
/// result and the database label.
pub async fn export_database_from(
    overrides: orbitid_core::EnvOverrides,
    out: &str,
    progress: &dyn Fn(&str),
) -> TransferResult<(ExportResult, String)> {
    let env = orbitid_core::load_env(overrides).map_err(|error| error.to_string())?;
    let pool = orbitid_core::db::connect(&env)
        .await
        .map_err(|error| error.message)?;
    let result = async {
        orbitid_core::db::assert_schema_current(&pool)
            .await
            .map_err(|error| error.message)?;
        export::run(&pool, out, &env.encryption_key, progress).await
    }
    .await;
    pool.close().await;
    Ok((result?, env.database.label().to_string()))
}

pub async fn import_database(
    state: &AppState,
    input: &str,
    truncate: bool,
    yes: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<ImportResult> {
    if truncate && !yes {
        return Err(
            "--truncate deletes everything in the target database. Pass --yes to confirm.".into(),
        );
    }
    import::run(
        &state.pool,
        input,
        &state.env.encryption_key,
        truncate,
        progress,
    )
    .await
}

pub async fn copy_database(
    from: &str,
    to: &str,
    truncate: bool,
    yes: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<()> {
    copy_database_with(
        orbitid_core::EnvOverrides::default(),
        from,
        to,
        truncate,
        yes,
        progress,
    )
    .await
}

/// [`copy_database`] with settings (encryption key, node env) applied to both
/// sides; the database URLs override `base`.
pub async fn copy_database_with(
    base: orbitid_core::EnvOverrides,
    from: &str,
    to: &str,
    truncate: bool,
    yes: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<()> {
    if truncate && !yes {
        return Err(
            "--truncate deletes everything in the target database. Pass --yes to confirm.".into(),
        );
    }
    // The default SIGINT/SIGTERM disposition kills the process without running
    // `Drop`, which would leave the staged export (the whole database) on disk.
    // Racing the copy against the signals drops its future, and with it the
    // `StagingDir` guard. `biased` polls the signal arm first so the handlers
    // are installed before the staging directory exists.
    COMMITTING.store(false, Ordering::SeqCst);
    tokio::select! {
        biased;
        () = interrupted() => Err(
            "copy interrupted; the staged export was removed. The import runs in one \
             transaction, so the target keeps its previous rows (any pending schema \
             migrations were already applied)"
                .to_string(),
        ),
        result = copy_staged(base, from, to, truncate, yes, progress) => result,
    }
}

/// Set by the import immediately before its `COMMIT` is sent. From then on the
/// outcome is decided by the server, so an interrupt must not drop the future.
pub(super) static COMMITTING: AtomicBool = AtomicBool::new(false);

/// Resolves on SIGINT or SIGTERM, except that signals arriving once the import
/// has reached its commit are ignored (the copy then finishes normally).
async fn interrupted() {
    loop {
        wait_for_signal().await;
        if !COMMITTING.load(Ordering::SeqCst) {
            return;
        }
    }
}

/// Waits for Ctrl-C. A handler-registration failure is logged once and never
/// counts as an interrupt: it waits forever instead.
pub async fn ctrl_c_or_pending() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::warn!("could not install the SIGINT handler: {error}");
        std::future::pending::<()>().await;
    }
}

/// Resolves on SIGINT or SIGTERM.
async fn wait_for_signal() {
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::warn!("could not install the SIGTERM handler: {error}");
                std::future::pending::<()>().await
            }
        }
    };
    tokio::select! {
        () = ctrl_c_or_pending() => {},
        () = terminate => {},
    }
}

async fn copy_staged(
    base: orbitid_core::EnvOverrides,
    from: &str,
    to: &str,
    truncate: bool,
    yes: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<()> {
    let staging =
        StagingDir::create().map_err(|error| format!("cannot stage the export: {error}"))?;
    let temp_path = staging.file.to_string_lossy().to_string();
    let exported = export_database_from(
        orbitid_core::EnvOverrides {
            database_url: Some(from.to_string()),
            ..base.clone()
        },
        &temp_path,
        progress,
    )
    .await;
    exported?;
    let target = orbitid_core::state::create_context(orbitid_core::EnvOverrides {
        database_url: Some(to.to_string()),
        ..base
    })
    .await
    .map_err(|error| error.message)?;
    let result = import_database(&target, &temp_path, truncate, yes, progress).await;
    let _ = result?;
    Ok(())
}

/// A private (0700) directory holding the intermediate export (0600): it
/// carries the whole database, password hashes and encrypted tokens included.
/// Dropping the guard removes both on every exit path.
struct StagingDir {
    dir: std::path::PathBuf,
    file: std::path::PathBuf,
}

impl StagingDir {
    fn create() -> std::io::Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let dir = std::env::temp_dir().join(format!("orbitid-transfer-{}", random_token(12)));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let guard = Self {
            file: dir.join("export.jsonl"),
            dir,
        };
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&guard.file)?;
        Ok(guard)
    }
}

impl Drop for StagingDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
