//! Organization-owned OAuth applications and per-user cross-organization
//! access (migration 0019): who may use an application, the Backend API that
//! grants access, and what losing access does to issued grants.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use common::{
    authorize, challenge_for, code_flow, harness, insert_user, pkce_verifier, query_of, send,
    settings, Browser, Harness, REDIRECT_URI,
};
use orbitid_core::models::OrganizationRow;
use orbitid_core::testing::TestResponse;
use orbitid_identity::testing::{add_test_member, create_test_organization};
use serde_json::{json, Value};

async fn organization(h: &Harness, owner: &Browser, name: &str) -> OrganizationRow {
    create_test_organization(h.state(), name, None, &owner.user.id)
        .await
        .unwrap()
}

/// Authorize params for a PKCE code request; returns the verifier too.
fn code_request(app: &Value, scope: &str) -> (Vec<(String, String)>, String) {
    let verifier = pkce_verifier();
    let params = vec![
        (
            "client_id".into(),
            app["client_id"].as_str().unwrap().into(),
        ),
        ("redirect_uri".into(), REDIRECT_URI.into()),
        ("response_type".into(), "code".into()),
        ("scope".into(), scope.into()),
        ("state".into(), "s1".into()),
        ("code_challenge".into(), challenge_for(&verifier)),
        ("code_challenge_method".into(), "S256".into()),
    ];
    (params, verifier)
}

async fn authorize_query(
    h: &Harness,
    browser: &Browser,
    app: &Value,
    scope: &str,
) -> (std::collections::HashMap<String, String>, String) {
    let (params, verifier) = code_request(app, scope);
    let borrowed: Vec<(&str, &str)> = params
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    (authorize(h, browser, &borrowed).await, verifier)
}

async fn exchange(h: &Harness, app: &Value, code: &str, verifier: &str) -> TestResponse {
    h.form(
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("code_verifier", verifier),
            ("client_id", app["client_id"].as_str().unwrap()),
            ("client_secret", app["client_secret"].as_str().unwrap()),
        ],
    )
    .await
}

async fn refresh(h: &Harness, app: &Value, refresh_token: &str) -> TestResponse {
    h.form(
        "/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", app["client_id"].as_str().unwrap()),
            ("client_secret", app["client_secret"].as_str().unwrap()),
        ],
    )
    .await
}

async fn userinfo(h: &Harness, access_token: &str) -> TestResponse {
    h.client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access_token}"))],
        )
        .await
}

async fn live_grants(h: &Harness, app: &Value, user_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants WHERE application_id = $1 AND user_id = $2 \
         AND revoked = false",
    )
    .bind(app["id"].as_str().unwrap())
    .bind(user_id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap()
}

fn grants_path(app: &Value) -> String {
    format!(
        "/v1/oauth_applications/{}/access_grants",
        app["id"].as_str().unwrap()
    )
}

#[tokio::test]
async fn instance_wide_applications_keep_working_for_everyone() {
    let h = harness().await;
    let browser = insert_user(&h, "anyone@example.com").await;
    let app = h.create_app(json!({})).await;
    assert_eq!(app["organization_id"], Value::Null);
    let flow = code_flow(&h, &browser, &app, "openid offline_access").await;
    let rotated = refresh(&h, &app, flow.tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.text());
}

#[tokio::test]
async fn members_may_use_their_organizations_application() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let member = insert_user(&h, "member@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let app = h.create_app(json!({ "organization_id": org.id })).await;
    assert_eq!(app["organization_id"], org.id);

    let flow = code_flow(&h, &member, &app, "openid offline_access").await;
    assert!(flow.tokens["access_token"].as_str().is_some());
    let info = userinfo(&h, flow.tokens["access_token"].as_str().unwrap()).await;
    assert_eq!(info.status, StatusCode::OK, "{}", info.text());
    code_flow(&h, &owner, &app, "openid").await;
}

#[tokio::test]
async fn non_members_are_denied_without_a_code() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let outsider = insert_user(&h, "outsider@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({ "organization_id": org.id })).await;

    let (query, _) = authorize_query(&h, &outsider, &app, "openid").await;
    assert_eq!(query["error"], "access_denied");
    assert_eq!(query["state"], "s1");
    assert!(!query.contains_key("code"));

    // A member of a different organization is an outsider too.
    let other_org = organization(&h, &outsider, "Other").await;
    let other_app = h
        .create_app(json!({ "organization_id": other_org.id }))
        .await;
    let (query, _) = authorize_query(&h, &owner, &other_app, "openid").await;
    assert_eq!(query["error"], "access_denied");
    assert_eq!(live_grants(&h, &app, &outsider.user.id).await, 0);
}

#[tokio::test]
async fn an_operator_grant_lets_a_non_member_in_and_revoking_it_stops_refresh() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let guest = insert_user(&h, "contractor@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({ "organization_id": org.id })).await;

    let created = h
        .post(&grants_path(&app), json!({ "user_id": guest.user.id }))
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    assert_eq!(created.value()["object"], "oauth_application_access_grant");
    assert_eq!(created.value()["user_id"], guest.user.id);
    assert_eq!(created.value()["application_id"], app["id"]);
    // Idempotent.
    let again = h
        .post(&grants_path(&app), json!({ "user_id": guest.user.id }))
        .await;
    assert_eq!(again.status, StatusCode::OK);

    let listed = h.get(&grants_path(&app)).await;
    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(listed.value()["total_count"], 1);
    let for_user = h
        .get(&format!(
            "/v1/users/{}/oauth_application_access_grants",
            guest.user.id
        ))
        .await;
    assert_eq!(for_user.status, StatusCode::OK);
    assert_eq!(for_user.value()["data"][0]["application_id"], app["id"]);

    let flow = code_flow(&h, &guest, &app, "openid offline_access").await;
    let refresh_token = flow.tokens["refresh_token"].as_str().unwrap().to_string();
    let access_token = flow.tokens["access_token"].as_str().unwrap().to_string();
    assert!(live_grants(&h, &app, &guest.user.id).await > 0);

    let removed = h
        .delete(&format!("{}/{}", grants_path(&app), guest.user.id))
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());
    assert_eq!(removed.value()["deleted"], true);
    assert_eq!(live_grants(&h, &app, &guest.user.id).await, 0);

    let refused = refresh(&h, &app, &refresh_token).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(refused.value()["error"], "invalid_grant");
    assert_eq!(
        userinfo(&h, &access_token).await.status,
        StatusCode::UNAUTHORIZED
    );
    let (query, _) = authorize_query(&h, &guest, &app, "openid").await;
    assert_eq!(query["error"], "access_denied");

    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_logs WHERE target_id = $1 \
         AND action IN ('oauth_application_access_grant.created', \
                        'oauth_application_access_grant.deleted')",
    )
    .bind(app["id"].as_str().unwrap())
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(audited, 2);
}

#[tokio::test]
async fn removing_a_membership_stops_refresh_unless_access_was_granted() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let leaver = insert_user(&h, "leaver@acme.test").await;
    let kept = insert_user(&h, "kept@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    for browser in [&leaver, &kept] {
        add_test_member(h.state(), &org.id, &browser.user.id, "org:member")
            .await
            .unwrap();
    }
    // An app without organization claims: only the new rule revokes here.
    let app = h
        .create_app(json!({
            "organization_id": org.id,
            "scopes": "openid email offline_access",
        }))
        .await;
    let granted = h
        .post(&grants_path(&app), json!({ "user_id": kept.user.id }))
        .await;
    assert_eq!(granted.status, StatusCode::CREATED);

    let leaver_flow = code_flow(&h, &leaver, &app, "openid offline_access").await;
    let kept_flow = code_flow(&h, &kept, &app, "openid offline_access").await;

    for browser in [&leaver, &kept] {
        orbitid_identity::orgs::leave_organization(h.state(), &org.id, &browser.user.id)
            .await
            .unwrap();
    }

    assert_eq!(live_grants(&h, &app, &leaver.user.id).await, 0);
    let refused = refresh(
        &h,
        &app,
        leaver_flow.tokens["refresh_token"].as_str().unwrap(),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(refused.value()["error"], "invalid_grant");

    // The explicit grant outlives the membership.
    let still = refresh(
        &h,
        &app,
        kept_flow.tokens["refresh_token"].as_str().unwrap(),
    )
    .await;
    assert_eq!(still.status, StatusCode::OK, "{}", still.text());
}

/// The token endpoint re-checks access under its locks, so a change that did
/// not (or not yet) revoke the rows still wins.
#[tokio::test]
async fn code_exchange_and_refresh_recheck_access_themselves() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let guest = insert_user(&h, "guest@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({ "organization_id": org.id })).await;
    h.post(&grants_path(&app), json!({ "user_id": guest.user.id }))
        .await;
    let flow = code_flow(&h, &guest, &app, "openid offline_access").await;
    let (query, verifier) = authorize_query(&h, &guest, &app, "openid").await;
    let code = query["code"].clone();

    // Remove the access row behind the service's back: no revocation runs.
    sqlx::query("DELETE FROM oauth_application_access_grants WHERE user_id = $1")
        .bind(&guest.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();

    let exchanged = exchange(&h, &app, &code, &verifier).await;
    assert_eq!(exchanged.status, StatusCode::BAD_REQUEST);
    assert_eq!(exchanged.value()["error"], "invalid_grant");
    assert_eq!(
        exchanged.value()["error_description"],
        "The user is not allowed to use this application"
    );
    let refused = refresh(&h, &app, flow.tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        refused.value()["error_description"],
        "The user is not allowed to use this application"
    );
    let token = flow.tokens["access_token"].as_str().unwrap();
    assert_eq!(userinfo(&h, token).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn assigning_an_owner_revokes_outsiders_and_clearing_it_widens_again() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let outsider = insert_user(&h, "outsider@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({})).await;
    let app_id = app["id"].as_str().unwrap().to_string();

    let outsider_flow = code_flow(&h, &outsider, &app, "openid offline_access").await;
    let owner_flow = code_flow(&h, &owner, &app, "openid offline_access").await;

    let assigned = h
        .patch(
            &format!("/v1/oauth_applications/{app_id}"),
            json!({ "organization_id": org.id }),
        )
        .await;
    assert_eq!(assigned.status, StatusCode::OK, "{}", assigned.text());
    assert_eq!(assigned.value()["organization_id"], org.id);
    assert_eq!(live_grants(&h, &app, &outsider.user.id).await, 0);
    assert!(live_grants(&h, &app, &owner.user.id).await > 0);
    let refused = refresh(
        &h,
        &app,
        outsider_flow.tokens["refresh_token"].as_str().unwrap(),
    )
    .await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    let kept = refresh(
        &h,
        &app,
        owner_flow.tokens["refresh_token"].as_str().unwrap(),
    )
    .await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text());

    // Listing by owner.
    let owned = h
        .get(&format!(
            "/v1/oauth_applications?organization_id={}",
            org.id
        ))
        .await;
    assert_eq!(owned.value()["total_count"], 1);
    let instance_wide = h.get("/v1/oauth_applications?organization_id=null").await;
    assert_eq!(instance_wide.value()["total_count"], 0);

    let cleared = h
        .patch(
            &format!("/v1/oauth_applications/{app_id}"),
            json!({ "organization_id": null }),
        )
        .await;
    assert_eq!(cleared.status, StatusCode::OK);
    assert_eq!(cleared.value()["organization_id"], Value::Null);
    code_flow(&h, &outsider, &app, "openid").await;

    // An unrelated PATCH leaves the owner alone.
    h.patch(
        &format!("/v1/oauth_applications/{app_id}"),
        json!({ "organization_id": org.id }),
    )
    .await;
    let renamed = h
        .patch(
            &format!("/v1/oauth_applications/{app_id}"),
            json!({ "name": "Renamed" }),
        )
        .await;
    assert_eq!(renamed.value()["organization_id"], org.id);

    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_logs WHERE target_id = $1 \
         AND action = 'oauth_application.organization_changed'",
    )
    .bind(&app_id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(audited, 3);
}

#[tokio::test]
async fn consent_hides_the_application_from_non_members() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let outsider = insert_user(&h, "outsider@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h
        .create_app(json!({ "organization_id": org.id, "consent_screen_enabled": true }))
        .await;
    let client_id = app["client_id"].as_str().unwrap();

    let info = h
        .client
        .get(
            &format!("/oauth/consent_info?client_id={client_id}&scope=openid"),
            &[("cookie", &outsider.cookie)],
        )
        .await;
    assert_eq!(info.status, StatusCode::NOT_FOUND);
    let unknown = h
        .client
        .get(
            "/oauth/consent_info?client_id=oa_missing&scope=openid",
            &[("cookie", &outsider.cookie)],
        )
        .await;
    assert_eq!(info.value()["errors"], unknown.value()["errors"]);

    let consent = send(
        &h.router,
        Method::POST,
        "/oauth/consent",
        Body::from(
            serde_json::to_vec(&json!({
                "client_id": client_id,
                "approve": true,
                "scopes": ["openid"],
                "redirect_uri": REDIRECT_URI,
                "state": "s1",
                "code_challenge": challenge_for(&pkce_verifier()),
                "code_challenge_method": "S256",
            }))
            .unwrap(),
        ),
        &[
            ("content-type", "application/json"),
            ("cookie", &outsider.cookie),
        ],
    )
    .await;
    assert_eq!(consent.status, StatusCode::OK, "{}", consent.text());
    let redirect = query_of(consent.value()["redirect_url"].as_str().unwrap());
    assert_eq!(redirect["error"], "access_denied");
    assert!(!redirect.contains_key("code"));
    assert_eq!(live_grants(&h, &app, &outsider.user.id).await, 0);

    // A member still sees the consent screen.
    let member_info = h
        .client
        .get(
            &format!("/oauth/consent_info?client_id={client_id}&scope=openid"),
            &[("cookie", &owner.cookie)],
        )
        .await;
    assert_eq!(member_info.status, StatusCode::OK);
}

async fn enable_device(h: &Harness) {
    settings(
        h,
        json!({
            "oidcProvider": {
                "deviceAuthorizationEnabled": true,
                "deviceCodeIntervalSeconds": 1,
                "deviceCodeLifetimeSeconds": 60
            }
        }),
    )
    .await;
}

async fn start_device(h: &Harness, app: &Value) -> Value {
    let response = h
        .form(
            "/oauth/device_authorization",
            &[
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
                ("scope", "openid"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn poll(h: &Harness, app: &Value, device_code: &str) -> TestResponse {
    h.form(
        "/oauth/token",
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
            ("client_id", app["client_id"].as_str().unwrap()),
            ("client_secret", app["client_secret"].as_str().unwrap()),
        ],
    )
    .await
}

async fn approve(browser: &Browser, user_code: &str) -> TestResponse {
    browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await
}

#[tokio::test]
async fn device_flow_refuses_non_members_and_members_who_leave() {
    let h = harness().await;
    enable_device(&h).await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let member = insert_user(&h, "member@acme.test").await;
    let outsider = insert_user(&h, "outsider@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let app = h.create_app(json!({ "organization_id": org.id })).await;

    // A non-member sees neither the application nor an approve button, and
    // cannot approve. The code stays pending for the person it was meant for.
    let started = start_device(&h, &app).await;
    let user_code = started["user_code"].as_str().unwrap();
    let info = outsider
        .client
        .get(
            &format!("/v1/client/oauth/device?user_code={user_code}"),
            &[],
        )
        .await;
    assert_eq!(info.status, StatusCode::FORBIDDEN, "{}", info.text());
    assert!(!info.text().contains("Test App"));
    let page = send(
        &h.router,
        Method::GET,
        &format!("/oauth/device?user_code={user_code}"),
        Body::empty(),
        &[("cookie", &outsider.cookie)],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(
        page.text().contains("does not have access"),
        "{}",
        page.text()
    );
    assert!(!page.text().contains("Test App"));
    assert!(!page.text().contains("value=\"approve\""));
    let refused = approve(&outsider, user_code).await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text());
    assert_eq!(refused.value()["errors"][0]["code"], "not_allowed_access");
    let pending = poll(&h, &app, started["device_code"].as_str().unwrap()).await;
    assert_eq!(pending.value()["error"], "authorization_pending");
    let member_page = send(
        &h.router,
        Method::GET,
        &format!("/oauth/device?user_code={user_code}"),
        Body::empty(),
        &[("cookie", &member.cookie)],
    )
    .await;
    assert!(member_page.text().contains("Test App"));
    let approved = approve(&member, user_code).await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.text());
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let issued = poll(&h, &app, started["device_code"].as_str().unwrap()).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text());

    // A member approves, then leaves before the device polls.
    let started = start_device(&h, &app).await;
    let approved = approve(&member, started["user_code"].as_str().unwrap()).await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.text());
    orbitid_identity::orgs::leave_organization(h.state(), &org.id, &member.user.id)
        .await
        .unwrap();
    let denied = poll(&h, &app, started["device_code"].as_str().unwrap()).await;
    assert_eq!(denied.status, StatusCode::BAD_REQUEST);
    assert_eq!(denied.value()["error"], "access_denied");
    assert_eq!(live_grants(&h, &app, &member.user.id).await, 0);

    // The owner (still a member) completes the flow.
    let started = start_device(&h, &app).await;
    assert_eq!(
        approve(&owner, started["user_code"].as_str().unwrap())
            .await
            .status,
        StatusCode::OK
    );
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let issued = poll(&h, &app, started["device_code"].as_str().unwrap()).await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.text());
}

#[tokio::test]
async fn access_grant_routes_validate_and_require_the_secret_key() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({ "organization_id": org.id })).await;
    let path = grants_path(&app);

    let anonymous = h.client.get(&path, &[]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
    let anonymous_post = h
        .client
        .post(&path, Some(json!({ "user_id": owner.user.id })), &[])
        .await;
    assert_eq!(anonymous_post.status, StatusCode::UNAUTHORIZED);
    // A signed-in user's own session is not an operator credential.
    let as_user = owner
        .client
        .post(&path, Some(json!({ "user_id": owner.user.id })), &[])
        .await;
    assert_eq!(as_user.status, StatusCode::UNAUTHORIZED);

    let missing = h.post(&path, json!({})).await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
    let unknown_user = h.post(&path, json!({ "user_id": "user_missing" })).await;
    assert_eq!(unknown_user.status, StatusCode::NOT_FOUND);
    let unknown_app = h
        .post(
            "/v1/oauth_applications/oa_missing/access_grants",
            json!({ "user_id": owner.user.id }),
        )
        .await;
    assert_eq!(unknown_app.status, StatusCode::NOT_FOUND);
    let not_granted = h.delete(&format!("{path}/{}", owner.user.id)).await;
    assert_eq!(not_granted.status, StatusCode::NOT_FOUND);
    let unknown_user_list = h
        .get("/v1/users/user_missing/oauth_application_access_grants")
        .await;
    assert_eq!(unknown_user_list.status, StatusCode::NOT_FOUND);

    let bad_owner = h
        .post(
            "/v1/oauth_applications",
            json!({ "name": "X", "redirect_uris": [REDIRECT_URI], "organization_id": "org_missing" }),
        )
        .await;
    assert_eq!(bad_owner.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        bad_owner.value()["errors"][0]["meta"]["param_name"],
        "organization_id"
    );
    let empty_owner = h
        .patch(
            &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
            json!({ "organization_id": "" }),
        )
        .await;
    assert_eq!(empty_owner.status, StatusCode::UNPROCESSABLE_ENTITY);

    // Deleting the application removes its access grants with it.
    let guest = insert_user(&h, "guest@other.test").await;
    h.post(&path, json!({ "user_id": guest.user.id })).await;
    h.delete(&format!(
        "/v1/oauth_applications/{}",
        app["id"].as_str().unwrap()
    ))
    .await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_application_access_grants")
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn an_organization_that_owns_applications_is_not_deleted() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h.create_app(json!({ "organization_id": org.id })).await;

    let refused = orbitid_identity::orgs::delete_organization(h.state(), &org.id)
        .await
        .unwrap_err();
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert_eq!(refused.code, "organization_has_applications");

    // Its last member's deletion keeps the organization (and the app's owner).
    orbitid_identity::orgs::on_user_deleted(h.state(), &owner.user.id)
        .await
        .unwrap();
    let still: Option<String> = sqlx::query_scalar("SELECT id FROM organizations WHERE id = $1")
        .bind(&org.id)
        .fetch_optional(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(still.as_deref(), Some(org.id.as_str()));

    // Once the application is reassigned, the organization can go.
    h.patch(
        &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
        json!({ "organization_id": null }),
    )
    .await;
    assert!(
        orbitid_identity::orgs::delete_organization(h.state(), &org.id)
            .await
            .unwrap()
            .is_some()
    );
}

async fn introspect(h: &Harness, app: &Value, token: &str) -> Value {
    let response = h
        .form(
            "/oauth/introspect",
            &[
                ("token", token),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap()),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

#[tokio::test]
async fn introspection_reports_inactive_once_access_is_lost() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let member = insert_user(&h, "member@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let app = h.create_app(json!({ "organization_id": org.id })).await;
    let flow = code_flow(&h, &member, &app, "openid").await;
    let token = flow.tokens["access_token"].as_str().unwrap().to_string();
    assert_eq!(introspect(&h, &app, &token).await["active"], true);

    // Remove the membership behind the service's back: no revocation runs, the
    // introspection's own check answers.
    sqlx::query("DELETE FROM organization_memberships WHERE user_id = $1")
        .bind(&member.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(
        introspect(&h, &app, &token).await,
        json!({ "active": false })
    );
}

#[tokio::test]
async fn silent_authorization_with_stored_consent_is_refused_after_leaving() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let member = insert_user(&h, "member@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let app = h
        .create_app(json!({ "organization_id": org.id, "consent_screen_enabled": true }))
        .await;
    sqlx::query(
        "INSERT INTO oauth_consents (application_id, user_id, scopes, created_at) \
         VALUES ($1, $2, 'openid', 1)",
    )
    .bind(app["id"].as_str().unwrap())
    .bind(&member.user.id)
    .execute(&h.state().pool)
    .await
    .unwrap();
    let (mut params, _) = code_request(&app, "openid");
    params.push(("prompt".into(), "none".into()));
    let borrowed: Vec<(&str, &str)> = params
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let query = authorize(&h, &member, &borrowed).await;
    assert!(query.contains_key("code"), "stored consent: {query:?}");

    orbitid_identity::orgs::leave_organization(h.state(), &org.id, &member.user.id)
        .await
        .unwrap();
    let query = authorize(&h, &member, &borrowed).await;
    assert_eq!(query["error"], "access_denied");
    assert!(!query.contains_key("code"));
}

#[tokio::test]
async fn moving_an_application_between_organizations_swaps_who_may_use_it() {
    let h = harness().await;
    let alice = insert_user(&h, "alice@a.test").await;
    let bob = insert_user(&h, "bob@b.test").await;
    let org_a = organization(&h, &alice, "Org A").await;
    let org_b = organization(&h, &bob, "Org B").await;
    let app = h.create_app(json!({ "organization_id": org_a.id })).await;
    let flow = code_flow(&h, &alice, &app, "openid offline_access").await;
    let (refused, _) = authorize_query(&h, &bob, &app, "openid").await;
    assert_eq!(refused["error"], "access_denied");

    let moved = h
        .patch(
            &format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap()),
            json!({ "organization_id": org_b.id }),
        )
        .await;
    assert_eq!(moved.status, StatusCode::OK, "{}", moved.text());
    assert_eq!(live_grants(&h, &app, &alice.user.id).await, 0);
    let stale = refresh(&h, &app, flow.tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(stale.value()["error"], "invalid_grant");
    let (query, _) = authorize_query(&h, &alice, &app, "openid").await;
    assert_eq!(query["error"], "access_denied");
    code_flow(&h, &bob, &app, "openid").await;
}

#[tokio::test]
async fn revoking_a_grant_from_a_member_keeps_their_tokens() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let member = insert_user(&h, "member@acme.test").await;
    let org = organization(&h, &owner, "Acme").await;
    add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let app = h.create_app(json!({ "organization_id": org.id })).await;
    h.post(&grants_path(&app), json!({ "user_id": member.user.id }))
        .await;
    let flow = code_flow(&h, &member, &app, "openid offline_access").await;
    let before = live_grants(&h, &app, &member.user.id).await;

    let removed = h
        .delete(&format!("{}/{}", grants_path(&app), member.user.id))
        .await;
    assert_eq!(removed.status, StatusCode::OK);
    assert_eq!(live_grants(&h, &app, &member.user.id).await, before);
    let still = refresh(&h, &app, flow.tokens["refresh_token"].as_str().unwrap()).await;
    assert_eq!(still.status, StatusCode::OK, "{}", still.text());
}

#[tokio::test]
async fn instance_wide_applications_take_no_access_grants() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let guest = insert_user(&h, "guest@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let open = h.create_app(json!({})).await;
    let refused = h
        .post(&grants_path(&open), json!({ "user_id": guest.user.id }))
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        refused.value()["errors"][0]["code"],
        "form_param_value_invalid"
    );

    // Clearing an owner deletes the grants it made meaningful, so they cannot
    // silently apply again when an owner is set later.
    let owned = h.create_app(json!({ "organization_id": org.id })).await;
    let granted = h
        .post(&grants_path(&owned), json!({ "user_id": guest.user.id }))
        .await;
    assert_eq!(granted.status, StatusCode::CREATED);
    let path = format!("/v1/oauth_applications/{}", owned["id"].as_str().unwrap());
    h.patch(&path, json!({ "organization_id": null })).await;
    assert_eq!(h.get(&grants_path(&owned)).await.value()["total_count"], 0);
    h.patch(&path, json!({ "organization_id": org.id })).await;
    let (query, _) = authorize_query(&h, &guest, &owned, "openid").await;
    assert_eq!(query["error"], "access_denied");
}

#[tokio::test]
async fn a_non_member_learns_nothing_about_the_applications_configuration() {
    let h = harness().await;
    let owner = insert_user(&h, "owner@acme.test").await;
    let outsider = insert_user(&h, "outsider@other.test").await;
    let org = organization(&h, &owner, "Acme").await;
    let app = h
        .create_app(json!({ "organization_id": org.id, "pkce_required": true }))
        .await;
    // An unsupported scope and no PKCE challenge: a member would be told
    // `invalid_scope`; the outsider is only told no.
    let query = authorize(
        &h,
        &outsider,
        &[
            ("client_id", app["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid admin:everything"),
            ("state", "s1"),
        ],
    )
    .await;
    assert_eq!(query["error"], "access_denied");
    let member_query = authorize(
        &h,
        &owner,
        &[
            ("client_id", app["client_id"].as_str().unwrap()),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid admin:everything"),
            ("state", "s1"),
        ],
    )
    .await;
    assert_eq!(member_query["error"], "invalid_scope");

    let consent = send(
        &h.router,
        Method::POST,
        "/oauth/consent",
        Body::from(
            serde_json::to_vec(&json!({
                "client_id": app["client_id"],
                "approve": true,
                "scopes": ["openid", "admin:everything"],
                "redirect_uri": REDIRECT_URI,
            }))
            .unwrap(),
        ),
        &[
            ("content-type", "application/json"),
            ("cookie", &outsider.cookie),
        ],
    )
    .await;
    let redirect = query_of(consent.value()["redirect_url"].as_str().unwrap());
    assert_eq!(redirect["error"], "access_denied");
}
