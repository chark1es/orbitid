//! Rollback and interleaving tests for Backend API organization/membership
//! mutations.

mod common;

use axum::http::StatusCode;
use common::{setup, Harness};
use serde_json::json;

async fn fail_webhook_events(state: &orbitid_core::AppState) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

async fn create_org(harness: &Harness, creator: &str) -> String {
    let response = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Atomic Org", "created_by": creator }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().expect("org id").to_string()
}

#[tokio::test]
async fn organization_creation_rolls_back_org_and_creator_membership() {
    let harness = setup().await;
    let user = harness
        .create_user(
            json!({ "email_address": ["org-creator@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    let user_id = user["id"].as_str().expect("user id");
    // Fail at the membership insert (after the organization insert).
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_membership() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected membership failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&harness.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_membership BEFORE INSERT ON organization_memberships \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_membership()",
    )
    .execute(&harness.state().pool)
    .await
    .expect("trigger");

    let response = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Half Org", "created_by": user_id }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let orgs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations")
        .fetch_one(&harness.state().pool)
        .await
        .expect("orgs");
    assert_eq!(orgs, 0, "the organization insert must roll back");
    let memberships: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organization_memberships")
        .fetch_one(&harness.state().pool)
        .await
        .expect("memberships");
    assert_eq!(memberships, 0);
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'organization.created'",
    )
    .fetch_one(&harness.state().pool)
    .await
    .expect("events");
    assert_eq!(events, 0);
}

#[tokio::test]
async fn membership_removal_rolls_back_when_its_event_cannot_be_written() {
    let harness = setup().await;
    let creator = harness
        .create_user(
            json!({ "email_address": ["remove-creator@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    let member = harness
        .create_user(
            json!({ "email_address": ["remove-member@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    let org_id = create_org(&harness, creator["id"].as_str().expect("creator")).await;
    let added = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member["id"], "role": "org:member" }),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.text());
    fail_webhook_events(harness.state()).await;

    let removed = harness
        .delete(&format!(
            "/v1/organizations/{org_id}/memberships/{}",
            member["id"].as_str().expect("member")
        ))
        .await;
    assert_eq!(removed.status, StatusCode::INTERNAL_SERVER_ERROR);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org_id)
    .bind(member["id"].as_str().expect("member"))
    .fetch_one(&harness.state().pool)
    .await
    .expect("memberships");
    assert_eq!(remaining, 1, "the membership must survive the rollback");
}

/// Two concurrent removals of the two remaining admins must leave one admin.
#[tokio::test]
async fn concurrent_last_admin_removals_leave_one_admin() {
    let harness = setup().await;
    let first = harness
        .create_user(
            json!({ "email_address": ["admin-a@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    let second = harness
        .create_user(
            json!({ "email_address": ["admin-b@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    let org_id = create_org(&harness, first["id"].as_str().expect("first")).await;
    let added = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": second["id"], "role": "org:admin" }),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.text());

    let left_path = format!(
        "/v1/organizations/{org_id}/memberships/{}",
        first["id"].as_str().expect("first")
    );
    let right_path = format!(
        "/v1/organizations/{org_id}/memberships/{}",
        second["id"].as_str().expect("second")
    );
    let left_harness = &harness;
    let right_harness = &harness;
    let (left, right) = tokio::join!(
        left_harness.delete(&left_path),
        right_harness.delete(&right_path),
    );
    for response in [&left, &right] {
        assert!(
            response.status == StatusCode::OK || response.status == StatusCode::FORBIDDEN,
            "unexpected status {}: {}",
            response.status,
            response.text()
        );
    }
    let admins: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1 \
         AND role_key = 'org:admin'",
    )
    .bind(&org_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("admins");
    assert_eq!(admins, 1, "at least one admin must remain");
}
