//! The session-expiry drain decides "more to do" from the candidate page, not
//! from how many rows it managed to expire.

use orbitid_core::testing::test_pool_exemption;
use orbitid_identity::retention::expire_stale_sessions;
use orbitid_identity::testing::{
    create_test_client_session, create_test_user, test_app_state_with,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_candidate_that_changes_under_the_lock_does_not_end_the_drain() {
    // The test holds one transaction while the drain runs on another connection.
    let app = test_app_state_with(test_pool_exemption(4)).await;
    let state = app.state();
    let user = create_test_user(state, "expiry-page@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let mut ids = Vec::new();
    for _ in 0..3 {
        let session = create_test_client_session(state, &user.user.id)
            .await
            .expect("session");
        ids.push(session.session.id.clone());
    }
    // The drain pages in Postgres's `ORDER BY id`; the database collation can
    // differ from Rust's byte order for random ids, so take the order from it.
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM sessions WHERE id = ANY($1) ORDER BY id")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await
            .expect("ordered ids");
    let at = orbitid_core::http::now();

    // A concurrent change ends the lowest-id candidate, uncommitted: the drain's
    // candidate read still sees it, its locking read waits and then finds it no
    // longer matches. With batch 2 the first page is [first, second] but only
    // one row is expired; the drain must still reach the third.
    sqlx::query("UPDATE sessions SET expire_at = $1 WHERE id = ANY($2)")
        .bind(orbitid_core::http::now() - 1_000)
        .bind(&ids)
        .execute(&state.pool)
        .await
        .expect("past the deadline");
    let mut holder = state.pool.begin().await.expect("begin");
    sqlx::query("UPDATE sessions SET status = 'ended' WHERE id = $1")
        .bind(&ids[0])
        .execute(&mut *holder)
        .await
        .expect("hold the first candidate");
    let drain = {
        let state = state.clone();
        tokio::spawn(async move { expire_stale_sessions(&state, at, 2).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    holder.commit().await.expect("commit");
    let expired = drain.await.expect("join").expect("drain");

    assert_eq!(expired, 2, "the second and the third session are expired");
    let statuses: Vec<String> =
        sqlx::query_scalar("SELECT status FROM sessions WHERE id = ANY($1) ORDER BY id")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await
            .expect("statuses");
    assert_eq!(statuses, vec!["ended", "expired", "expired"]);
}
