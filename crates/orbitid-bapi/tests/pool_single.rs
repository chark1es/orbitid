//! Regression test for "a handler opened a transaction and then asked the pool
//! for a second connection": every main admin flow below runs on a state whose
//! pool holds exactly one connection, so any nested pool acquisition would time
//! out and fail the request.

mod common;

use axum::http::StatusCode;
use common::{build_app, Harness};
use orbitid_core::config::EnvOverrides;
use orbitid_core::testing::TestClient;
use orbitid_identity::testing::{test_app_state_with, TestApp};
use serde_json::{json, Value};

async fn one_connection_state() -> TestApp {
    test_app_state_with(EnvOverrides {
        db_max_connections: Some(1),
        db_acquire_timeout_ms: Some(5_000),
        allow_private_networks: Some(true),
        ..Default::default()
    })
    .await
}

fn harness(app: TestApp) -> Harness {
    let client = TestClient::new(build_app(app.state()));
    Harness { app, client }
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().expect("id").to_string()
}

/// Every step must succeed with `max_connections = 1`; a handler that took a
/// second connection inside its transaction would return a 500 (acquire
/// timeout) instead.
#[tokio::test]
async fn main_admin_flows_run_on_a_one_connection_pool() {
    let harness = harness(one_connection_state().await);

    // create user
    let created = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["pool@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let user_id = id_of(&created.value());

    // ban (user update + every credential revocation + event)
    let banned = harness
        .post_empty(&format!("/v1/users/{user_id}/ban"))
        .await;
    assert_eq!(banned.status, StatusCode::OK, "{}", banned.text());
    assert_eq!(banned.value()["banned"], json!(true));
    let unbanned = harness
        .post_empty(&format!("/v1/users/{user_id}/unban"))
        .await;
    assert_eq!(unbanned.status, StatusCode::OK, "{}", unbanned.text());

    // create organization + creator membership (one transaction)
    let org = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Pool Org", "created_by": user_id }),
        )
        .await;
    assert_eq!(org.status, StatusCode::OK, "{}", org.text());
    let org_id = id_of(&org.value());

    // add a second member
    let member = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["pool-member@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(member.status, StatusCode::OK, "{}", member.text());
    let member_id = id_of(&member.value());
    let membership = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member_id, "role": "org:member" }),
        )
        .await;
    assert_eq!(membership.status, StatusCode::OK, "{}", membership.text());

    // membership role change + metadata (last-admin check and serializers on
    // the transaction's connection)
    let promoted = harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{member_id}"),
            json!({ "role": "org:admin" }),
        )
        .await;
    assert_eq!(promoted.status, StatusCode::OK, "{}", promoted.text());
    let metadata = harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{member_id}/metadata"),
            json!({ "public_metadata": { "seat": 1 } }),
        )
        .await;
    assert_eq!(metadata.status, StatusCode::OK, "{}", metadata.text());

    // instance role assignment
    let app_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:pool", "name": "Pool app role" }),
        )
        .await;
    assert_eq!(app_role.status, StatusCode::OK, "{}", app_role.text());
    let roles = harness
        .put(
            &format!("/v1/users/{member_id}/roles"),
            json!({ "roles": ["app:pool"] }),
        )
        .await;
    assert_eq!(roles.status, StatusCode::OK, "{}", roles.text());

    // instance invitation
    let invitation = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "pool-invitee@example.com", "notify": false }),
        )
        .await;
    assert_eq!(invitation.status, StatusCode::OK, "{}", invitation.text());

    // custom role
    let role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:pool_role", "name": "Pool role" }),
        )
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());

    // webhook endpoint
    let endpoint = harness
        .post(
            "/v1/webhooks/endpoints",
            json!({ "url": "http://127.0.0.1:9/hook" }),
        )
        .await;
    assert_eq!(endpoint.status, StatusCode::OK, "{}", endpoint.text());

    // delete user (deletion + organization lifecycle + event)
    let deleted = harness.delete(&format!("/v1/users/{user_id}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
}
