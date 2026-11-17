//! Ported from the retired TypeScript test suite (Backend API parts).

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

async fn create_user(harness: &Harness) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [format!("role-user-{n}@example.com")], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

fn keys(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["key"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn creates_organization_and_instance_roles_and_reports_scope() {
    let harness = setup().await;
    let org_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:billing", "name": "Billing" }),
        )
        .await;
    assert_eq!(org_role.status, StatusCode::OK, "{}", org_role.text());
    assert_eq!(org_role.value()["scope"], json!("organization"));
    assert_eq!(org_role.value()["is_system"], json!(false));

    let instance_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support" }),
        )
        .await;
    assert_eq!(
        instance_role.status,
        StatusCode::OK,
        "{}",
        instance_role.text()
    );
    assert_eq!(instance_role.value()["scope"], json!("instance"));

    let listed = harness.get("/v1/roles?limit=100").await;
    let pairs: Vec<(String, String)> = listed.value()["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|role| {
            (
                role["key"].as_str().unwrap_or_default().to_string(),
                role["scope"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    assert!(pairs.contains(&("org:billing".into(), "organization".into())));
    assert!(pairs.contains(&("app:support".into(), "instance".into())));
}

#[tokio::test]
async fn accepts_dashboard_key_shapes_and_multi_segment_keys() {
    let harness = setup().await;
    for key in [
        "org:team-lead",
        "app:support-2",
        "org:support_2",
        "org:billing",
        "app:a1",
    ] {
        let response = harness
            .post("/v1/roles", json!({ "key": key, "name": key }))
            .await;
        assert_eq!(
            response.status,
            StatusCode::OK,
            "{key}: {}",
            response.text()
        );
        assert_eq!(response.value()["key"], json!(key));
    }
    assert_eq!(
        harness
            .post(
                "/v1/roles",
                json!({ "key": "org:billing:read", "name": "Billing reader" })
            )
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        harness
            .post(
                "/v1/permissions",
                json!({ "key": "org:team-lead:view", "name": "View team" })
            )
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn refuses_reserved_keys_system_keys_and_creator_eligible_instance_roles() {
    let harness = setup().await;
    for key in [
        "support",
        "org:sys_x",
        "app:sys_x",
        "org:",
        "APP:BAD",
        "org:space name",
        "org:Support",
        "org:x::y",
        "org:-leading",
    ] {
        assert_eq!(
            harness
                .post("/v1/roles", json!({ "key": key, "name": "X" }))
                .await
                .status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{key}"
        );
    }

    let instance_creator = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support", "is_creator_eligible": true }),
        )
        .await;
    assert_eq!(instance_creator.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&instance_creator).as_deref(),
        Some("form_param_value_invalid")
    );
    let created: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE key = 'app:support'")
        .fetch_one(&harness.state().pool)
        .await
        .expect("count");
    assert_eq!(created, 0);

    let owner = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:owner", "name": "Owner", "is_creator_eligible": true }),
        )
        .await;
    assert_eq!(owner.status, StatusCode::OK, "{}", owner.text());
    assert_eq!(
        harness
            .patch(
                &format!("/v1/roles/{}", owner.value()["id"].as_str().unwrap()),
                json!({ "is_creator_eligible": true }),
            )
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn rejects_scope_mixing_before_writing_anything() {
    let harness = setup().await;
    assert_eq!(
        harness
            .post(
                "/v1/permissions",
                json!({ "key": "app:reports:read", "name": "Read reports" })
            )
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        harness
            .post(
                "/v1/permissions",
                json!({ "key": "org:notes:read", "name": "Read notes" })
            )
            .await
            .status,
        StatusCode::OK
    );

    let mixed = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:billing", "name": "Billing", "permissions": ["app:reports:read"] }),
        )
        .await;
    assert_eq!(mixed.status, StatusCode::UNPROCESSABLE_ENTITY);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM roles WHERE key = 'org:billing'")
        .fetch_one(&harness.state().pool)
        .await
        .expect("count");
    assert_eq!(rows, 0);

    let role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:viewer", "name": "Viewer", "permissions": ["org:notes:read"] }),
        )
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());
    let role_id = role.value()["id"].as_str().unwrap().to_string();
    let mixed_patch = harness
        .patch(
            &format!("/v1/roles/{role_id}"),
            json!({ "name": "Renamed", "permissions": ["app:reports:read"] }),
        )
        .await;
    assert_eq!(mixed_patch.status, StatusCode::UNPROCESSABLE_ENTITY);
    let after = harness.get(&format!("/v1/roles/{role_id}")).await;
    assert_eq!(after.value()["name"], json!("Viewer"));
    assert_eq!(keys(&after.value()["permissions"]), vec!["org:notes:read"]);

    let org_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:billing", "name": "Billing" }),
        )
        .await;
    let mixed_permissions = harness
        .post(
            &format!(
                "/v1/roles/{}/permissions",
                org_role.value()["id"].as_str().unwrap()
            ),
            json!({ "permissions": ["app:reports:read"] }),
        )
        .await;
    assert_eq!(mixed_permissions.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&mixed_permissions).as_deref(),
        Some("form_param_value_invalid")
    );
    let good = harness
        .post(
            &format!(
                "/v1/roles/{}/permissions",
                org_role.value()["id"].as_str().unwrap()
            ),
            json!({ "permissions": ["org:sys_memberships:read"] }),
        )
        .await;
    assert_eq!(
        keys(&good.value()["permissions"]),
        vec!["org:sys_memberships:read"]
    );
}

#[tokio::test]
async fn assigns_instances_roles_only_through_the_operator_route_and_only_app_roles() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    let role = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support" }),
        )
        .await;
    let permission = harness
        .post(
            "/v1/permissions",
            json!({ "key": "app:reports:read", "name": "Read reports" }),
        )
        .await;
    harness
        .post(
            &format!(
                "/v1/roles/{}/permissions",
                role.value()["id"].as_str().unwrap()
            ),
            json!({ "permissions": [permission.value()["key"]] }),
        )
        .await;

    let assigned = harness
        .put(
            &format!("/v1/users/{user}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    assert_eq!(assigned.status, StatusCode::OK, "{}", assigned.text());
    assert_eq!(assigned.value()["roles"], json!(["app:support"]));
    assert_eq!(
        assigned.value()["role_permissions"],
        json!(["app:reports:read"])
    );

    harness
        .post(
            "/v1/roles",
            json!({ "key": "org:billing", "name": "Billing" }),
        )
        .await;
    for roles in [
        json!(["org:billing"]),
        json!(["app:missing"]),
        json!(["org:admin"]),
        json!(["app:support", "org:billing"]),
    ] {
        let response = harness
            .put(
                &format!("/v1/users/{user}/roles"),
                json!({ "roles": roles }),
            )
            .await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{roles}: {}",
            response.text()
        );
    }
    let read = harness.get(&format!("/v1/users/{user}/roles")).await;
    assert_eq!(read.value()["roles"], json!(["app:support"]));

    let cleared = harness
        .put(&format!("/v1/users/{user}/roles"), json!({ "roles": [] }))
        .await;
    assert_eq!(cleared.value()["roles"], json!([]));
}

#[tokio::test]
async fn user_json_and_session_claims_show_instance_roles_only() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support" }),
        )
        .await;
    harness
        .put(
            &format!("/v1/users/{user}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    let read = harness.get(&format!("/v1/users/{user}")).await;
    assert_eq!(read.value()["roles"], json!(["app:support"]));
    assert_eq!(read.value()["role_permissions"], json!([]));

    let session = harness.create_session(&user).await;
    let jwt = orbitid_identity::tokens::sign_session_token(
        harness.state(),
        &session.session_id,
        orbitid_identity::tokens::SignSessionTokenOptions {
            template: None,
            azp: None,
        },
    )
    .await
    .expect("sign");
    let claims = orbitid_identity::tokens::verify_session_token(harness.state(), &jwt, None)
        .await
        .expect("verify");
    let value = serde_json::to_value(&claims).expect("claims");
    assert_eq!(value["roles"], json!(["app:support"]));
    assert!(value.get("org_role").is_none() || value["org_role"].is_null());
    assert_eq!(value["role_permissions"], json!([]));

    harness
        .put(&format!("/v1/users/{user}/roles"), json!({ "roles": [] }))
        .await;
    let still: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(still, "active");
}

#[tokio::test]
async fn refuses_instance_roles_on_memberships_and_invitations() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support" }),
        )
        .await;
    let org = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Acme", "created_by": owner }),
        )
        .await
        .value();
    let org_id = org["id"].as_str().unwrap();

    let add = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member, "role": "app:support" }),
        )
        .await;
    assert_eq!(add.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&add).as_deref(),
        Some("form_param_value_invalid")
    );
    assert_eq!(
        harness
            .post(
                &format!("/v1/organizations/{org_id}/invitations"),
                json!({ "email_address": "invitee@acme.test", "role": "app:support" }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn refuses_to_delete_a_role_that_is_assigned_or_pending() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    let owner = create_user(&harness).await;
    let assigned_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "app:support", "name": "Support" }),
        )
        .await
        .value();
    harness
        .put(
            &format!("/v1/users/{user}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    assert_eq!(
        harness
            .delete(&format!(
                "/v1/roles/{}",
                assigned_role["id"].as_str().unwrap()
            ))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    harness
        .put(&format!("/v1/users/{user}/roles"), json!({ "roles": [] }))
        .await;
    assert_eq!(
        harness
            .delete(&format!(
                "/v1/roles/{}",
                assigned_role["id"].as_str().unwrap()
            ))
            .await
            .status,
        StatusCode::OK
    );

    let org = harness
        .post(
            "/v1/organizations",
            json!({ "name": "Acme", "created_by": owner }),
        )
        .await
        .value();
    let pending_role = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:viewer", "name": "Viewer" }),
        )
        .await
        .value();
    assert_eq!(
        harness
            .post(
                &format!(
                    "/v1/organizations/{}/invitations",
                    org["id"].as_str().unwrap()
                ),
                json!({ "email_address": "invitee@acme.test", "role": "org:viewer" }),
            )
            .await
            .status,
        StatusCode::OK
    );
    let deleted = harness
        .delete(&format!(
            "/v1/roles/{}",
            pending_role["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(deleted.status, StatusCode::FORBIDDEN);
    assert!(deleted
        .text()
        .to_ascii_lowercase()
        .contains("pending invitation"));
}

#[tokio::test]
async fn refuses_every_system_role_permission_mutation() {
    let harness = setup().await;
    let roles = harness.get("/v1/roles?limit=100").await.value();
    let admin = roles["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|role| role["key"] == json!("org:admin"))
        .unwrap()
        .clone();
    let admin_id = admin["id"].as_str().unwrap().to_string();
    let before_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM role_permissions WHERE role_id = $1")
            .bind(&admin_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("count");
    let permission_id = admin["permissions"][0]["id"].as_str().unwrap().to_string();

    let replaced = harness
        .post(
            &format!("/v1/roles/{admin_id}/permissions"),
            json!({ "permissions": [] }),
        )
        .await;
    assert_eq!(replaced.status, StatusCode::FORBIDDEN);
    let removed = harness
        .delete(&format!("/v1/roles/{admin_id}/permissions/{permission_id}"))
        .await;
    assert_eq!(removed.status, StatusCode::FORBIDDEN);
    let after_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM role_permissions WHERE role_id = $1")
            .bind(&admin_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("count");
    assert_eq!(after_rows, before_rows);
}
