//! Distributed rate-limit counters: the limits hold across replicas.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use orbitid_core::config::EnvOverrides;
use orbitid_core::http::rate_limit::{assert_not_blocked, hit};

fn temp_dir() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("orbitid-rate-test-{}", nanoid::nanoid!(10)));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[tokio::test]
async fn fixed_window_counts_up_and_blocks() {
    let ctx = support::test_state().await;
    let key = "unit:sign_in:203.0.113.9";
    hit(&ctx.state, key, 2, 60_000).await.unwrap();
    // A check does not consume the budget.
    assert_not_blocked(&ctx.state, key, 2).await.unwrap();
    assert_not_blocked(&ctx.state, key, 2).await.unwrap();
    hit(&ctx.state, key, 2, 60_000).await.unwrap();
    let error = hit(&ctx.state, key, 2, 60_000).await.unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error.code, "rate_limit_exceeded");
    let retry = error.meta.as_ref().unwrap()["retry_after"]
        .as_i64()
        .unwrap();
    assert!((0..=60).contains(&retry));
    assert!(assert_not_blocked(&ctx.state, key, 2).await.is_err());
}

#[tokio::test]
async fn limits_are_shared_between_replicas() {
    let first = support::test_state().await;
    let second = support::try_test_state_with(EnvOverrides {
        database_url: Some(first.db.url.clone()),
        data_dir: Some(temp_dir()),
        ..Default::default()
    })
    .await
    .unwrap();

    let key = "unit:secret_key_failure:198.51.100.7";
    hit(&first.state, key, 2, 60_000).await.unwrap();
    hit(&first.state, key, 2, 60_000).await.unwrap();
    // The second replica has never seen this key locally, but Postgres has.
    let error = hit(&second.state, key, 2, 60_000).await.unwrap_err();
    assert_eq!(error.code, "rate_limit_exceeded");
}

#[tokio::test]
async fn disabled_rate_limiting_is_a_no_op() {
    let ctx = support::test_state().await;
    ctx.state
        .settings
        .update(serde_json::json!({ "security": { "rateLimitEnabled": false } }))
        .await
        .unwrap();
    for _ in 0..20 {
        hit(&ctx.state, "unit:disabled", 1, 60_000).await.unwrap();
    }
}
