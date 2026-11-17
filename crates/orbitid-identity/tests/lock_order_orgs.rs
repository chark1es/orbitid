//! `leave_organization_on` and `delete_organization_on` follow the global lock
//! order (user rank 3, organization rank 8, memberships rank 9, grants rank 11).
//! Service level, so there is no retry layer: a deadlock would be an error and a
//! counter increment.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use orbitid_core::AppState;
use orbitid_identity::orgs::{delete_organization, leave_organization};
use orbitid_identity::testing::{
    add_test_member, create_test_organization, create_test_user, test_app_state_with,
};

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlock counter")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn leave_does_not_deadlock_with_organization_deletion_or_other_leaves() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(10)).await;
    let state = app.state().clone();
    let before = deadlocks(&state).await;
    for iteration in 0..20 {
        let admin = create_test_user(
            &state,
            &format!("lo-admin-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("admin");
        let first = create_test_user(
            &state,
            &format!("lo-a-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("member");
        let second = create_test_user(
            &state,
            &format!("lo-b-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("member");
        let org = create_test_organization(&state, "Lock Order Org", None, &admin.user.id)
            .await
            .expect("org");
        for member in [&first, &second] {
            add_test_member(&state, &org.id, &member.user.id, "org:member")
                .await
                .expect("member");
        }
        let spawn_leave = |user_id: String| {
            let state = state.clone();
            let org_id = org.id.clone();
            tokio::spawn(async move { leave_organization(&state, &org_id, &user_id).await })
        };
        let leave_first = spawn_leave(first.user.id.clone());
        let leave_second = spawn_leave(second.user.id.clone());
        let deletion = {
            let state = state.clone();
            let org_id = org.id.clone();
            tokio::spawn(async move { delete_organization(&state, &org_id).await })
        };
        for result in [leave_first.await, leave_second.await] {
            // Ok, or not a member / not found once the organization is gone.
            if let Err(error) = result.expect("join") {
                assert!(
                    error.status.is_client_error(),
                    "iteration {iteration}: {error:?}"
                );
            }
        }
        if let Err(error) = deletion.await.expect("join") {
            assert!(
                error.status.is_client_error(),
                "iteration {iteration}: {error:?}"
            );
        }
    }
    assert_eq!(deadlocks(&state).await - before, 0);
}
