use super::*;
use crate::testing::{create_test_client_session, create_test_guest, test_app_state_with};
use orbitid_core::testing::test_pool_exemption;
use serde_json::json;

async fn aged_guest(state: &AppState, activity: i64) -> orbitid_core::models::UserRow {
    let guest = create_test_guest(state).await.expect("guest");
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(activity)
        .bind(&guest.id)
        .execute(&state.pool)
        .await
        .expect("age the guest");
    guest
}

#[tokio::test]
async fn a_cancelled_tick_does_not_block_the_next_one() {
    // Pool of two: this test holds its own transaction (simulating a cancelled
    // tick's lock) while a second tick runs on the same pool.
    let app = test_app_state_with(test_pool_exemption(2)).await;
    let state = app.state();
    state
        .settings
        .update(json!({ "anonymous": { "enabled": true, "retentionSeconds": 60 } }))
        .await
        .expect("enable guest cleanup");
    let guest = create_test_guest(state).await.expect("guest");
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 3_600_000)
        .bind(&guest.id)
        .execute(&state.pool)
        .await
        .expect("age the guest");

    // Hold the lock in a transaction, then drop it: that is exactly what a
    // cancelled tick does (its future is dropped and the transaction rolls
    // back). A session-scoped lock would instead stay with the pooled
    // connection and keep every later tick out.
    let mut abandoned = state.pool.begin().await.expect("begin");
    let held: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtext('orbitid_anonymous_cleanup')::bigint)",
    )
    .fetch_one(&mut *abandoned)
    .await
    .expect("take the lock");
    assert!(held, "the simulated tick holds the lock");
    assert_eq!(
        cleanup_tick(state).await.expect("skipping tick"),
        None,
        "a second replica skips while the lock is held"
    );

    drop(abandoned);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match cleanup_tick(state).await.expect("next tick") {
            Some(deleted) => {
                assert_eq!(deleted, 1, "the next tick deletes the stale guest");
                break;
            }
            None => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "a cancelled tick blocked the next one"
                );
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&guest.id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(remaining, 0);
}

/// More protected guests than the batch size must not hide the eligible one
/// behind them: the live-session exclusion is part of the candidate query.
#[tokio::test]
async fn protected_guests_do_not_hide_an_eligible_one() {
    let app = test_app_state_with(test_pool_exemption(4)).await;
    let state = app.state();
    state
        .settings
        .update(json!({ "anonymous": { "enabled": true, "retentionSeconds": 60 } }))
        .await
        .expect("enable guest cleanup");
    let now_ms = orbitid_core::http::now();
    let mut protected = Vec::new();
    for index in 0..6 {
        let guest = aged_guest(state, now_ms - 7_200_000 - index * 1000).await;
        let _session = create_test_client_session(state, &guest.id)
            .await
            .expect("active session");
        protected.push(guest.id);
    }
    let eligible = aged_guest(state, now_ms - 3_600_000).await;

    let deleted = cleanup_anonymous_users(state, Some(now_ms), Some(3))
        .await
        .expect("cleanup");
    assert_eq!(
        deleted, 1,
        "the eligible guest is not hidden by protected ones"
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&eligible.id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(remaining, 0);
    for id in protected {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(&id)
            .fetch_one(&state.pool)
            .await
            .expect("count");
        assert!(
            exists,
            "a guest with an active session must never be deleted"
        );
    }
}

/// A candidate whose deletion fails must be logged and skipped, not abort
/// the tick or block the eligible guests behind it.
#[tokio::test]
async fn a_poisoned_candidate_does_not_block_the_rest_of_the_tick() {
    let app = test_app_state_with(test_pool_exemption(4)).await;
    let state = app.state();
    state
        .settings
        .update(json!({ "anonymous": { "enabled": true, "retentionSeconds": 60 } }))
        .await
        .expect("enable guest cleanup");
    let now_ms = orbitid_core::http::now();
    let poisoned = aged_guest(state, now_ms - 7_200_000).await;
    let eligible = aged_guest(state, now_ms - 3_600_000).await;
    let sql = format!(
        "CREATE OR REPLACE FUNCTION orbitid_test_block_delete() RETURNS trigger \
         LANGUAGE plpgsql AS $$ BEGIN \
         IF OLD.id = '{}' THEN RAISE EXCEPTION 'poisoned candidate'; END IF; \
         RETURN OLD; END $$",
        poisoned.id
    );
    sqlx::query(&sql)
        .execute(&state.pool)
        .await
        .expect("poison function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_block_delete BEFORE DELETE ON users \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_block_delete()",
    )
    .execute(&state.pool)
    .await
    .expect("poison trigger");

    let deleted = cleanup_anonymous_users(state, Some(now_ms), Some(5))
        .await
        .expect("a poisoned candidate must not abort the tick");
    assert_eq!(deleted, 1);
    let eligible_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&eligible.id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(
        eligible_left, 0,
        "the guest behind the poison must be deleted"
    );
    let poison_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&poisoned.id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(poison_left, 1);
}

/// More permanently failing guests than the batch size sit ahead of an
/// eligible one: failures must not consume the deletion budget, so the
/// eligible guest is deleted within one tick.
#[tokio::test]
async fn a_failing_head_longer_than_the_batch_does_not_hide_later_guests() {
    let app = test_app_state_with(test_pool_exemption(4)).await;
    let state = app.state();
    state
        .settings
        .update(json!({ "anonymous": { "enabled": true, "retentionSeconds": 60 } }))
        .await
        .expect("enable guest cleanup");
    let now_ms = orbitid_core::http::now();
    let mut poisoned = Vec::new();
    for index in 0..5 {
        poisoned.push(
            aged_guest(state, now_ms - 7_200_000 - index * 1000)
                .await
                .id,
        );
    }
    let eligible = aged_guest(state, now_ms - 3_600_000).await;
    let list = poisoned
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "CREATE OR REPLACE FUNCTION orbitid_test_block_delete() RETURNS trigger \
         LANGUAGE plpgsql AS $$ BEGIN \
         IF OLD.id IN ({list}) THEN RAISE EXCEPTION 'poisoned candidate'; END IF; \
         RETURN OLD; END $$"
    );
    sqlx::query(&sql)
        .execute(&state.pool)
        .await
        .expect("poison function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_block_delete BEFORE DELETE ON users \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_block_delete()",
    )
    .execute(&state.pool)
    .await
    .expect("poison trigger");

    // Batch size 2, five failing guests ahead of the eligible one.
    let deleted = cleanup_anonymous_users(state, Some(now_ms), Some(2))
        .await
        .expect("tick");
    assert_eq!(deleted, 1, "the eligible guest is deleted within one tick");
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&eligible.id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(left, 0);
}
