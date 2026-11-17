//! Every OIDC flow on a pool of one connection: any handler that acquires a
//! second connection inside its transaction times out here.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::config::EnvOverrides;
use orbitid_core::testing::TestClient;
use orbitid_identity::testing::test_app_state_with;
use serde_json::json;

async fn single_connection_harness() -> Harness {
    let app = test_app_state_with(EnvOverrides {
        db_max_connections: Some(1),
        db_acquire_timeout_ms: Some(2_000),
        ..Default::default()
    })
    .await;
    let router = build_app(app.state());
    let client = TestClient::new(router.clone());
    Harness {
        app,
        router,
        client,
    }
}

#[tokio::test]
async fn oidc_flows_work_on_a_single_connection_pool() {
    let h = single_connection_harness().await;
    settings(
        &h,
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
    let browser = insert_user(&h, "pool-oidc@example.com").await;

    // Application creation, authorization code + PKCE exchange, and refresh.
    let app = h.create_app(json!({})).await;
    let flow = code_flow(&h, &browser, &app, "openid email offline_access").await;
    assert!(flow.tokens["access_token"]
        .as_str()
        .unwrap()
        .starts_with("oat_"));
    let refresh = flow.tokens["refresh_token"].as_str().unwrap();
    let rotated = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", app["client_id"].as_str().unwrap_or_default()),
                (
                    "client_secret",
                    app["client_secret"].as_str().unwrap_or_default(),
                ),
            ],
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.text());

    // Device flow: issue, approve, poll (the claim + token rows are one
    // transaction).
    let device = h
        .form(
            "/oauth/device_authorization",
            &[
                ("client_id", app["client_id"].as_str().unwrap_or_default()),
                (
                    "client_secret",
                    app["client_secret"].as_str().unwrap_or_default(),
                ),
                ("scope", "openid email"),
            ],
        )
        .await;
    assert_eq!(device.status, StatusCode::OK, "{}", device.text());
    let user_code = device.value()["user_code"]
        .as_str()
        .expect("user code")
        .to_string();
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
    let token = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                (
                    "device_code",
                    device.value()["device_code"].as_str().unwrap_or_default(),
                ),
                ("client_id", app["client_id"].as_str().unwrap_or_default()),
                (
                    "client_secret",
                    app["client_secret"].as_str().unwrap_or_default(),
                ),
            ],
        )
        .await;
    assert_eq!(token.status, StatusCode::OK, "{}", token.text());

    // Backend API keys: create and verify.
    let key = h
        .post(
            "/v1/api_keys",
            json!({ "name": "pool", "subject": browser.user.id }),
        )
        .await;
    assert_eq!(key.status, StatusCode::CREATED, "{}", key.text());
    let verified = h
        .post(
            "/v1/api_keys/verify",
            json!({ "secret": key.value()["secret"].as_str().unwrap_or_default() }),
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());

    // M2M machine and opaque token.
    let machine = h.post("/v1/m2m/machines", json!({ "name": "pool" })).await;
    assert_eq!(machine.status, StatusCode::CREATED, "{}", machine.text());
    let machine_id = machine.value()["id"]
        .as_str()
        .expect("machine id")
        .to_string();
    let m2m = h
        .post(
            "/v1/m2m/tokens",
            json!({ "machine_id": machine_id, "seconds_until_expiration": 600 }),
        )
        .await;
    assert_eq!(m2m.status, StatusCode::CREATED, "{}", m2m.text());
    let claim = h
        .post(
            "/v1/m2m/tokens/verify",
            json!({ "token": m2m.value()["token"].as_str().unwrap_or_default() }),
        )
        .await;
    assert_eq!(claim.status, StatusCode::OK, "{}", claim.text());
}
