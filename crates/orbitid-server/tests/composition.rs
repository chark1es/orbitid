//! Composition guarantees: the routers from every feature crate actually merge,
//! and every operation in the committed OpenAPI document is routed.
//!
//! The document is the frozen wire contract (`docs/openapi.json`), so this is
//! the drift test the TypeScript app has: a new documented path without a route
//! fails here instead of surprising a client at runtime.

use axum::http::StatusCode;
use orbitid_core::testing::{test_state, TestClient};
use serde_json::{json, Value};

/// The committed specification, embedded like the `/v1/openapi.json` route does.
const SPEC: &str = include_str!("../../../docs/openapi.json");

/// Replaces `{param}` and `{*rest}` placeholders with a plausible concrete value.
fn concrete(path: &str) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &rest[start + 1..start + end];
        let value = match name {
            "file" => "x.png",
            "provider" => "google",
            _ => "x",
        };
        out.push_str(value);
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out
}

fn has_trace_id(value: &Value) -> bool {
    value.get("trace_id").is_some_and(|trace| !trace.is_null())
}

/// A routed operation must not answer 405, and a 404 must come from a handler
/// (which carries a trace id) rather than from the route-not-found fallback.
fn routed(status: StatusCode, body: &Value) -> bool {
    status != StatusCode::METHOD_NOT_ALLOWED
        && !(status == StatusCode::NOT_FOUND && !has_trace_id(body))
}

#[tokio::test]
async fn discovery_is_served_at_any_prefix_depth() {
    let ctx = test_state().await;
    let client = TestClient::new(orbitid_server::build_app(ctx.state.clone()));
    for path in [
        "/tenant/.well-known/openid-configuration",
        "/tenants/acme/prod/.well-known/openid-configuration",
        "/tenants/acme/prod/.well-known/oauth-authorization-server",
        "/tenants/acme/.well-known/oauth-authorization-server/issuer/path",
    ] {
        let response = client.get(path, &[]).await;
        assert_eq!(response.status, StatusCode::OK, "{path}");
        assert_eq!(
            response.value()["issuer"].as_str(),
            Some(ctx.state.env.base_url.as_str()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn every_documented_operation_is_routed() {
    let ctx = test_state().await;
    // The device page is feature-gated (and answers 404, like the TS route, when
    // disabled). Enable it so the probe reaches the handler.
    ctx.state
        .settings
        .update(json!({ "oidcProvider": { "deviceAuthorizationEnabled": true } }))
        .await
        .expect("enable device authorization");
    let client = TestClient::new(orbitid_server::build_app(ctx.state.clone()));
    let spec: Value = serde_json::from_str(SPEC).expect("openapi.json");
    let paths = spec["paths"].as_object().expect("paths");

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for (path, operations) in paths {
        let url = concrete(path);
        for method in ["get", "post", "put", "patch", "delete"] {
            if operations.get(method).is_none() {
                continue;
            }
            checked += 1;
            let body = match method {
                "post" | "put" | "patch" => Some(json!({})),
                _ => None,
            };
            let method_upper = method.to_uppercase();
            let response = client
                .request(
                    &method_upper,
                    &url,
                    body,
                    &[("authorization", "Bearer sk_test_testsecret")],
                )
                .await;
            let value: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
            if !routed(response.status, &value) {
                failures.push(format!(
                    "{} {} -> {} {}",
                    method.to_uppercase(),
                    path,
                    response.status,
                    response.text()
                ));
            }
        }
    }
    assert!(checked > 300, "expected a large table, got {checked}");
    assert!(
        failures.is_empty(),
        "{} documented operations are not routed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The openapi document and the docs page are public; docs assets carry the
/// strict CSP the TypeScript server sets.
#[tokio::test]
async fn docs_serve_the_embedded_viewer() {
    let ctx = test_state().await;
    let client = TestClient::new(orbitid_server::build_app(ctx.state.clone()));

    let index = client.get("/docs", &[]).await;
    assert_eq!(index.status, StatusCode::OK);
    assert!(index.text().contains("OrbitID API reference"));
    let csp = index
        .headers
        .get("content-security-policy")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(csp.contains("script-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));

    let script = client.get("/docs/assets/viewer/page.js", &[]).await;
    assert_eq!(script.status, StatusCode::OK);
    assert_eq!(
        script.headers.get("content-type").unwrap(),
        "text/javascript; charset=utf-8"
    );
    let css = client.get("/docs/assets/viewer.css", &[]).await;
    assert_eq!(css.status, StatusCode::OK);
    assert_eq!(
        css.headers.get("content-type").unwrap(),
        "text/css; charset=utf-8"
    );
    let missing = client.get("/docs/assets/nope.js", &[]).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);

    // The embedded specification rewrites the server URL to this instance.
    let spec = client.get("/v1/openapi.json", &[]).await;
    assert_eq!(spec.status, StatusCode::OK);
    assert_eq!(spec.value()["servers"][0]["url"], "http://localhost:4000");
    assert!(spec.value()["paths"]["/v1/users"].is_object());
}

/// `/health` stays dependency-free and `/ready` proves database reachability.
#[tokio::test]
async fn health_and_readiness() {
    let ctx = test_state().await;
    let client = TestClient::new(orbitid_server::build_app(ctx.state.clone()));
    let health = client.get("/health", &[]).await;
    assert_eq!(health.status, StatusCode::OK);
    assert_eq!(health.value()["status"], "ok");
    assert_eq!(health.value()["publishable_key"], ctx.state.publishable_key);
    let ready = client.get("/ready", &[]).await;
    assert_eq!(ready.status, StatusCode::OK);
    assert_eq!(ready.value()["status"], "ready");
}
