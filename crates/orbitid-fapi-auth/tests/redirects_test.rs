//! Ported from `test/redirects.test.ts`: post-auth redirects resolve against
//! the application origin and refuse every open-redirect shape.

mod common;

use axum::http::StatusCode;
use common::harness;

async fn configured() -> common::Harness {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({
            "application": {
                "homeUrl": "https://app.example.com",
                "allowedOrigins": ["https://app.example.com"],
                "allowedRedirectOrigins": [],
                "developmentMode": false,
            },
            "security": { "enumerationProtection": true },
        }))
        .await
        .unwrap();
    h
}

async fn sign_in_with_redirect(h: &common::Harness, redirect: &str) -> axum::http::StatusCode {
    h.client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "nobody@example.com",
                "redirect_url": redirect,
            })),
            &[],
        )
        .await
        .status
}

#[tokio::test]
async fn paths_and_allowed_origins_are_accepted() {
    let h = configured().await;
    for value in [
        "/dashboard?x=1",
        "https://app.example.com/after",
        "https://app.example.com",
    ] {
        let status = sign_in_with_redirect(&h, value).await;
        // Enumeration protection makes the unknown account a 200; the redirect itself was fine.
        assert_eq!(status, StatusCode::OK, "{value}");
    }
}

/// The dashboard is served by the instance itself, so an operator signing in
/// to the console (SSO, social) comes back to the instance's own origin even
/// when it is not one of the application origins.
#[tokio::test]
async fn the_instances_own_origin_is_accepted() {
    let h = configured().await;
    for value in ["http://localhost:4000/login", "http://localhost:4000"] {
        assert_eq!(
            sign_in_with_redirect(&h, value).await,
            StatusCode::OK,
            "{value}"
        );
    }
    // Another port on the same host is a different origin.
    assert_eq!(
        sign_in_with_redirect(&h, "http://localhost:4001/login").await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn every_open_redirect_shape_is_refused() {
    let h = configured().await;
    for value in [
        "https://evil.example/x",
        "//evil.example/x",
        "/\\evil.example/x",
        "\\\\evil.example/x",
        "/\\/evil.example",
        "javascript:alert(1)",
        "http://app.example.com.evil.example/x",
    ] {
        let response = h
            .client
            .post(
                "/v1/client/sign_ins",
                Some(serde_json::json!({
                    "identifier": "nobody@example.com",
                    "redirect_url": value,
                })),
                &[],
            )
            .await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{value} -> {}",
            response.text()
        );
        assert_eq!(
            response.error_codes(),
            vec!["form_param_format_invalid"],
            "{value}"
        );
        assert_eq!(
            response.value()["errors"][0]["meta"]["param_name"],
            "redirect_url"
        );
    }
}

#[tokio::test]
async fn handshake_refuses_credentials_in_the_redirect() {
    let h = configured().await;
    h.client.get("/v1/client", &[]).await;
    let response = h
        .client
        .get(
            "/v1/client/handshake?redirect_url=https%3A%2F%2Fuser%3Apass%40app.example.com%2Fx",
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_codes(), vec!["form_param_format_invalid"]);
    assert!(response.headers.get("location").is_none());
}
