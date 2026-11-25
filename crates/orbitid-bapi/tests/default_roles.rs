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
    let missing = harness.get("/v1/users/user_missing/roles").await;
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

/// Both owner paths add the Owner role on top of the user's roles without
/// pinning them: an account that follows the default keeps following it.
#[tokio::test]
async fn owner_paths_keep_following_the_default() {
    use orbitid_identity::console::{create_owner, grant_owner, OwnerGrant, OwnerInput};

    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    create_role(&harness, "app:viewer", &[]).await;
    set_default(&harness, json!("app:member")).await;

    // First-run setup on the empty instance.
    let owner = create_owner(
        harness.state(),
        &OwnerInput {
            email: "first-owner@example.com".into(),
            password_hash: "not-a-real-hash".into(),
            first_name: None,
            last_name: None,
        },
    )
    .await
    .expect("setup")
    .expect("instance was empty");
    let roles = roles_of(&harness, &owner.id).await;
    assert_eq!(roles["roles"], json!(["app:member", "app:sys_owner"]));
    assert_eq!(roles["source"], "default");

    // `orbitid owner <email>` on an existing account behaves the same.
    let user = create_user(&harness, "promote@example.com").await;
    let granted = grant_owner(harness.state(), &user).await.expect("grant");
    assert!(matches!(granted, OwnerGrant::Granted(_)));
    let roles = roles_of(&harness, &user).await;
    assert_eq!(roles["roles"], json!(["app:member", "app:sys_owner"]));
    assert_eq!(roles["source"], "default");
    assert!(matches!(
        grant_owner(harness.state(), &user).await.expect("again"),
        OwnerGrant::AlreadyOwner(_)
    ));

    // Both keep following a changed default.
    set_default(&harness, json!("app:viewer")).await;
    for id in [&owner.id, &user] {
        assert_eq!(
            roles_of(&harness, id).await["roles"],
            json!(["app:sys_owner", "app:viewer"])
        );
    }
}

/// Resetting a console holder never removes the console grant, so `DELETE`
/// on the only owner cannot leave the console unclaimed.
#[tokio::test]
async fn reset_keeps_console_access() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    create_role(&harness, "app:support", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let owner = create_user(&harness, "only-owner@example.com").await;
    let put = harness
        .put(
            &format!("/v1/users/{owner}/roles"),
            json!({ "roles": ["app:sys_owner", "app:support"] }),
        )
        .await;
    assert_eq!(put.status, StatusCode::OK, "{}", put.text());
    assert_eq!(put.value()["source"], "assigned");

    let reset = harness.delete(&format!("/v1/users/{owner}/roles")).await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    assert_eq!(
        reset.value()["roles"],
        json!(["app:member", "app:sys_owner"])
    );
    assert_eq!(reset.value()["source"], "default");
    assert!(
        orbitid_identity::operator_session::has_console_access(harness.state(), &owner)
            .await
            .unwrap()
    );
    assert!(
        !orbitid_identity::console::console_unclaimed(harness.state())
            .await
            .unwrap()
    );
}

/// The batched path (`role_claims_for_users`, used by list endpoints) agrees
/// with the single-user path for inheriting, assigned and guest users.
#[tokio::test]
async fn batched_claims_match_for_mixed_users() {
    use orbitid_identity::user_roles::{role_claims_for_user, role_claims_for_users, RoleSource};

    let harness = setup().await;
    create_role(&harness, "app:member", &["app:reports:read"]).await;
    create_role(&harness, "app:support", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let inheriting = create_user(&harness, "batch-inherit@example.com").await;
    let assigned = create_user(&harness, "batch-assigned@example.com").await;
    let emptied = create_user(&harness, "batch-empty@example.com").await;
    harness
        .put(
            &format!("/v1/users/{assigned}/roles"),
            json!({ "roles": ["app:support"] }),
        )
        .await;
    harness
        .put(
            &format!("/v1/users/{emptied}/roles"),
            json!({ "roles": [] }),
        )
        .await;
    // A console holder with no custom rows: the system grant never decides
    // the source, so they follow the default on top of it.
    let console_only = create_user(&harness, "batch-console@example.com").await;
    let pinned = harness
        .put(
            &format!("/v1/users/{console_only}/roles"),
            json!({ "roles": ["app:sys_admin"] }),
        )
        .await;
    // A PUT naming only a system grant still records an explicit assignment.
    assert_eq!(pinned.value()["source"], "assigned");
    assert_eq!(pinned.value()["roles"], json!(["app:sys_admin"]));
    let reset = harness
        .delete(&format!("/v1/users/{console_only}/roles"))
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    let guest = orbitid_identity::testing::create_test_guest(harness.state())
        .await
        .expect("guest")
        .id;
    let ids = vec![
        inheriting.clone(),
        assigned.clone(),
        emptied.clone(),
        console_only.clone(),
        guest.clone(),
        "user_missing".to_string(),
    ];
    let batch = role_claims_for_users(harness.state(), &ids).await.unwrap();
    for id in &ids {
        let single = role_claims_for_user(harness.state(), id).await.unwrap();
        assert_eq!(batch[id], single, "{id}");
    }
    assert_eq!(batch[&inheriting].roles, vec!["app:member"]);
    assert_eq!(batch[&inheriting].permissions, vec!["app:reports:read"]);
    assert_eq!(batch[&inheriting].source, RoleSource::Default);
    assert_eq!(batch[&assigned].roles, vec!["app:support"]);
    assert_eq!(batch[&assigned].source, RoleSource::Assigned);
    assert!(batch[&emptied].roles.is_empty());
    assert_eq!(batch[&emptied].source, RoleSource::Assigned);
    assert_eq!(
        batch[&console_only].roles,
        vec!["app:member", "app:sys_admin"]
    );
    assert_eq!(batch[&console_only].source, RoleSource::Default);
    // Guests and unknown ids report the default while holding nothing.
    for id in [&guest, &"user_missing".to_string()] {
        assert!(batch[id].roles.is_empty(), "{id}");
        assert_eq!(batch[id].source, RoleSource::Default, "{id}");
    }
}

/// `SessionJSON.user` (single and list) carries the effective roles, and a
/// token minted right after a default change carries the new role.
#[tokio::test]
async fn sessions_and_fresh_tokens_follow_the_default() {
    let harness = setup().await;
    create_role(&harness, "app:member", &[]).await;
    create_role(&harness, "app:viewer", &[]).await;
    set_default(&harness, json!("app:member")).await;
    let user = create_user(&harness, "session-roles@example.com").await;
    let session = harness.create_session(&user).await;

    let read = harness
        .get(&format!("/v1/sessions/{}", session.session_id))
        .await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text());
    assert_eq!(read.value()["user"]["roles"], json!(["app:member"]));
    let list = harness.get(&format!("/v1/sessions?user_id={user}")).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.text());
    let list = list.value();
    let rows = list
        .as_array()
        .or_else(|| list["data"].as_array())
        .expect("session list");
    assert_eq!(rows[0]["user"]["roles"], json!(["app:member"]));

    let mint = || async {
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
        orbitid_credentials::jwt::decode_jwt_payload(&jwt).expect("payload")
    };
    assert_eq!(mint().await["roles"], json!(["app:member"]));
    assert_eq!(
        set_default(&harness, json!("app:viewer")).await.status,
        StatusCode::OK
    );
    // Same session, next mint: no re-login, no cache to expire.
    assert_eq!(mint().await["roles"], json!(["app:viewer"]));
}
