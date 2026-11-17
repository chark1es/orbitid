//! Ported from `test/core/oidc-provider-device.test.ts`: RFC 8628 device
//! authorization, the server-rendered verification page, and its Frontend API.

mod common;

use axum::body::Body;
use axum::http::{Method, StatusCode};
use serde_json::{json, Value};

use common::{decode_claims, harness, insert_user, send, settings, Harness, BASE_URL};

async fn enable_device(h: &Harness) {
    settings(
        h,
        json!({
            "oidcProvider": {
                "deviceAuthorizationEnabled": true,
                "deviceCodeIntervalSeconds": 1,
                "deviceCodeLifetimeSeconds": 60
            },
            "security": { "rateLimitEnabled": false }
        }),
    )
    .await;
}

async fn start_device(h: &Harness, application: &Value) -> Value {
    let client_id = application["client_id"].as_str().unwrap();
    let secret = application["client_secret"].as_str().unwrap_or("");
    let response = h
        .form(
            "/oauth/device_authorization",
            &[
                ("client_id", client_id),
                ("client_secret", secret),
                ("scope", "openid email"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn poll(
    h: &Harness,
    application: &Value,
    device_code: &str,
) -> orbitid_core::testing::TestResponse {
    h.form(
        "/oauth/token",
        &[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
            ("client_id", application["client_id"].as_str().unwrap()),
            (
                "client_secret",
                application["client_secret"].as_str().unwrap_or(""),
            ),
        ],
    )
    .await
}

#[tokio::test]
async fn disabled_by_default_and_absent_from_discovery() {
    let h = harness().await;
    let app = h.create_app(json!({})).await;
    let response = h
        .form(
            "/oauth/device_authorization",
            &[
                ("client_id", app["client_id"].as_str().unwrap()),
                ("scope", "openid"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    let doc = h
        .client
        .get("/.well-known/openid-configuration", &[])
        .await
        .value();
    assert!(doc.get("device_authorization_endpoint").is_none());
    assert!(!doc["grant_types_supported"]
        .as_array()
        .unwrap()
        .contains(&json!("urn:ietf:params:oauth:grant-type:device_code")));

    let poll_response = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", "odc_x"),
                ("client_id", app["client_id"].as_str().unwrap()),
                ("client_secret", app["client_secret"].as_str().unwrap_or("")),
            ],
        )
        .await;
    assert_eq!(poll_response.status, StatusCode::BAD_REQUEST);
    assert_eq!(poll_response.value()["error"], "unsupported_grant_type");
    assert_eq!(
        h.client.get("/oauth/device", &[]).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.client.get("/oauth/device.js", &[]).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        h.client.get("/oauth/device.css", &[]).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn walks_the_whole_flow() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let user_code = created["user_code"].as_str().unwrap().to_string();
    assert_eq!(user_code.len(), 9);
    assert_eq!(
        created["verification_uri"],
        format!("{BASE_URL}/oauth/device")
    );
    assert!(created["verification_uri_complete"]
        .as_str()
        .unwrap()
        .contains(&format!("user_code={user_code}")));
    assert_eq!(created["expires_in"], 60);
    assert_eq!(created["interval"], 1);

    let pending = poll(&h, &app, created["device_code"].as_str().unwrap()).await;
    assert_eq!(pending.status, StatusCode::BAD_REQUEST);
    assert_eq!(pending.value()["error"], "authorization_pending");

    let info = browser
        .client
        .get(
            &format!("/v1/client/oauth/device?user_code={user_code}"),
            &[],
        )
        .await;
    assert_eq!(info.status, StatusCode::OK, "{}", info.text());
    assert_eq!(info.value()["client"]["name"], "Test App");
    assert_eq!(info.value()["scopes"][0]["scope"], "openid");
    assert_eq!(info.value()["status"], "pending");

    let approved = browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.text());
    assert_eq!(approved.value()["status"], "approved");
    assert_eq!(approved.value()["user_code"], user_code);

    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let token = poll(&h, &app, created["device_code"].as_str().unwrap()).await;
    assert_eq!(token.status, StatusCode::OK, "{}", token.text());
    let tokens = token.value();
    assert!(tokens["access_token"].as_str().unwrap().starts_with("oat_"));
    let claims = decode_claims(tokens["id_token"].as_str().unwrap());
    assert_eq!(claims["sub"], browser.user.id);
    assert_eq!(claims["email"], "user@example.com");

    let replay = poll(&h, &app, created["device_code"].as_str().unwrap()).await;
    assert_eq!(replay.value()["error"], "expired_token");
}

#[tokio::test]
async fn public_clients_work_without_a_secret() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "name": "Public", "public": true }))
        .await;
    assert!(app.get("client_secret").is_none());
    let created = start_device(&h, &app).await;
    let user_code = created["user_code"].as_str().unwrap();
    browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let token = poll(&h, &app, created["device_code"].as_str().unwrap()).await;
    assert_eq!(token.status, StatusCode::OK, "{}", token.text());
}

#[tokio::test]
async fn slow_down_permanently_widens_the_interval() {
    let h = harness().await;
    enable_device(&h).await;
    insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let device_code = created["device_code"].as_str().unwrap();
    poll(&h, &app, device_code).await;
    let too_fast = poll(&h, &app, device_code).await;
    assert_eq!(too_fast.value()["error"], "slow_down");
    assert_eq!(too_fast.headers.get("retry-after").unwrap(), "6");
    let interval: i64 = sqlx::query_scalar("SELECT interval_seconds FROM device_codes")
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(interval, 6);
}

#[tokio::test]
async fn denial_expiry_and_foreign_client() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let denied = start_device(&h, &app).await;
    let user_code = denied["user_code"].as_str().unwrap();
    let response = browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "deny" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.value()["status"], "denied");
    let denied_poll = poll(&h, &app, denied["device_code"].as_str().unwrap()).await;
    assert_eq!(denied_poll.value()["error"], "access_denied");

    let expired = start_device(&h, &app).await;
    sqlx::query("UPDATE device_codes SET expires_at = $1 WHERE user_code = $2")
        .bind(orbitid_core::http::now() - 1_000)
        .bind(expired["user_code"].as_str().unwrap().replace('-', ""))
        .execute(&h.state().pool)
        .await
        .unwrap();
    let expired_poll = poll(&h, &app, expired["device_code"].as_str().unwrap()).await;
    assert_eq!(expired_poll.value()["error"], "expired_token");

    let foreign = start_device(&h, &app).await;
    let other = h.create_app(json!({ "name": "Other" })).await;
    let foreign_poll = poll(&h, &other, foreign["device_code"].as_str().unwrap()).await;
    assert_eq!(foreign_poll.value()["error"], "expired_token");
}

#[tokio::test]
async fn approval_requires_a_session_and_is_single_use() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let user_code = created["user_code"].as_str().unwrap();

    let signed_out = h
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await;
    assert_eq!(signed_out.status, StatusCode::UNAUTHORIZED);
    let info = h
        .client
        .get(
            &format!("/v1/client/oauth/device?user_code={user_code}"),
            &[],
        )
        .await;
    assert_eq!(info.status, StatusCode::UNAUTHORIZED);

    assert_eq!(
        browser
            .client
            .post(
                "/v1/client/oauth/device/approve",
                Some(json!({ "user_code": user_code, "action": "approve" })),
                &[],
            )
            .await
            .status,
        StatusCode::OK
    );
    let second = browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await;
    assert_eq!(second.status, StatusCode::CONFLICT);
    assert_eq!(second.value()["errors"][0]["code"], "verification_failed");
}

#[tokio::test]
async fn malformed_and_unknown_codes_are_rejected() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let bad = browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": "nope", "action": "approve" })),
            &[],
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    let unknown = browser
        .client
        .get("/v1/client/oauth/device?user_code=BCDF-2345", &[])
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn brute_force_budget_burns_the_code() {
    let h = harness().await;
    enable_device(&h).await;
    settings(&h, json!({ "security": { "rateLimitEnabled": true } })).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let user_code = created["user_code"].as_str().unwrap().to_string();

    let mut status = StatusCode::OK;
    for _ in 0..=common::DEVICE_ATTEMPT_BUDGET {
        status = browser
            .client
            .get(
                &format!("/v1/client/oauth/device?user_code={user_code}"),
                &[],
            )
            .await
            .status;
    }
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let stored: String = sqlx::query_scalar("SELECT status FROM device_codes WHERE user_code = $1")
        .bind(user_code.replace('-', ""))
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(stored, "denied");
    assert_eq!(
        browser
            .client
            .post(
                "/v1/client/oauth/device/approve",
                Some(json!({ "user_code": user_code, "action": "approve" })),
                &[],
            )
            .await
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    let denied = poll(&h, &app, created["device_code"].as_str().unwrap()).await;
    assert_eq!(denied.value()["error"], "access_denied");
}

#[tokio::test]
async fn verification_page_is_csp_safe_and_escaped() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let user_code = created["user_code"].as_str().unwrap();

    let page = send(
        &h.router,
        Method::GET,
        &format!("/oauth/device?user_code={user_code}"),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    let csp = page
        .headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.contains("default-src 'none'"));
    let html = page.text();
    assert!(html.contains("Test App"));
    assert!(html.contains("openid"));
    assert!(html.contains("class=\"decision-form\""));
    assert!(html.contains("value=\"approve\""));
    assert!(html.contains("value=\"deny\""));
    assert!(html.contains("OrbitID App"));
    assert!(!html.contains("<script>"));
    assert!(html.contains("/oauth/device.js"));

    let signed_out = h.client.get("/oauth/device", &[]).await;
    let html = signed_out.text();
    assert!(html.contains("/sign-in"));
    assert!(html.contains("Sign in"));
    assert!(!html.contains("Test App"));
    let signed_out_with_code = h
        .client
        .get(&format!("/oauth/device?user_code={user_code}"), &[])
        .await;
    let html = signed_out_with_code.text();
    assert!(html.contains("Test App"));
    assert!(html.contains("/sign-in"));
    assert!(html.contains(&format!("user_code%3D{user_code}")));

    let js = h.client.get("/oauth/device.js", &[]).await;
    assert_eq!(js.status, StatusCode::OK);
    assert!(js
        .headers
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert_eq!(js.headers.get("x-content-type-options").unwrap(), "nosniff");
    let css = h.client.get("/oauth/device.css", &[]).await;
    assert_eq!(css.status, StatusCode::OK);
    assert!(css.text().contains("Hanken Grotesk Variable"));
}

#[tokio::test]
async fn page_approves_denies_and_refuses_cross_site_posts() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h.create_app(json!({})).await;

    let first = start_device(&h, &app).await;
    let page = send(
        &h.router,
        Method::POST,
        "/oauth/device",
        Body::from(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("user_code", first["user_code"].as_str().unwrap()),
                    ("action", "approve"),
                ])
                .finish(),
        ),
        &[
            ("content-type", "application/x-www-form-urlencoded"),
            ("cookie", &browser.cookie),
        ],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text().contains("Device connected"));

    let second = start_device(&h, &app).await;
    let page = send(
        &h.router,
        Method::POST,
        "/oauth/device",
        Body::from(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("user_code", second["user_code"].as_str().unwrap()),
                    ("action", "deny"),
                ])
                .finish(),
        ),
        &[
            ("content-type", "application/x-www-form-urlencoded"),
            ("cookie", &browser.cookie),
        ],
    )
    .await;
    assert_eq!(page.status, StatusCode::OK);
    assert!(page.text().contains("Request denied"));
    let denied = poll(&h, &app, second["device_code"].as_str().unwrap()).await;
    assert_eq!(denied.value()["error"], "access_denied");

    // A signed-out POST changes nothing.
    let signed_out = send(
        &h.router,
        Method::POST,
        "/oauth/device",
        Body::from(
            url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("user_code", first["user_code"].as_str().unwrap()),
                    ("action", "approve"),
                ])
                .finish(),
        ),
        &[("content-type", "application/x-www-form-urlencoded")],
    )
    .await;
    assert_eq!(signed_out.status, StatusCode::OK);
    assert!(signed_out.text().contains("/sign-in"));

    // Cross-site form posts are refused.
    let third = start_device(&h, &app).await;
    for headers in [
        vec![
            ("content-type", "application/x-www-form-urlencoded"),
            ("cookie", browser.cookie.as_str()),
            ("origin", "https://evil.example"),
        ],
        vec![
            ("content-type", "application/x-www-form-urlencoded"),
            ("cookie", browser.cookie.as_str()),
            ("sec-fetch-site", "cross-site"),
        ],
    ] {
        let refused = send(
            &h.router,
            Method::POST,
            "/oauth/device",
            Body::from(
                url::form_urlencoded::Serializer::new(String::new())
                    .extend_pairs([
                        ("user_code", third["user_code"].as_str().unwrap()),
                        ("action", "approve"),
                    ])
                    .finish(),
            ),
            &headers,
        )
        .await;
        assert_eq!(refused.status, StatusCode::FORBIDDEN);
        assert!(refused.text().contains("blocked"));
    }
    let info = browser
        .client
        .get(
            &format!(
                "/v1/client/oauth/device?user_code={}",
                third["user_code"].as_str().unwrap()
            ),
            &[],
        )
        .await;
    assert_eq!(info.value()["status"], "pending");
}

#[tokio::test]
async fn page_escapes_application_name_and_code() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "user@example.com").await;
    let app = h
        .create_app(json!({ "name": "<script>alert('x')</script>" }))
        .await;
    let created = start_device(&h, &app).await;
    let page = send(
        &h.router,
        Method::GET,
        &format!(
            "/oauth/device?user_code={}",
            created["user_code"].as_str().unwrap()
        ),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    let html = page.text();
    assert!(!html.contains("<script>alert"));
    assert!(html.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));

    let injected = h
        .client
        .get(
            &format!(
                "/oauth/device?{}",
                url::form_urlencoded::Serializer::new(String::new())
                    .append_pair("user_code", "\"><script>alert(1)</script>")
                    .finish()
            ),
            &[],
        )
        .await;
    assert!(!injected.text().contains("<script>alert(1)"));
}

#[tokio::test]
async fn a_failed_token_insert_does_not_consume_the_device_code() {
    let h = harness().await;
    enable_device(&h).await;
    let browser = insert_user(&h, "device-rollback@example.com").await;
    let app = h.create_app(json!({})).await;
    let created = start_device(&h, &app).await;
    let device_code = created["device_code"].as_str().unwrap().to_string();
    let user_code = created["user_code"].as_str().unwrap().to_string();
    let approved = browser
        .client
        .post(
            "/v1/client/oauth/device/approve",
            Some(json!({ "user_code": user_code, "action": "approve" })),
            &[],
        )
        .await;
    assert_eq!(approved.status, StatusCode::OK, "{}", approved.text());
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;

    // The claim and the token rows are one transaction: a failed insert must
    // leave the approval claimable.
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_grant() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected grant failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&h.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_grant BEFORE INSERT ON oauth_grants \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_grant()",
    )
    .execute(&h.state().pool)
    .await
    .expect("trigger");
    let failed = poll(&h, &app, &device_code).await;
    assert!(
        failed.status.is_server_error() || failed.status == StatusCode::BAD_REQUEST,
        "unexpected success: {}",
        failed.text()
    );
    let status: String = sqlx::query_scalar("SELECT status FROM device_codes WHERE user_code = $1")
        .bind(user_code.replace('-', ""))
        .fetch_one(&h.state().pool)
        .await
        .expect("device code");
    assert_eq!(
        status, "approved",
        "the claim must roll back with the insert"
    );

    sqlx::query("DROP TRIGGER orbitid_test_fail_grant ON oauth_grants")
        .execute(&h.state().pool)
        .await
        .expect("drop trigger");
    tokio::time::sleep(std::time::Duration::from_millis(1_100)).await;
    let token = poll(&h, &app, &device_code).await;
    assert_eq!(token.status, StatusCode::OK, "{}", token.text());
    assert!(token.value()["access_token"]
        .as_str()
        .unwrap()
        .starts_with("oat_"));
}
