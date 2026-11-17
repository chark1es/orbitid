//! Ported from the retired TypeScript test suite (event payloads
//! emitted by Backend API mutations; delivery is covered by `admin_webhooks`).

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{setup, Harness};

async fn create_user(harness: &Harness) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [format!("event-user-{n}@example.com")], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

async fn events(harness: &Harness, event_type: &str) -> Vec<Value> {
    let payloads: Vec<Value> = sqlx::query_scalar(
        "SELECT payload FROM webhook_events WHERE type = $1 ORDER BY created_at ASC, id ASC",
    )
    .bind(event_type)
    .fetch_all(&harness.state().pool)
    .await
    .expect("events");
    payloads
        .into_iter()
        .map(|payload| payload.get("data").cloned().unwrap_or(Value::Null))
        .collect()
}

#[tokio::test]
async fn emits_organization_and_membership_events() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Acme", "created_by": owner }),
        )
        .await
        .value();
    let org_id = org["id"].as_str().unwrap().to_string();

    let created = events(&harness, "organization.created").await;
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["id"], json!(org_id));
    assert!(created[0].get("private_metadata").is_some());

    let memberships = events(&harness, "organizationMembership.created").await;
    assert_eq!(memberships.len(), 1);
    assert_eq!(memberships[0]["role"], json!("org:admin"));
    assert_eq!(memberships[0]["organization"]["id"], json!(org_id));

    harness
        .patch(
            &format!("/v1/organizations/{org_id}"),
            json!({ "name": "Acme Renamed" }),
        )
        .await;
    let updated = events(&harness, "organization.updated").await;
    assert_eq!(
        updated.last().and_then(|event| event["name"].as_str()),
        Some("Acme Renamed")
    );

    harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member, "role": "org:member" }),
        )
        .await;
    harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{member}"),
            json!({ "role": "org:admin" }),
        )
        .await;
    assert_eq!(
        events(&harness, "organizationMembership.updated")
            .await
            .last()
            .and_then(|event| event["role"].as_str()),
        Some("org:admin")
    );
    harness
        .delete(&format!("/v1/organizations/{org_id}/memberships/{member}"))
        .await;
    assert_eq!(
        events(&harness, "organizationMembership.deleted")
            .await
            .len(),
        1
    );

    harness.delete(&format!("/v1/organizations/{org_id}")).await;
    assert_eq!(events(&harness, "organization.deleted").await.len(), 1);
}

#[tokio::test]
async fn emits_invitation_domain_role_and_permission_events() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let org = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Acme", "created_by": owner }),
        )
        .await
        .value();
    let org_id = org["id"].as_str().unwrap().to_string();

    let invitation = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations"),
            json!({ "email_address": "pending@acme.test", "notify": false }),
        )
        .await
        .value();
    assert_eq!(
        events(&harness, "organizationInvitation.created")
            .await
            .len(),
        1
    );
    harness
        .post_empty(&format!(
            "/v1/organizations/{org_id}/invitations/{}/revoke",
            invitation["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(
        events(&harness, "organizationInvitation.revoked")
            .await
            .len(),
        1
    );

    let domain = harness
        .post(
            &format!("/v1/organizations/{org_id}/domains"),
            json!({ "name": "acme.test" }),
        )
        .await
        .value();
    assert_eq!(
        events(&harness, "organizationDomain.created").await.len(),
        1
    );
    harness
        .patch(
            &format!(
                "/v1/organizations/{org_id}/domains/{}",
                domain["id"].as_str().unwrap()
            ),
            json!({ "enrollment_mode": "manual_invitation" }),
        )
        .await;
    assert_eq!(
        events(&harness, "organizationDomain.updated").await.len(),
        1
    );
    harness
        .delete(&format!(
            "/v1/organizations/{org_id}/domains/{}",
            domain["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(
        events(&harness, "organizationDomain.deleted").await.len(),
        1
    );

    let role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:support", "name": "Support", "permissions": ["org:sys_memberships:read"] }),
        )
        .await
        .value();
    let role_id = role["id"].as_str().unwrap().to_string();
    harness
        .patch(
            &format!("/v1/roles/{role_id}"),
            json!({ "name": "Support Team" }),
        )
        .await;
    harness.delete(&format!("/v1/roles/{role_id}")).await;
    assert_eq!(events(&harness, "role.created").await.len(), 1);
    assert_eq!(events(&harness, "role.updated").await.len(), 1);
    assert_eq!(events(&harness, "role.deleted").await.len(), 1);

    let permission = harness
        .post(
            "/v1/permissions",
            json!({ "key": "org:invoices:manage", "name": "Manage invoices" }),
        )
        .await
        .value();
    let permission_id = permission["id"].as_str().unwrap().to_string();
    harness
        .patch(
            &format!("/v1/permissions/{permission_id}"),
            json!({ "name": "Manage billing" }),
        )
        .await;
    harness
        .delete(&format!("/v1/permissions/{permission_id}"))
        .await;
    assert_eq!(events(&harness, "permission.created").await.len(), 1);
    assert_eq!(events(&harness, "permission.updated").await.len(), 1);
    assert_eq!(events(&harness, "permission.deleted").await.len(), 1);
}
