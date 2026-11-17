//! Authentication must run before request-body parsing, as in the TypeScript
//! handlers: an unauthenticated request with a malformed body answers 401 (or
//! 404 for a missing session), never 422. Where the TS path creates a browser
//! client before failing, the new `__client` cookie is on the error response.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use orbitid_core::testing::{test_state, TestClient};
use orbitid_identity::testing::{
    add_test_member, create_test_organization, sign_up_user, test_app_state,
};
use serde_json::json;
use tower::ServiceExt;

async fn raw_post(
    app: axum::Router,
    path: &str,
) -> (StatusCode, Option<String>, serde_json::Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from("{not json"))
        .expect("request");
    let response = app.oneshot(request).await.expect("router");
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .map(|value| value.to_str().unwrap_or_default().to_string());
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, cookie, value)
}

#[tokio::test]
async fn me_routes_authenticate_before_parsing_the_body() {
    let ctx = test_state().await;
    let (status, cookie, value) = raw_post(
        orbitid_server::build_app(ctx.state.clone()),
        "/v1/client/me/passkeys",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["errors"][0]["code"], "authentication_invalid");
    // The TS `getOrCreateClient` issues a client cookie before `requireActiveUser` throws.
    assert!(cookie.is_some_and(|cookie| cookie.contains("__client=")));
}

#[tokio::test]
async fn password_routes_require_reverification_before_the_body() {
    let ctx = test_state().await;
    let (status, _cookie, value) = raw_post(
        orbitid_server::build_app(ctx.state.clone()),
        "/v1/client/me/change_password",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["errors"][0]["code"], "authentication_invalid");
}

#[tokio::test]
async fn organization_routes_resolve_the_caller_before_the_body() {
    let ctx = test_state().await;
    let (status, _cookie, value) = raw_post(
        orbitid_server::build_app(ctx.state.clone()),
        "/v1/client/organizations",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        value["errors"][0]["code"] == "authentication_invalid"
            || value["errors"][0]["code"] == "client_state_invalid"
    );
}

#[tokio::test]
async fn session_routes_load_the_session_before_the_body() {
    let ctx = test_state().await;
    let (status, cookie, value) = raw_post(
        orbitid_server::build_app(ctx.state.clone()),
        "/v1/client/sessions/ses_missing/touch",
    )
    .await;
    // The TS path creates the client, then fails on the missing session.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(value["errors"][0]["code"], "resource_not_found");
    assert!(cookie.is_some_and(|cookie| cookie.contains("__client=")));
}

#[tokio::test]
async fn backend_routes_check_the_secret_key_before_the_body() {
    let ctx = test_state().await;
    let (status, _cookie, value) =
        raw_post(orbitid_server::build_app(ctx.state.clone()), "/v1/users").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["errors"][0]["code"], "secret_key_invalid");
}

/// Organization permission checks run before the body is parsed, so an
/// authenticated non-member with a malformed body gets 403, not 422.
#[tokio::test]
async fn organization_permission_runs_before_body_validation() {
    let app = test_app_state().await;
    app.state()
        .settings
        .update(json!({ "organizations": { "enabled": true } }))
        .await
        .expect("enable organizations");
    let owner = sign_up_user(app.state(), "order-owner@acme.test", "Sup3r-secret!")
        .await
        .expect("owner");
    let member = sign_up_user(app.state(), "order-member@acme.test", "Sup3r-secret!")
        .await
        .expect("member");
    let org = create_test_organization(app.state(), "Order", None, &owner.user.user.id)
        .await
        .expect("organization");
    add_test_member(app.state(), &org.id, &member.user.user.id, "org:member")
        .await
        .expect("membership");
    let client = TestClient::with_cookie(
        orbitid_server::build_app(app.app_state()),
        &member.auth.cookie,
    );

    // A number for `name` is a 422 if validation wins; the TS order is 403 first.
    let rename = client
        .request(
            "PATCH",
            &format!("/v1/client/organizations/{}", org.id),
            Some(json!({ "name": 42 })),
            &[],
        )
        .await;
    assert_eq!(rename.status, StatusCode::FORBIDDEN, "{}", rename.text());
    assert_eq!(
        rename.value()["errors"][0]["code"],
        "org_permission_required"
    );

    let invitation = client
        .request(
            "POST",
            &format!("/v1/client/organizations/{}/invitations", org.id),
            Some(json!({ "email_address": 42 })),
            &[],
        )
        .await;
    assert_eq!(invitation.status, StatusCode::FORBIDDEN);
    assert_eq!(
        invitation.value()["errors"][0]["code"],
        "org_permission_required"
    );

    // The same order applies to the organization API-key surface.
    let api_key = client
        .request(
            "POST",
            &format!("/v1/client/organizations/{}/api_keys", org.id),
            Some(json!({ "name": 42 })),
            &[],
        )
        .await;
    assert_eq!(api_key.status, StatusCode::FORBIDDEN, "{}", api_key.text());
    assert_eq!(
        api_key.value()["errors"][0]["code"],
        "org_permission_required"
    );

    // A missing organization is still a 404 before body validation.
    let missing_org = client
        .request(
            "POST",
            "/v1/client/organizations/org_missing/api_keys",
            Some(json!({ "name": 42 })),
            &[],
        )
        .await;
    assert_eq!(missing_org.status, StatusCode::NOT_FOUND);
    assert_eq!(
        missing_org.value()["errors"][0]["code"],
        "organization_not_found"
    );
}

/// A disabled device-grant feature answers 404 before authentication or body
/// parsing, matching the TypeScript handlers' `deviceEnabled()` guard.
#[tokio::test]
async fn disabled_device_grant_is_404_before_auth_and_body_validation() {
    let ctx = test_state().await;
    let app = orbitid_server::build_app(ctx.state.clone());
    for path in ["/oauth/device", "/v1/client/oauth/device/approve"] {
        let (status, _cookie, value) = raw_post(app.clone(), path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(value["errors"][0]["code"], "resource_not_found", "{path}");
    }
}

/// Hono has no 405: a wrong method under `/v1` falls through to the guarded
/// backend sub-app, exactly like the TypeScript server.
#[tokio::test]
async fn wrong_method_under_v1_is_guarded_like_the_ts_backend() {
    let e2e = {
        let app = orbitid_identity::testing::test_app_state().await;
        orbitid_core::testing::TestClient::new(orbitid_server::build_app(app.app_state()))
    };
    let unauthenticated = e2e.get("/v1/client/sign_ins", &[]).await;
    assert_eq!(
        unauthenticated.status,
        StatusCode::UNAUTHORIZED,
        "unexpected body: {}",
        unauthenticated.text()
    );
    assert_eq!(
        unauthenticated.value()["errors"][0]["code"],
        "secret_key_invalid"
    );
    let authenticated = e2e
        .get(
            "/v1/client/sign_ins",
            &[("authorization", "Bearer sk_test_testsecret")],
        )
        .await;
    assert_eq!(authenticated.status, StatusCode::NOT_FOUND);
    assert_eq!(
        authenticated.value()["errors"][0]["code"],
        "resource_not_found"
    );
}
