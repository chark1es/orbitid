//! Session inactivity, account deletion/password edge cases and external-account
//! negatives (`test/security/session-inactivity.test.ts`, profile/password parts
//! of `test/core/profile.test.ts`, `test/core/oauth.test.ts` negative cases).

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::http::now;
use serde_json::json;

#[tokio::test]
async fn idle_sessions_are_refused_on_me_and_organization_routes() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "session": { "inactivityTimeoutSeconds": 60 },
            "organizations": { "enabled": true }
        }))
        .await
        .expect("settings");
    let user = h.signed_in("idle@example.com", "Sup3r-secret!").await;
    let org = user
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Idle Co" })),
            &[],
        )
        .await;
    assert_status(&org, StatusCode::OK);
    let org_id = org.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(now() - 120_000)
        .bind(&user.auth.session.id)
        .execute(&h.state().pool)
        .await
        .expect("update");

    let me = get_json(&user.client, "/v1/client/me").await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_codes(&me), vec!["authentication_invalid"]);
    let rename = user
        .client
        .request(
            "PATCH",
            &format!("/v1/client/organizations/{org_id}"),
            Some(json!({ "name": "Renamed" })),
            &[],
        )
        .await;
    assert_eq!(rename.status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_codes(&rename), vec!["authentication_invalid"]);
}

#[tokio::test]
async fn revoked_sessions_and_foreign_session_ids_are_refused() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "session": { "multiSession": true } }))
        .await
        .expect("settings");
    let user = h.signed_in("revoked@example.com", "Sup3r-secret!").await;
    let other = h
        .signed_in("revoked-other@example.com", "Sup3r-secret!")
        .await;

    let foreign = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/sessions/{}/revoke", other.auth.session.id),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);

    sqlx::query("UPDATE sessions SET status = 'revoked' WHERE id = $1")
        .bind(&user.auth.session.id)
        .execute(&h.state().pool)
        .await
        .expect("update");
    let denied = get_json(&user.client, "/v1/client/me").await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_codes(&denied), vec!["authentication_invalid"]);
}

#[tokio::test]
async fn remove_password_requires_one_and_keeps_a_sign_in_method() {
    let h = harness().await;
    let user = h
        .signed_in("remove-password@example.com", "Sup3r-secret!")
        .await;

    let wrong = user
        .client
        .request(
            "POST",
            "/v1/client/me/remove_password",
            Some(json!({ "current_password": "not-it" })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&wrong), vec!["form_password_incorrect"]);

    let removed = user
        .client
        .request(
            "POST",
            "/v1/client/me/remove_password",
            Some(json!({ "current_password": user.password })),
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    let row: Option<String> = sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
        .bind(&user.user_id)
        .fetch_one(&h.state().pool)
        .await
        .expect("user");
    assert!(row.is_none());

    let again = user
        .client
        .request(
            "POST",
            "/v1/client/me/remove_password",
            Some(json!({ "current_password": user.password })),
            &[],
        )
        .await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&again), vec!["strategy_for_user_invalid"]);
}

#[tokio::test]
async fn a_passwordless_account_sets_a_password_without_a_current_one() {
    let h = harness().await;
    let user = h
        .signed_in("passwordless@example.com", "Sup3r-secret!")
        .await;
    sqlx::query("UPDATE users SET password_hash = NULL WHERE id = $1")
        .bind(&user.user_id)
        .execute(&h.state().pool)
        .await
        .expect("update");

    let missing = user
        .client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({ "new_password": "N3wPassword!" })),
            &[],
        )
        .await;
    assert_status(&missing, StatusCode::OK);

    let stored: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(&user.user_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("user");
    assert!(stored.is_some());
}

#[tokio::test]
async fn changing_a_password_can_keep_other_sessions() {
    let h = harness().await;
    let user = h
        .signed_in("keep-sessions@example.com", "Sup3r-secret!")
        .await;
    let other = orbitid_identity::testing::create_test_client_session(h.state(), &user.user_id)
        .await
        .expect("second session");

    let changed = user
        .client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({
                "current_password": user.password,
                "new_password": "N3wPassword!",
                "sign_out_of_other_sessions": false
            })),
            &[],
        )
        .await;
    assert_status(&changed, StatusCode::OK);
    let other_row = orbitid_identity::sessions::get_session(h.state(), &other.session.id)
        .await
        .expect("session")
        .expect("exists");
    assert_eq!(other_row.status, "active");
}

#[tokio::test]
async fn account_deletion_can_be_disabled() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "userSettings": { "deleteSelfEnabled": false } }))
        .await
        .expect("settings");
    let user = h.signed_in("no-delete@example.com", "Sup3r-secret!").await;
    let denied = user
        .client
        .request("DELETE", "/v1/client/me", None, &[])
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&denied), vec!["not_allowed_access"]);

    h.state()
        .settings
        .update(json!({ "userSettings": { "deleteSelfEnabled": true } }))
        .await
        .expect("settings");
    sqlx::query("UPDATE users SET delete_self_enabled = false WHERE id = $1")
        .bind(&user.user_id)
        .execute(&h.state().pool)
        .await
        .expect("update");
    let per_user = user
        .client
        .request("DELETE", "/v1/client/me", None, &[])
        .await;
    assert_eq!(per_user.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn external_account_creation_rejects_unknown_and_disabled_providers() {
    let h = harness().await;
    let user = h.signed_in("external@example.com", "Sup3r-secret!").await;

    let not_oauth = user
        .client
        .request(
            "POST",
            "/v1/client/me/external_accounts",
            Some(json!({ "strategy": "password" })),
            &[],
        )
        .await;
    assert_eq!(not_oauth.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&not_oauth), vec!["oauth_provider_not_enabled"]);

    let disabled = user
        .client
        .request(
            "POST",
            "/v1/client/me/external_accounts",
            Some(json!({ "strategy": "oauth_google" })),
            &[],
        )
        .await;
    assert_eq!(disabled.status, StatusCode::BAD_REQUEST);
    assert_eq!(error_codes(&disabled), vec!["oauth_provider_not_enabled"]);

    let listed = get_json(&user.client, "/v1/client/me/external_accounts").await;
    assert_status(&listed, StatusCode::OK);
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(0));

    let missing = user
        .client
        .request(
            "DELETE",
            "/v1/client/me/external_accounts/ext_missing",
            None,
            &[],
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(error_codes(&missing), vec!["external_account_not_found"]);
}

#[tokio::test]
async fn profile_patch_accepts_legal_acceptance_and_clears_names_when_allowed() {
    let h = harness().await;
    let user = h.signed_in("legal@example.com", "Sup3r-secret!").await;
    let response = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({
                "first_name": "Ada",
                "last_name": "Lovelace",
                "legal_accepted": true,
                "unsafe_metadata": { "nested": { "ok": true }, "empty": null }
            })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::OK);
    let accepted: Option<i64> =
        sqlx::query_scalar("SELECT legal_accepted_at FROM users WHERE id = $1")
            .bind(&user.user_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("user");
    assert!(accepted.is_some());

    let cleared = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": null, "last_name": null })),
            &[],
        )
        .await;
    assert_status(&cleared, StatusCode::OK);
    assert_eq!(
        cleared.value()["response"]["first_name"],
        serde_json::Value::Null
    );
    assert_eq!(
        cleared.value()["response"]["last_name"],
        serde_json::Value::Null
    );

    // A required attribute cannot be cleared.
    h.state()
        .settings
        .update(json!({ "attributes": { "firstName": { "required": true } } }))
        .await
        .expect("settings");
    let denied = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": null })),
            &[],
        )
        .await;
    assert_eq!(denied.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&denied), vec!["form_param_missing"]);
}

#[tokio::test]
async fn changing_the_password_revokes_trusted_devices() {
    let h = harness().await;
    orbitid_identity::testing::enable_trusted_devices(h.state(), 30)
        .await
        .expect("trusted devices");
    let user = h
        .signed_in("trusted-password@example.com", "Sup3r-secret!")
        .await;
    let now_ms = now();
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at, created_at, \
         updated_at) VALUES ('tdev_password', $1, 'hash', 'Laptop', $2, $3, $3)",
    )
    .bind(&user.user_id)
    .bind(now_ms + 30 * 24 * 3_600_000)
    .bind(now_ms)
    .execute(&h.state().pool)
    .await
    .expect("device");

    let changed = user
        .client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({
                "current_password": user.password,
                "new_password": "N3wPassword!",
                "sign_out_of_other_sessions": false
            })),
            &[],
        )
        .await;
    assert_status(&changed, StatusCode::OK);
    let revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM trusted_devices WHERE id = 'tdev_password'")
            .fetch_one(&h.state().pool)
            .await
            .expect("device");
    assert!(revoked.is_some());
}

#[tokio::test]
async fn starts_an_external_account_link_with_a_browser_binding_cookie() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "social": {
                "google": {
                    "enabled": true,
                    "clientId": "google-client-id",
                    "clientSecret": "google-client-secret"
                }
            }
        }))
        .await
        .expect("settings");
    let user = h
        .signed_in("external-start@example.com", "Sup3r-secret!")
        .await;
    let started = user
        .client
        .request(
            "POST",
            "/v1/client/me/external_accounts",
            Some(json!({
                "strategy": "oauth_google",
                "redirect_url": "http://localhost:3000/account"
            })),
            &[],
        )
        .await;
    assert_status(&started, StatusCode::OK);
    let response = &started.value()["response"];
    assert_eq!(response["object"], "external_account");
    assert_eq!(response["provider"], "google");
    assert_eq!(response["verification"]["status"], "unverified");
    assert_eq!(response["verification"]["strategy"], "oauth_google");
    let redirect = response["verification"]["external_verification_redirect_url"]
        .as_str()
        .expect("redirect");
    assert!(redirect.starts_with("https://accounts.google.com/"));
    assert!(redirect.contains("state="));
    assert_eq!(
        response["external_verification_redirect_url"],
        response["verification"]["external_verification_redirect_url"]
    );
    let cookies: Vec<&str> = started
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect();
    assert!(
        cookies
            .iter()
            .any(|cookie| cookie.starts_with("__orbit_oauth=")),
        "missing browser binding cookie: {cookies:?}"
    );

    // The external account row appears only after the provider callback.
    let listed = get_json(&user.client, "/v1/client/me/external_accounts").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn metadata_patch_cannot_pollute_prototypes() {
    let h = harness().await;
    let user = h.signed_in("prototype@example.com", "Sup3r-secret!").await;
    let attack: serde_json::Value = serde_json::from_str(
        r#"{"unsafe_metadata":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"tier":"gold"}}"#,
    )
    .expect("json");
    let response = user
        .client
        .request("PATCH", "/v1/client/me", Some(attack), &[])
        .await;
    assert_status(&response, StatusCode::OK);
    let metadata: sqlx::types::Json<serde_json::Value> =
        sqlx::query_scalar("SELECT unsafe_metadata FROM users WHERE id = $1")
            .bind(&user.user_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("metadata");
    assert_eq!(metadata.0, json!({ "tier": "gold" }));
}
