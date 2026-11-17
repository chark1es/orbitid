//! Server-level startup regression: several replicas may boot concurrently on
//! one empty database.

use std::sync::Arc;

use orbitid_core::state::create_context;
use orbitid_core::testing::{test_overrides, EphemeralDb};

#[tokio::test]
async fn three_replicas_boot_on_an_empty_database() {
    let db = EphemeralDb::create().await.expect("template database");
    let mut tasks = Vec::new();
    for index in 0..3 {
        let url = db.url.clone();
        tasks.push(tokio::spawn(async move {
            let dir =
                std::env::temp_dir().join(format!("orbitid-boot-{index}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("data dir");
            let state = create_context(test_overrides(&url, dir.clone()))
                .await
                .expect("create_context");
            let handles = orbitid_identity::install(&state).await.expect("install");
            (Arc::new(state), handles, dir)
        }));
    }
    let mut states = Vec::new();
    let mut workers = Vec::new();
    let mut dirs = Vec::new();
    for task in tasks {
        let (state, handles, dir) = task.await.expect("join");
        states.push(state);
        workers.push(handles);
        dirs.push(dir);
    }
    let state = states.first().expect("state");
    let permission_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM permissions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    let role_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(permission_count > 0);
    assert!(role_count > 0);
    let duplicate_roles: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (SELECT key FROM roles GROUP BY key HAVING COUNT(*) > 1) d",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(duplicate_roles, 0);
    for workers in &workers {
        workers.shutdown();
    }
    for dir in dirs {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod dashboard_tests {
    use crate::dashboard::is_api_path;

    #[test]
    fn readiness_is_an_api_path() {
        assert!(is_api_path("/ready"));
        assert!(is_api_path("/health"));
        assert!(!is_api_path("/dashboard"));
    }
}
