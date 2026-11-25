//! The instance default role (`roles.defaultRole`): inherited at read time by
//! every non-guest user without an explicit assignment, overridden by any
//! explicit assignment (even an empty one), and consistent across every reader.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

async fn create_role(harness: &Harness, key: &str, permissions: &[&str]) -> Value {
    for permission in permissions {
        let created = harness
            .post(
                "/v1/permissions",
                json!({ "key": permission, "name": permission }),
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    }
    let response = harness
        .post(
            "/v1/roles",
            json!({ "key": key, "name": key, "permissions": permissions }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn set_default(harness: &Harness, key: Value) -> orbitid_core::testing::TestResponse {
    harness
        .patch("/v1/instance", json!({ "roles": { "defaultRole": key } }))
        .await
}

async fn create_user(harness: &Harness, email: &str) -> String {
    harness
        .create_user(
            json!({ "email_address": [email], "password": "correct horse battery staple" }),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn roles_of(harness: &Harness, user: &str) -> Value {
    let response = harness.get(&format!("/v1/users/{user}/roles")).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn session_claims(harness: &Harness, user: &str, template: Option<&str>) -> Value {
    let session = harness.create_session(user).await;
    let jwt = orbitid_identity::tokens::sign_session_token(
        harness.state(),
        &session.session_id,
        orbitid_identity::tokens::SignSessionTokenOptions {
            template: template.map(str::to_string),
            azp: None,
        },
    )
    .await
    .expect("sign");
    orbitid_credentials::jwt::decode_jwt_payload(&jwt).expect("payload")
}

#[tokio::test]
async fn default_role_applies_to_users_without_an_assignment_everywhere() {
    let harness = setup().await;
    create_role(&harness, "app:member", &["app:reports:read"]).await;
    let user = create_user(&harness, "inherits@example.com").await;

    // No default configured: nothing, sourced from the (empty) default.
    let before = roles_of(&harness, &user).await;
    assert_eq!(before["roles"], json!([]));
    assert_eq!(before["source"], "default");
    assert!(before["default_role"].is_null());

    let saved = set_default(&harness, json!("app:member")).await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text());
    assert_eq!(saved.value()["roles"]["defaultRole"], "app:member");

    // The change applies to an existing user immediately, without rows.
    let after = roles_of(&harness, &user).await;
    assert_eq!(after["roles"], json!(["app:member"]));
    assert_eq!(after["role_permissions"], json!(["app:reports:read"]));
    assert_eq!(after["source"], "default");
    assert_eq!(after["default_role"], "app:member");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE user_id = $1")
        .bind(&user)
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    assert_eq!(
        rows, 0,
        "the default is resolved at read time, never backfilled"
    );

    // UserJSON (single and list), session token and JWT template agree.
    let single = harness.get(&format!("/v1/users/{user}")).await.value();
    assert_eq!(single["roles"], json!(["app:member"]));
    assert_eq!(single["role_permissions"], json!(["app:reports:read"]));
    let list = harness.get("/v1/users?limit=10").await.value();
    // `GET /v1/users` answers a bare array (Clerk shape) or `{ data }`.
    let listed = list
        .as_array()
        .or_else(|| list["data"].as_array())
        .expect("user list")
        .iter()
        .find(|item| item["id"] == user.as_str())
        .unwrap()
        .clone();
    assert_eq!(listed["roles"], json!(["app:member"]));

    let claims = session_claims(&harness, &user, None).await;
    assert_eq!(claims["roles"], json!(["app:member"]));
    assert_eq!(claims["role_permissions"], json!(["app:reports:read"]));

    let template = harness
        .post(
            "/v1/jwt_templates",
            json!({ "name": "api", "claims": { "uid": "{{user.id}}" } }),
        )
        .await;
    assert_eq!(template.status, StatusCode::OK, "{}", template.text());
    let templated = session_claims(&harness, &user, Some("api")).await;
    assert_eq!(templated["roles"], json!(["app:member"]));
    assert_eq!(templated["role_permissions"], json!(["app:reports:read"]));
    assert_eq!(templated["uid"], json!(user));

    // A default change propagates to every inheriting user at once.
    create_role(&harness, "app:viewer", &[]).await;
    assert_eq!(
        set_default(&harness, json!("app:viewer")).await.status,
        StatusCode::OK
    );
    assert_eq!(
        roles_of(&harness, &user).await["roles"],
        json!(["app:viewer"])
    );
    assert_eq!(
        session_claims(&harness, &user, None).await["roles"],
        json!(["app:viewer"])
    );

    // Clearing it restores the pre-feature behaviour.
    assert_eq!(
        set_default(&harness, Value::Null).await.status,
        StatusCode::OK
    );
    assert_eq!(roles_of(&harness, &user).await["roles"], json!([]));
}

#[tokio::test]
async fn explicit_assignments_win_and_reset_returns_to_the_default() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    create_role(&harness, "app:support", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let assigned = create_user(&harness, "assigned@example.com").await;
    let cleared = create_user(&harness, "cleared@example.com").await;

    // An explicit assignment replaces the default rather than adding to it.
    let put = harness
        .put(
            &format!("/v1/users/{assigned}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    assert_eq!(put.status, StatusCode::OK, "{}", put.text());
    assert_eq!(put.value()["roles"], json!(["app:support"]));
    assert_eq!(put.value()["source"], "assigned");

    // An explicit empty set means "no instance roles", not "use the default".
    let empty = harness
        .put(
            &format!("/v1/users/{cleared}/roles"),
            json!({ "roles": [] }),
        )
        .await;
    assert_eq!(empty.status, StatusCode::OK, "{}", empty.text());
    assert_eq!(empty.value()["roles"], json!([]));
    assert_eq!(empty.value()["source"], "assigned");
    assert_eq!(
        session_claims(&harness, &cleared, None).await["roles"],
        json!([])
    );

    // A default change does not touch either of them.
    create_role(&harness, "app:viewer", &[]).await;
    set_default(&harness, json!("app:viewer")).await;
    assert_eq!(
        roles_of(&harness, &assigned).await["roles"],
        json!(["app:support"])
    );
    assert_eq!(roles_of(&harness, &cleared).await["roles"], json!([]));

    // DELETE drops the assignment; the user inherits the default again.
    let reset = harness.delete(&format!("/v1/users/{cleared}/roles")).await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    assert_eq!(reset.value()["roles"], json!(["app:viewer"]));
    assert_eq!(reset.value()["source"], "default");
    let reset = harness.delete(&format!("/v1/users/{assigned}/roles")).await;
    assert_eq!(reset.value()["roles"], json!(["app:viewer"]));
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE user_id = $1")
        .bind(&assigned)
        .fetch_one(&harness.state().pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events WHERE type = 'user.updated' \
         AND strpos(payload::text, $1) > 0",
    )
    .bind(&assigned)
    .fetch_one(&harness.state().pool)
    .await
    .unwrap();
    assert!(events >= 1, "reset emits user.updated");

    // Unknown users are a 404, not a silent no-op.
    let missing = harness.delete("/v1/users/user_missing/roles").await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn guests_do_not_inherit_the_default_role() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let guest = orbitid_identity::testing::create_test_guest(harness.state())
        .await
        .expect("guest");
    let guest_id = guest.id.clone();
    let roles = roles_of(&harness, &guest_id).await;
    assert_eq!(roles["roles"], json!([]));
    assert_eq!(roles["source"], "default");
    // Once the guest becomes a full account, the default applies.
    sqlx::query("UPDATE users SET is_anonymous = false WHERE id = $1")
        .bind(&guest_id)
        .execute(&harness.state().pool)
        .await
        .unwrap();
    assert_eq!(
        roles_of(&harness, &guest_id).await["roles"],
        json!(["app:member"])
    );
}

#[tokio::test]
async fn default_role_setting_refuses_unsafe_or_missing_keys() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    for (key, code) in [
        ("org:member", "form_param_format_invalid"),
        ("org:admin", "form_param_format_invalid"),
        ("app:sys_admin", "form_param_format_invalid"),
        ("app:sys_owner", "form_param_format_invalid"),
        ("app:missing", "org_role_not_found"),
        ("", "form_param_format_invalid"),
    ] {
        let response = set_default(&harness, json!(key)).await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{key}: {}",
            response.text()
        );
        assert_eq!(error_code(&response).as_deref(), Some(code), "{key}");
        assert_eq!(
            response.value()["errors"][0]["meta"]["param_name"],
            "roles.defaultRole",
            "{key}"
        );
    }
    let response = set_default(&harness, json!(42)).await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(harness.state().settings.get().roles.default_role.is_none());
}

#[tokio::test]
async fn the_default_role_cannot_be_deleted_until_it_is_replaced() {
    let harness = setup().await;
    let role = create_role(&harness, "app:member", &[]).await;
    let id = role["id"].as_str().unwrap().to_string();
    set_default(&harness, json!("app:member")).await;

    let refused = harness.delete(&format!("/v1/roles/{id}")).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text());
    assert_eq!(error_code(&refused).as_deref(), Some("not_allowed_access"));
    assert!(refused.text().contains("default role"));

    set_default(&harness, Value::Null).await;
    let deleted = harness.delete(&format!("/v1/roles/{id}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
}

/// A default that names a role which no longer exists (a concurrent delete, or
/// an import) grants nothing rather than failing reads or minting a stale key.
#[tokio::test]
async fn a_dangling_default_grants_nothing() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let user = create_user(&harness, "dangling@example.com").await;
    sqlx::query("DELETE FROM roles WHERE key = 'app:member'")
        .execute(&harness.state().pool)
        .await
        .unwrap();
    let roles = roles_of(&harness, &user).await;
    assert_eq!(roles["roles"], json!([]));
    assert_eq!(roles["default_role"], "app:member");
    assert_eq!(
        session_claims(&harness, &user, None).await["roles"],
        json!([])
    );
}

/// `orbitid owner <email>` on an account that inherits the default keeps the
/// inherited role once the assignment becomes explicit.
#[tokio::test]
async fn granting_owner_keeps_the_inherited_default() {
    use orbitid_identity::console::{grant_owner, OwnerGrant};

    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    let user = create_user(&harness, "promote@example.com").await;
    set_default(&harness, json!("app:member")).await;
    let granted = grant_owner(harness.state(), &user).await.expect("grant");
    assert!(matches!(granted, OwnerGrant::Granted(_)));
    let roles = roles_of(&harness, &user).await;
    assert_eq!(roles["roles"], json!(["app:member", "app:sys_owner"]));
    assert_eq!(roles["source"], "assigned");
}
