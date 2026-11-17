//! Permission deletion versus role-permission replacement: parent before child.
//! The replacer key-shares every referenced permission before it deletes or
//! inserts a `role_permissions` row; the deleter locks the permission first and
//! its cascade then needs those child rows. Retry layer off (service level).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use orbitid_core::AppState;
use orbitid_identity::rbac::set_role_permissions_on;
use orbitid_identity::rbac::{
    create_permission_on, create_role_on, delete_permission_on, CreatePermissionInput,
    CreateRoleInput,
};
use orbitid_identity::testing::test_app_state_with;

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlock counter")
}

async fn wait_for_lock_waiter(state: &AppState) {
    for _ in 0..400 {
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
    panic!("the replacement never blocked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn permission_deletion_and_role_permission_replacement_do_not_deadlock() {
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(6)).await;
    let state = app.state().clone();
    let mut seed = state.pool.acquire().await.expect("connection");
    let permission = create_permission_on(
        &mut seed,
        &CreatePermissionInput {
            key: "org:lock_perm".into(),
            name: "Lock perm".into(),
            description: None,
        },
    )
    .await
    .expect("permission");
    let role = create_role_on(
        &mut seed,
        &state,
        &CreateRoleInput {
            key: "org:lock_role".into(),
            name: "Lock role".into(),
            description: None,
            is_creator_eligible: false,
            permission_keys: vec!["org:lock_perm".into()],
        },
    )
    .await
    .expect("role");
    drop(seed);
    let before = deadlocks(&state).await;

    // The deletion already holds the permission row …
    let mut deletion = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM permissions WHERE id = $1 FOR UPDATE")
        .bind(&permission.id)
        .execute(&mut *deletion)
        .await
        .expect("hold the permission");
    // … when a replacement of the role's permission set (same permission) starts.
    let replacement = {
        let state = state.clone();
        let role = role.clone();
        tokio::spawn(async move {
            let mut tx = state.pool.begin().await.expect("begin");
            let result =
                set_role_permissions_on(&mut tx, &state, &role, &["org:lock_perm".to_string()])
                    .await;
            match result {
                Ok(()) => tx.commit().await.map(|_| ()).map_err(|e| e.to_string()),
                Err(error) => Err(error.code),
            }
        })
    };
    wait_for_lock_waiter(&state).await;
    // The cascade needs the role-permission row: the waiting replacement must
    // not hold it.
    tokio::time::timeout(
        Duration::from_secs(10),
        delete_permission_on(&mut deletion, &permission),
    )
    .await
    .expect("the role_permissions row is not locked by the waiting replacement")
    .expect("delete the permission");
    deletion.commit().await.expect("commit");
    // The replacement fails (the permission is gone) or succeeds; it must end.
    let _ = replacement.await.expect("join");
    assert_eq!(deadlocks(&state).await - before, 0);
}
