//! Composition-level HTTP security checks ported from the TypeScript suite
//! (`client-ip`, `redirects`, `auth-surface`, `http-body`).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use orbitid_core::config::EnvOverrides;
use orbitid_core::testing::TestClient;
use orbitid_identity::testing::test_app_state_with;
use tower::ServiceExt;

mod common;

/// Behind a trusted proxy the rate-limit key follows the forwarded hop, so one
/// abusive client cannot lock out another.
#[tokio::test]
async fn trusted_proxy_forwarded_for_separates_rate_limit_buckets() {
    let app = test_app_state_with(EnvOverrides {
        trust_proxy: Some(1),
        ..Default::default()
    })
    .await;
    let client = TestClient::new(orbitid_server::build_app(app.app_state()));
    for _ in 0..10 {
        let response = client
            .get(
                "/v1/users",
                &[
                    ("authorization", "Bearer sk_test_wrong"),
                    ("x-forwarded-for", "203.0.113.10"),
                ],
            )
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    }
    let blocked = client
        .get(
            "/v1/users",
            &[
                ("authorization", "Bearer sk_test_wrong"),
                ("x-forwarded-for", "203.0.113.10"),
            ],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);

    let other = client
        .get(
            "/v1/users",
            &[
                ("authorization", "Bearer sk_test_wrong"),
                ("x-forwarded-for", "203.0.113.11"),
            ],
        )
        .await;
    assert_eq!(other.status, StatusCode::UNAUTHORIZED, "{}", other.text());
}

#[tokio::test]
async fn handshake_refuses_foreign_redirect_origins() {
    let app = test_app_state_with(EnvOverrides::default()).await;
    let client = TestClient::new(orbitid_server::build_app(app.app_state()));
    for target in [
        "https://evil.example/steal",
        "javascript:alert(1)",
        "//evil.example",
    ] {
        let path = format!(
            "/v1/client/handshake?redirect_url={}",
            url::form_urlencoded::byte_serialize(target.as_bytes()).collect::<String>()
        );
        let response = client.get(&path, &[]).await;
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "{target}");
        assert_eq!(
            response.value()["errors"][0]["code"],
            "form_param_format_invalid",
            "{target}"
        );
    }
}

/// Every Backend API operation refuses a missing secret key before doing
/// anything else, including the routes with a path parameter.
#[tokio::test]
async fn backend_surface_requires_the_secret_key() {
    // A unique forwarded IP per request keeps the failure budget from tripping:
    // this test is about the guard, not the rate limiter.
    let app = test_app_state_with(EnvOverrides {
        trust_proxy: Some(1),
        ..Default::default()
    })
    .await;
    let spec: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/openapi.json")).expect("openapi");
    let public = [
        "/v1/client",
        "/v1/verify",
        "/v1/oauth_callback",
        "/v1/saml",
        "/v1/operator_sessions",
        "/v1/openapi.json",
        "/v1/jwks",
    ];
    let mut checked = 0;
    for (path, operations) in spec["paths"].as_object().expect("paths") {
        if !path.starts_with("/v1/") || public.iter().any(|prefix| path.starts_with(prefix)) {
            continue;
        }
        let concrete = path
            .split('/')
            .map(|part| if part.starts_with('{') { "x" } else { part })
            .collect::<Vec<_>>()
            .join("/");
        let method = if operations.get("post").is_some() {
            "POST"
        } else {
            "GET"
        };
        checked += 1;
        let body = (method == "POST").then(|| Body::from("{}"));
        let request = Request::builder()
            .method(method)
            .uri(&concrete)
            .header("content-type", "application/json")
            .header("x-forwarded-for", format!("198.51.100.{}", checked % 250))
            .body(body.unwrap_or_else(Body::empty))
            .expect("request");
        let response = orbitid_server::build_app(app.app_state())
            .oneshot(request)
            .await
            .expect("router");
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path}"
        );
    }
    assert!(checked > 50, "checked only {checked} backend operations");
}

/// Streamed bodies over the cap are refused by the composed server, not only by
/// the core extractor unit tests.
#[tokio::test]
async fn oversized_streamed_bodies_are_refused() {
    let app = test_app_state_with(EnvOverrides::default()).await;
    let body = Body::from(vec![b'a'; 2 * 1024 * 1024]);
    let request = Request::builder()
        .method("POST")
        .uri("/v1/client/sign_ups")
        .header("content-type", "application/json")
        .body(body)
        .expect("request");
    let response = orbitid_server::build_app(app.app_state())
        .oneshot(request)
        .await
        .expect("router");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
