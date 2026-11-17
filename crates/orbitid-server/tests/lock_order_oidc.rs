//! OIDC consent writes follow the global lock order: the user key-share
//! (rank 3) comes before the consent row. User deletion holds the user row and
//! then cascades into `oauth_consents`, so a consent writer that locked its row
//! first could close a cycle with it.

use std::time::Duration;

use orbitid_core::AppState;
use orbitid_identity::testing::{create_test_user, test_app_state_with};
use orbitid_oidc::services::oidc::consent::record_consent_on;

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

async fn wait_for_lock_waiter(state: &AppState) {
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(&state.pool)
        .await
        .expect("activity");
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the consent writer never blocked on the user row");
}

/// While a deletion holds the user row, the consent writer waits on the user
/// key-share **without** holding the consent row, so the deletion's cascade
/// into `oauth_consents` proceeds; no deadlock and the writer then reports the
/// user as gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn consent_does_not_deadlock_with_user_deletion() {
    // Concurrency test: a held deletion plus the writer need two connections.
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(6)).await;
    let state = app.state();
    let user = create_test_user(state, "consent-order@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, created_at, \
         updated_at) VALUES ('oa_consent','App','client_consent','[\"https://app.test/cb\"]',$1,$1)",
    )
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("application");
    let scopes = vec!["openid".to_string()];
    let mut seed = state.pool.acquire().await.expect("connection");
    record_consent_on(&mut seed, "oa_consent", &user.user.id, &scopes)
        .await
        .expect("first consent");
    drop(seed);
    let before = deadlocks(state).await;

    // The deletion holds the user row (`FOR UPDATE`) …
    let mut deletion = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(&user.user.id)
        .execute(&mut *deletion)
        .await
        .expect("hold the user");
    // … while a consent approval for the same user starts.
    let writer = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let scopes = vec!["openid".to_string(), "profile".to_string()];
        tokio::spawn(async move {
            let mut tx = state.pool.begin().await.expect("begin");
            let result = record_consent_on(&mut tx, "oa_consent", &user_id, &scopes).await;
            match result {
                Ok(()) => {
                    tx.commit().await.expect("commit");
                    Ok(())
                }
                Err(error) => Err(error.code),
            }
        })
    };
    wait_for_lock_waiter(state).await;
    // The cascade step needs the consent row: it must not be held by the writer.
    tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query("DELETE FROM oauth_consents WHERE user_id = $1")
            .bind(&user.user.id)
            .execute(&mut *deletion),
    )
    .await
    .expect("the consent row is not locked by the waiting writer")
    .expect("delete consents");
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&user.user.id)
        .execute(&mut *deletion)
        .await
        .expect("delete user");
    deletion.commit().await.expect("commit");

    let outcome = writer.await.expect("join");
    assert_eq!(outcome, Err("resource_not_found".to_string()));
    assert_eq!(deadlocks(state).await - before, 0);
}

/// A device approval writes `device_codes.user_id`, a foreign key to `users`.
/// It takes the user key-share before the device row, so a deletion that holds
/// the user and then cascades into `device_codes` cannot deadlock with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn device_approval_does_not_deadlock_with_user_deletion() {
    use orbitid_oidc::services::oidc::device::{decide_device_code, DeviceDecisionInput};

    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(6)).await;
    let state = app.state();
    let user = create_test_user(state, "device-order@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, created_at, \
         updated_at) VALUES ('oa_device','App','client_device','[\"https://app.test/cb\"]',$1,$1)",
    )
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("application");
    let code = orbitid_oidc::services::oidc::device::generate_user_code();
    sqlx::query(
        "INSERT INTO device_codes (id, application_id, device_code_hash, user_code, scopes, \
         status, expires_at, created_at) VALUES ('dc_order','oa_device','hash',$1,'openid','pending',$2,$3)",
    )
    .bind(&code)
    .bind(now + 600_000)
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("device code");
    let before = deadlocks(state).await;

    let mut deletion = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(&user.user.id)
        .execute(&mut *deletion)
        .await
        .expect("hold the user");
    let approval = {
        let state = state.clone();
        let user_id = user.user.id.clone();
        let code = code.clone();
        tokio::spawn(async move {
            decide_device_code(
                &state,
                DeviceDecisionInput {
                    user_code: &code,
                    user_id: &user_id,
                    approve: true,
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| error.code)
        })
    };
    wait_for_lock_waiter(state).await;
    tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query("DELETE FROM device_codes WHERE id = 'dc_order'").execute(&mut *deletion),
    )
    .await
    .expect("the device row is not locked by the waiting approval")
    .expect("delete the device code");
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&user.user.id)
        .execute(&mut *deletion)
        .await
        .expect("delete user");
    deletion.commit().await.expect("commit");

    assert_eq!(
        approval.await.expect("join"),
        Err("resource_not_found".to_string())
    );
    assert_eq!(deadlocks(state).await - before, 0);
}
