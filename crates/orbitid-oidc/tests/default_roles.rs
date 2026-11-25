//! The instance default role reaches OIDC `groups` (ID token and userinfo)
//! exactly like an assigned role, and an explicit assignment replaces it.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{code_flow, decode_claims, harness, insert_user, settings, Harness};

async fn create_role(h: &Harness, key: &str) {
    let mut tx = h.state().pool.begin().await.expect("tx");
    orbitid_identity::rbac::create_role_on(
        &mut tx,
        h.state(),
        &orbitid_identity::rbac::CreateRoleInput {
            key: key.into(),
            name: key.into(),
            description: None,
            is_creator_eligible: false,
            permission_keys: Vec::new(),
        },
    )
    .await
    .expect("role");
    tx.commit().await.expect("commit");
}

async fn userinfo_groups(h: &Harness, access_token: &str) -> Value {
    let response = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access_token}"))],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["groups"].clone()
}

#[tokio::test]
async fn groups_carry_the_effective_instance_roles() {
    let h = harness().await;
    create_role(&h, "app:member").await;
    create_role(&h, "app:support").await;
    settings(&h, json!({ "roles": { "defaultRole": "app:member" } })).await;
    let browser = insert_user(&h, "groups-default@example.com").await;
    let app = h.create_app(json!({ "groups_claim": "roles" })).await;

    let flow = code_flow(&h, &browser, &app, "openid groups").await;
    let id_token = decode_claims(flow.tokens["id_token"].as_str().unwrap());
    assert_eq!(id_token["groups"], json!(["app:member"]));
    let access = flow.tokens["access_token"].as_str().unwrap().to_string();
    assert_eq!(userinfo_groups(&h, &access).await, json!(["app:member"]));

    orbitid_identity::user_roles::set_user_roles(
        h.state(),
        &browser.user.id,
        &["app:support".to_string()],
    )
    .await
    .expect("assign");
    assert_eq!(userinfo_groups(&h, &access).await, json!(["app:support"]));
}
