//! End-to-end checks of the composed app: boot, headers, CORS, CSRF, body caps,
//! the 404/error wire formats, the dashboard and the OpenAPI endpoint.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::http::StatusCode;
use axum::Router;
use serde_json::json;

use orbitid_core::config::EnvOverrides;
use orbitid_core::testing::{test_state, test_state_with, TestClient};

fn app(state: orbitid_core::AppState) -> Router {
    orbitid_server::build_app(state)
}

#[tokio::test]
async fn health_and_secret_key_guard() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let health = client.get("/health", &[]).await;
    assert_eq!(health.status, StatusCode::OK);
    let body = health.value();
    assert_eq!(body["status"], "ok");
    assert_eq!(body["publishable_key"], ctx.state.publishable_key);
    assert_eq!(body["database"], "postgres");
    assert_eq!(body["database_driver"], "postgres");

    let unauthenticated = client.get("/v1/users", &[]).await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);
    let body = unauthenticated.value();
    assert_eq!(body["errors"][0]["code"], "secret_key_invalid");
    assert_eq!(body["errors"][0]["message"], "Invalid secret key");
    assert!(body["errors"][0]["long_message"].is_string());
    assert!(body["trace_id"].is_string());

    assert_eq!(client.get("/nope", &[]).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn baseline_headers_are_on_every_response() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    for path in ["/health", "/v1/client", "/nope"] {
        let response = client.get(path, &[]).await;
        assert_eq!(
            response.headers.get("x-content-type-options").unwrap(),
            "nosniff"
        );
        assert_eq!(
            response.headers.get("referrer-policy").unwrap(),
            "no-referrer"
        );
        assert_eq!(response.headers.get("x-frame-options").unwrap(), "DENY");
        let permissions = response
            .headers
            .get("permissions-policy")
            .unwrap()
            .to_str()
            .unwrap();
        for feature in ["camera=()", "microphone=()", "geolocation=()"] {
            assert!(permissions.contains(feature));
        }
        assert!(response.headers.get("strict-transport-security").is_none());
    }
    // API responses that may carry personal data are never cached.
    let api = client.get("/v1/client", &[]).await;
    assert_eq!(api.headers.get("cache-control").unwrap(), "no-store");
    assert!(client
        .get("/health", &[])
        .await
        .headers
        .get("cache-control")
        .is_none());
}

#[tokio::test]
async fn hsts_is_only_sent_over_https() {
    let ctx = test_state_with(EnvOverrides {
        base_url: Some("https://auth.example.com".into()),
        ..Default::default()
    })
    .await;
    let client = TestClient::new(app(ctx.state.clone()));
    let response = client.get("/health", &[]).await;
    assert!(response
        .headers
        .get("strict-transport-security")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("max-age=31536000"));
}

#[tokio::test]
async fn cors_allows_configured_origins_only() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let allowed = client
        .request(
            "OPTIONS",
            "/v1/client",
            None,
            &[
                ("origin", "http://localhost:3000"),
                ("access-control-request-method", "POST"),
            ],
        )
        .await;
    assert_eq!(allowed.status, StatusCode::NO_CONTENT);
    assert_eq!(
        allowed.headers.get("access-control-allow-origin").unwrap(),
        "http://localhost:3000"
    );
    assert_eq!(
        allowed
            .headers
            .get("access-control-allow-credentials")
            .unwrap(),
        "true"
    );
    assert_eq!(
        allowed
            .headers
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Origin"),
        "allowed CORS responses must vary on Origin"
    );

    let denied = client
        .request(
            "OPTIONS",
            "/v1/client",
            None,
            &[("origin", "https://evil.example")],
        )
        .await;
    assert!(denied.headers.get("access-control-allow-origin").is_none());
    // Hono's `cors` appends `Vary: Origin` for unallowed origins too.
    assert_eq!(
        denied
            .headers
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Origin"),
        "denied CORS responses must still vary on Origin"
    );

    let plain = client
        .get("/health", &[("origin", "https://evil.example")])
        .await;
    assert_eq!(plain.status, StatusCode::OK);
    assert!(plain.headers.get("access-control-allow-origin").is_none());
    assert_eq!(
        plain
            .headers
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Origin"),
        "non-preflight CORS evaluations must vary on Origin"
    );

    // Hono appends `Vary: Origin` even when the request carries no Origin at
    // all, so a shared cache never serves a CORS response to a non-CORS client.
    let no_origin = client.get("/health", &[]).await;
    assert_eq!(no_origin.status, StatusCode::OK);
    assert!(no_origin
        .headers
        .get("access-control-allow-origin")
        .is_none());
    assert_eq!(
        no_origin
            .headers
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Origin"),
        "requests without an Origin must still vary on Origin"
    );

    let preflight_without_origin = client.request("OPTIONS", "/v1/client", None, &[]).await;
    assert_eq!(preflight_without_origin.status, StatusCode::NO_CONTENT);
    assert_eq!(
        preflight_without_origin
            .headers
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Origin"),
        "a preflight without an Origin must still vary on Origin"
    );
}

#[tokio::test]
async fn csrf_blocks_cross_site_cookie_requests() {
    let ctx = test_state().await;
    let client = TestClient::with_cookie(app(ctx.state.clone()), "__client=opaque");

    let blocked = client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": "Mallory" })),
            &[
                ("origin", "https://evil.example"),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);
    assert_eq!(blocked.value()["errors"][0]["code"], "not_allowed_access");

    // Referer fallback also blocks.
    let blocked = client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({})),
            &[
                ("referer", "https://evil.example/form"),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);

    // A cross-site POST flagged by Sec-Fetch-Site needs no Origin.
    let blocked = client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({})),
            &[("sec-fetch-site", "cross-site")],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);

    // The instance's own origin is trusted; the route itself does not exist yet.
    let allowed = client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({})),
            &[
                ("origin", "http://localhost:4000"),
                ("sec-fetch-site", "same-origin"),
            ],
        )
        .await;
    assert_ne!(allowed.status, StatusCode::FORBIDDEN);

    // No cookie: the CSRF guard does not apply.
    let anonymous = TestClient::new(app(ctx.state.clone()));
    let response = anonymous
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({})),
            &[
                ("origin", "https://evil.example"),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_ne!(response.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn configured_origin_and_production_mode() {
    let ctx = test_state().await;
    ctx.state
        .settings
        .update(json!({ "application": { "allowedOrigins": ["https://app.example.com"] } }))
        .await
        .unwrap();
    let client = TestClient::with_cookie(app(ctx.state.clone()), "__client=opaque");
    let allowed = client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({})),
            &[
                ("origin", "https://app.example.com"),
                ("sec-fetch-site", "same-site"),
            ],
        )
        .await;
    assert_ne!(allowed.status, StatusCode::FORBIDDEN);

    // In production the local development origin is not trusted.
    let production = test_state_with(EnvOverrides {
        node_env: Some("production".into()),
        base_url: Some("https://auth.example.com".into()),
        secret_key: Some("sk_test_production_0123456789abcdef".into()),
        encryption_key: Some("p".repeat(40)),
        ..Default::default()
    })
    .await;
    assert!(!production.state.settings.get().application.development_mode);
    let client = TestClient::with_cookie(app(production.state.clone()), "__client=opaque");
    let blocked = client
        .request(
            "POST",
            "/v1/client",
            Some(json!({ "identifier": "someone@example.com" })),
            &[
                ("origin", "http://localhost:5173"),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn request_body_caps_and_query_secret_keys() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let too_large = client
        .request(
            "POST",
            "/v1/client/sign_ins",
            Some(json!({})),
            &[("content-length", &(6 * 1024 * 1024).to_string())],
        )
        .await;
    assert_eq!(too_large.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        too_large.value()["errors"][0]["code"],
        "request_body_invalid"
    );
    assert_eq!(
        too_large
            .headers
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap(),
        "application/json"
    );

    for query in ["secret_key", "api_key", "token"] {
        let response = client
            .get(&format!("/v1/users?{query}=sk_test_testsecret"), &[])
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "{query}");
        assert_eq!(
            response.value()["errors"][0]["message"],
            "Send the secret key in the Authorization header, never in the query string"
        );
    }
}

#[tokio::test]
async fn secret_key_failures_are_rate_limited() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let mut last = None;
    for _ in 0..12 {
        let response = client
            .get("/v1/users", &[("authorization", "Bearer sk_test_wrong")])
            .await;
        last = Some(response);
    }
    let response = last.unwrap();
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.value()["errors"][0]["code"], "rate_limit_exceeded");
    assert!(response.headers.get("retry-after").is_some());
}

#[tokio::test]
async fn not_found_body_has_no_trace_id() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let response = client.get("/definitely-missing", &[]).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    let body = response.value();
    assert_eq!(body["errors"][0]["code"], "resource_not_found");
    assert_eq!(body["errors"][0]["message"], "Route not found");
    assert!(body.get("trace_id").is_none());
    assert!(body["errors"][0].get("long_message").is_none());
}

#[tokio::test]
async fn dashboard_serves_index_with_nonce_and_assets() {
    let dir = std::env::temp_dir().join(format!(
        "orbitid-dashboard-{}",
        orbitid_core::crypto::random_token(6)
    ));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(
        dir.join("index.html"),
        "<html><head><title>OrbitID</title><script>window.__theme=\"dark\"</script></head><body><div id=root></div></body></html>",
    )
    .unwrap();
    std::fs::write(dir.join("assets/app-abc123.js"), "console.log('dashboard')").unwrap();
    let ctx = test_state_with(EnvOverrides {
        dashboard_dir: Some(dir.clone()),
        ..Default::default()
    })
    .await;
    let client = TestClient::new(app(ctx.state.clone()));

    let response = client.get("/", &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    let csp = response
        .headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    for fragment in [
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "img-src 'self' data: https:",
        "style-src 'self' 'unsafe-inline'",
    ] {
        assert!(csp.contains(fragment), "{fragment}");
    }
    let nonce = csp
        .split("'nonce-")
        .nth(1)
        .unwrap()
        .split('\'')
        .next()
        .unwrap()
        .to_string();
    let html = response.text();
    assert!(html.contains(&format!("<script nonce=\"{nonce}\">window.__theme")));
    assert!(html.contains("window.__ORBITID__="));
    assert!(html.contains("\"publishableKey\""));
    assert!(!html.contains("nonce=") || !html.contains("src=\"/x\""));

    let asset = client.get("/assets/app-abc123.js", &[]).await;
    assert_eq!(asset.status, StatusCode::OK);
    assert_eq!(
        asset.headers.get("content-type").unwrap(),
        "text/javascript; charset=utf-8"
    );
    assert!(asset
        .headers
        .get("cache-control")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("immutable"));

    // API paths are never served by the dashboard fallback. Like the TS backend
    // sub-app, the whole `/v1` mount point is guarded, so an unknown path is a
    // 401 without a key and a JSON 404 with one.
    let api = client.get("/v1/missing", &[]).await;
    assert_eq!(api.status, StatusCode::UNAUTHORIZED);
    assert_eq!(api.value()["errors"][0]["code"], "secret_key_invalid");
    let api = client
        .get(
            "/v1/missing",
            &[("authorization", "Bearer sk_test_testsecret")],
        )
        .await;
    assert_eq!(api.status, StatusCode::NOT_FOUND);
    assert_eq!(api.value()["errors"][0]["code"], "resource_not_found");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn openapi_and_docs_are_public() {
    let ctx = test_state().await;
    let client = TestClient::new(app(ctx.state.clone()));
    let spec = client.get("/v1/openapi.json", &[]).await;
    assert_eq!(spec.status, StatusCode::OK);
    assert_eq!(
        spec.headers.get("cache-control").unwrap(),
        "public, max-age=300"
    );
    assert_eq!(spec.value()["openapi"], "3.1.0");
    let docs = client.get("/docs", &[]).await;
    assert_eq!(docs.status, StatusCode::OK);
    assert!(docs
        .headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("frame-ancestors 'none'"));
}
