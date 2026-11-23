use super::db::{random_suffix, EphemeralDb, TempDir};
use std::sync::Arc;

use crate::config::EnvOverrides;
use crate::error::Result;
use crate::state::{create_context, AppState};

/// A migrated state plus its database and temporary data directory.
pub struct TestContext {
    pub state: AppState,
    pub db: EphemeralDb,
    pub data_dir: std::path::PathBuf,
    _temp: TempDir,
}

/// The `ORBITID_TEST_POOL_MAX` gate: when set, every test state is built with
/// exactly this many pool connections and a short acquire timeout, so any
/// request path that takes a second connection while it already holds one fails
/// with a pool timeout instead of silently working on a large pool. Unset, tests
/// keep the production pool defaults.
///
/// Returns `(max_connections, acquire_timeout_ms)`.
pub fn test_pool_limits() -> (Option<u32>, Option<u64>) {
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

/// Overrides for a test that legitimately needs more than one connection at a
/// time: concurrent requests, a test transaction/LISTEN connection on the same
/// pool, or a background worker running beside a request. Add a one-line comment
/// at the call site saying why. This is not a way to hide a handler that keeps a
/// connection open while it serialises its response.
pub fn test_pool_exemption(max_connections: u32) -> EnvOverrides {
    let (_, acquire_timeout_ms) = test_pool_limits();
    EnvOverrides {
        db_max_connections: Some(max_connections),
        db_acquire_timeout_ms: acquire_timeout_ms,
        ..Default::default()
    }
}

/// Applies the `ORBITID_TEST_POOL_MAX` gate to an explicit override set that is
/// passed straight to `create_context` (a second replica, a CLI tool's state).
/// Values the caller set explicitly are left alone.
pub fn with_test_pool_gate(mut overrides: EnvOverrides) -> EnvOverrides {
    let (max_connections, acquire_timeout_ms) = test_pool_limits();
    if overrides.db_max_connections.is_none() {
        overrides.db_max_connections = max_connections;
    }
    if overrides.db_acquire_timeout_ms.is_none() {
        overrides.db_acquire_timeout_ms = acquire_timeout_ms;
    }
    overrides
}

/// Fixed keys used by the TypeScript test helpers.
pub fn test_overrides(database_url: &str, data_dir: std::path::PathBuf) -> EnvOverrides {
    let (db_max_connections, db_acquire_timeout_ms) = test_pool_limits();
    EnvOverrides {
        database_url: Some(database_url.to_string()),
        secret_key: Some("sk_test_testsecret".to_string()),
        base_url: Some("http://localhost:4000".to_string()),
        node_env: Some("test".to_string()),
        encryption_key: Some("test-encryption-key-for-orbitid-0123456789".to_string()),
        // Tests must not pick up a dashboard build that happens to exist in the
        // checkout; dashboard tests point at their own directory explicitly.
        dashboard_dir: Some(data_dir.join("__no_dashboard__")),
        data_dir: Some(data_dir),
        db_max_connections,
        db_acquire_timeout_ms,
        ..Default::default()
    }
}

pub async fn try_test_state_with(overrides: EnvOverrides) -> Result<TestContext> {
    let db = EphemeralDb::create().await?;
    let data_dir = std::env::temp_dir().join(format!("orbitid-rs-test-{}", random_suffix()));
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| crate::error::OrbitError::internal(error.to_string()))?;
    let mut options = test_overrides(&db.url, data_dir.clone());
    // Caller-provided fields win.
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
    take!(request_timeout_ms);
    take!(drain_timeout_ms);
    take!(allow_private_networks);
    take!(webhook_retention_days);
    take!(audit_retention_days);
    take!(retention_batch_size);
    take!(retention_interval_ms);
    take!(retention_budget_ms);
    take!(enrollment_interval_ms);
    take!(update_check);
    let state = create_context(options).await?;
    // Keep the database alive as long as any clone of this state (e.g. the one
    // held by a built router) is alive, not just as long as the TestContext is.
    state.extensions.set(Arc::clone(&db.guard));
    Ok(TestContext {
        state,
        db,
        data_dir: data_dir.clone(),
        _temp: TempDir(data_dir),
    })
}

/// Convenience: panics when the harness cannot start (tests may panic).
pub async fn test_state() -> TestContext {
    match try_test_state_with(EnvOverrides::default()).await {
        Ok(context) => context,
        Err(error) => panic!("could not create test state: {error}"),
    }
}

pub async fn test_state_with(overrides: EnvOverrides) -> TestContext {
    match try_test_state_with(overrides).await {
        Ok(context) => context,
        Err(error) => panic!("could not create test state: {error}"),
    }
}
