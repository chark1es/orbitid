//! A retained row whose delete keeps failing must not stop the drain at the
//! same head every tick: rows behind it are still deleted (savepoint
//! isolation), and with a zero budget the durable cursor moves on.

use orbitid_core::config::EnvOverrides;
use orbitid_identity::retention::sweep_once;
use orbitid_identity::testing::test_app_state_with;

#[tokio::test]
async fn permanently_failing_rows_do_not_block_the_rows_behind_them() {
    let app = test_app_state_with(EnvOverrides {
        retention_budget_ms: Some(0),
        ..Default::default()
    })
    .await;
    let state = app.state();
    for index in 0..6 {
        sqlx::query(
            "INSERT INTO oauth_states (state, provider, flow, expires_at) \
             VALUES ($1, 'x', '{}'::jsonb, $2)",
        )
        .bind(format!("state-{index}"))
        .bind(1_000 + index as i64)
        .execute(&state.pool)
        .await
        .expect("insert");
    }
    sqlx::query(
        "CREATE FUNCTION poisoned_state() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF OLD.state IN ('state-0', 'state-1', 'state-2') \
         THEN RAISE EXCEPTION 'poisoned'; END IF; RETURN OLD; END $$",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER poisoned_state BEFORE DELETE ON oauth_states \
         FOR EACH ROW EXECUTE FUNCTION poisoned_state()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
    // Batch of 3: the first page is entirely poisoned.
    let first = sweep_once(state, None, Some(3)).await.expect("sweep");
    assert_eq!(first.oauth_states, 0);
    let second = sweep_once(state, None, Some(3)).await.expect("sweep");
    assert_eq!(
        second.oauth_states, 3,
        "the next tick continues behind the failing page"
    );
    let left: Vec<String> = sqlx::query_scalar("SELECT state FROM oauth_states ORDER BY state")
        .fetch_all(&state.pool)
        .await
        .expect("left");
    assert_eq!(left, vec!["state-0", "state-1", "state-2"]);
}
