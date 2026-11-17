//! Guests whose deletion fails permanently, and that sort ahead of every other
//! stale guest, must not hide the eligible guests behind them: the cleanup
//! keeps paging with its keyset cursor past failures.

use orbitid_core::http::now;
use orbitid_identity::anonymous::cleanup_anonymous_users;
use orbitid_identity::testing::{create_test_guest, test_app_state};

#[tokio::test]
async fn failing_guests_ahead_of_an_eligible_one_do_not_hide_it() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(
            serde_json::json!({ "anonymous": { "enabled": true, "retentionSeconds": 2592000 } }),
        )
        .await
        .expect("enable guests");
    // The batch is 2; five poisoned guests are the oldest, then one healthy one.
    let batch = 2;
    let mut poisoned = Vec::new();
    for _ in 0..(batch * 2 + 1) {
        poisoned.push(create_test_guest(state).await.expect("guest").id);
    }
    let healthy = create_test_guest(state).await.expect("guest").id;
    let base = now() - 90 * 86_400_000;
    for (index, id) in poisoned.iter().enumerate() {
        sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
            .bind(base + index as i64)
            .bind(id)
            .execute(&state.pool)
            .await
            .expect("age poisoned");
    }
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(base + 1_000)
        .bind(&healthy)
        .execute(&state.pool)
        .await
        .expect("age healthy");
    sqlx::query("CREATE TABLE poisoned_guest_ids (id text PRIMARY KEY)")
        .execute(&state.pool)
        .await
        .expect("poison table");
    sqlx::query("INSERT INTO poisoned_guest_ids SELECT unnest($1::text[])")
        .bind(&poisoned)
        .execute(&state.pool)
        .await
        .expect("poison ids");
    sqlx::query(
        "CREATE FUNCTION poisoned_guest() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF EXISTS (SELECT 1 FROM poisoned_guest_ids WHERE id = OLD.id) \
         THEN RAISE EXCEPTION 'poisoned guest'; END IF; RETURN OLD; END $$",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER poisoned_guest BEFORE DELETE ON users \
         FOR EACH ROW EXECUTE FUNCTION poisoned_guest()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");

    let deleted = cleanup_anonymous_users(state, None, Some(batch as i64))
        .await
        .expect("cleanup");
    assert_eq!(deleted, 1, "the healthy guest is deleted within one tick");
    let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = ANY($1)")
        .bind(&poisoned)
        .fetch_all(&state.pool)
        .await
        .expect("remaining");
    assert_eq!(remaining.len(), poisoned.len());
}

/// A zero budget makes every tick end after its first page. More permanently
/// failing guests than one page sit ahead of a healthy one: the durable cursor
/// makes each tick continue after the last examined candidate, so the healthy
/// guest is reached, and after the scan wraps a guest that failed earlier is
/// retried.
#[tokio::test]
async fn a_zero_budget_tick_still_progresses_past_a_poisoned_page_and_wraps() {
    use orbitid_identity::anonymous::{cleanup_tick, ANONYMOUS_CLEANUP_BATCH};
    use orbitid_identity::testing::test_app_state_with;

    let app = test_app_state_with(orbitid_core::config::EnvOverrides {
        retention_budget_ms: Some(0),
        ..Default::default()
    })
    .await;
    let state = app.state();
    state
        .settings
        .update(
            serde_json::json!({ "anonymous": { "enabled": true, "retentionSeconds": 2592000 } }),
        )
        .await
        .expect("enable guests");
    let poisoned_count = ANONYMOUS_CLEANUP_BATCH + 3;
    let mut poisoned = Vec::new();
    for _ in 0..poisoned_count {
        poisoned.push(create_test_guest(state).await.expect("guest").id);
    }
    let healthy = create_test_guest(state).await.expect("guest").id;
    let base = now() - 90 * 86_400_000;
    for (index, id) in poisoned.iter().enumerate() {
        sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
            .bind(base + index as i64)
            .bind(id)
            .execute(&state.pool)
            .await
            .expect("age poisoned");
    }
    sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
        .bind(base + 10_000)
        .bind(&healthy)
        .execute(&state.pool)
        .await
        .expect("age healthy");
    sqlx::query("CREATE TABLE poisoned_guest_ids (id text PRIMARY KEY)")
        .execute(&state.pool)
        .await
        .expect("poison table");
    sqlx::query("INSERT INTO poisoned_guest_ids SELECT unnest($1::text[])")
        .bind(&poisoned)
        .execute(&state.pool)
        .await
        .expect("poison ids");
    sqlx::query(
        "CREATE FUNCTION poisoned_guest() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF EXISTS (SELECT 1 FROM poisoned_guest_ids WHERE id = OLD.id) \
         THEN RAISE EXCEPTION 'poisoned guest'; END IF; RETURN OLD; END $$",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER poisoned_guest BEFORE DELETE ON users \
         FOR EACH ROW EXECUTE FUNCTION poisoned_guest()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
    let exists = |id: String| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("exists")
        }
    };

    // Tick 1 examines the poisoned first page only; tick 2 continues after it.
    assert_eq!(cleanup_tick(state).await.expect("tick 1"), Some(0));
    assert!(exists(healthy.clone()).await);
    assert_eq!(cleanup_tick(state).await.expect("tick 2"), Some(1));
    assert!(
        !exists(healthy.clone()).await,
        "healthy guest reached on tick 2"
    );

    // The scan reached the end and wrapped: a guest that failed earlier and is
    // now deletable is retried from the head on a later tick.
    sqlx::query("DELETE FROM poisoned_guest_ids WHERE id = $1")
        .bind(&poisoned[0])
        .execute(&state.pool)
        .await
        .expect("unpoison");
    let mut retried = false;
    for _ in 0..3 {
        cleanup_tick(state).await.expect("later tick");
        if !exists(poisoned[0].clone()).await {
            retried = true;
            break;
        }
    }
    assert!(
        retried,
        "the previously failing guest is retried after the wrap"
    );
}
