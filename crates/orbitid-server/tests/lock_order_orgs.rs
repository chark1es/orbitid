//! Layer 1 proof for organization lifecycle: deleting an organization never
//! deadlocks against accepting an invitation or membership request, or against
//! a membership update/removal. The retry layer is off, so the deadlock counter
//! must stay at zero.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::error::Result as OrbitResult;
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::orgs::{
    accept_invitation_by_ticket, accept_membership_request_on, create_membership_request_on,
    create_organization_invitation, CreateInvitationInput,
};
use orbitid_identity::testing::{
    add_test_member, create_test_organization, create_test_user, test_app_state_with, TestApp,
};
use serde_json::json;

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

fn router(state: &AppState) -> axum::Router {
    orbitid_server::build_app_without_retry(state.clone())
}

fn assert_no_conflict(label: &str, response: &TestResponse) {
    assert_ne!(
        response.status,
        StatusCode::CONFLICT,
        "{label} returned 409: {}",
        response.text()
    );
    assert!(
        !response.status.is_server_error(),
        "{label} returned {}: {}",
        response.status,
        response.text()
    );
}

async fn org_row(state: &AppState, organization_id: &str) -> OrganizationRow {
    sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(organization_id)
        .fetch_one(&state.pool)
        .await
        .expect("organization")
}

async fn accept_request(
    state: &AppState,
    org: &OrganizationRow,
    request_id: &str,
) -> OrbitResult<OrganizationMembershipRow> {
    let mut tx = state.pool.begin().await?;
    let membership = accept_membership_request_on(&mut tx, state, org, request_id).await?;
    tx.commit().await?;
    Ok(membership)
}

/// Organization deletion (organization row, then cascade into invitations)
/// against accepting an invitation (organization row, then invitation).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn organization_delete_does_not_deadlock_with_accepting_an_invitation() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "invite-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("Invite Org {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let email = format!("invitee-{iteration}@example.com");
        let invitee = create_test_user(state, &email, "Sup3r-secret!")
            .await
            .expect("invitee");
        let (_invitation, ticket) = create_organization_invitation(
            state,
            &org,
            &CreateInvitationInput {
                email,
                role_key: Some("org:member".into()),
                inviter_user_id: Some(owner.user.id.clone()),
                redirect_url: None,
                public_metadata: None,
                private_metadata: None,
                expires_at: None,
            },
        )
        .await
        .expect("invitation");

        let delete = orbitid_identity::orgs::delete_organization(state, &org.id);
        let accept = accept_invitation_by_ticket(state, &ticket, &invitee.user.id);
        let (delete, accept) = tokio::join!(delete, accept);
        delete.expect("delete organization");
        // The accept may legitimately lose the race (the invitation is gone or
        // expired); what matters is that it did not deadlock.
        let _ = accept;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "organization delete vs invitation acceptance"
    );
}

/// Organization deletion against accepting a membership request (organization
/// row, then request row).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn organization_delete_does_not_deadlock_with_accepting_a_request() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "request-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("Request Org {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let member = create_test_user(
            state,
            &format!("requester-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("member");
        let org_row = org_row(state, &org.id).await;
        let request = {
            let mut tx = state.pool.begin().await.expect("begin");
            let row =
                create_membership_request_on(&mut tx, state, &org_row, &member.user.id, "pending")
                    .await
                    .expect("request");
            tx.commit().await.expect("commit");
            row
        };

        let delete = orbitid_identity::orgs::delete_organization(state, &org.id);
        let accept = accept_request(state, &org_row, &request.id);
        let (delete, accept) = tokio::join!(delete, accept);
        delete.expect("delete organization");
        let _ = accept;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "organization delete vs membership request acceptance"
    );
}

/// BAPI membership update/removal (organization row, then memberships) against
/// organization deletion (organization row, then memberships).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn membership_changes_do_not_deadlock_with_organization_delete() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "membership-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let backend = TestClient::new(router(state));
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("Membership Org {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let first = create_test_user(
            state,
            &format!("member-first-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("first member");
        let second = create_test_user(
            state,
            &format!("member-second-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("second member");
        add_test_member(state, &org.id, &first.user.id, "org:member")
            .await
            .expect("first membership");
        add_test_member(state, &org.id, &second.user.id, "org:member")
            .await
            .expect("second membership");

        let delete_path = format!("/v1/organizations/{}", org.id);
        let member_path = format!("/v1/organizations/{}/memberships/{}", org.id, first.user.id);
        let role_path = format!(
            "/v1/organizations/{}/memberships/{}",
            org.id, second.user.id
        );
        if iteration % 2 == 0 {
            let (removed, deleted) = tokio::join!(
                backend.delete(&member_path, None, bearer()),
                backend.delete(&delete_path, None, bearer()),
            );
            assert_no_conflict("membership removal", &removed);
            assert_no_conflict("organization deletion", &deleted);
        } else {
            let (updated, deleted) = tokio::join!(
                backend.patch(&role_path, Some(json!({ "role": "org:admin" })), bearer()),
                backend.delete(&delete_path, None, bearer()),
            );
            assert_no_conflict("membership update", &updated);
            assert_no_conflict("organization deletion", &deleted);
        }
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "membership update/remove vs organization delete"
    );
}
