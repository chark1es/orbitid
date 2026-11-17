//! Shared helpers for the end-to-end tests against the fully composed server.

#![allow(dead_code)]

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{test_app_state, TestApp};
use serde_json::Value;
use std::path::PathBuf;
use tower::ServiceExt;

use orbitid_core::config::EnvOverrides;
use orbitid_core::state::create_context;

pub const SECRET_KEY: &str = "sk_test_testsecret";
pub const REDIRECT_URI: &str = "http://localhost:3000/callback";

pub struct E2e {
    pub app: TestApp,
    pub client: TestClient,
}

impl E2e {
    pub fn state(&self) -> &AppState {
        self.app.state()
    }

    pub async fn new() -> Self {
        let app = test_app_state().await;
        let client = TestClient::new(orbitid_server::build_app(app.app_state()));
        Self { app, client }
    }

    /// A second browser (or replica) with its own cookie jar.
    pub fn browser(&self) -> TestClient {
        TestClient::new(orbitid_server::build_app(self.app.app_state()))
    }

    /// A cookie jar seeded with an existing browser session.
    pub fn browser_with_cookie(&self, cookie: &str) -> TestClient {
        TestClient::with_cookie(orbitid_server::build_app(self.app.app_state()), cookie)
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        self.client.get(path, bearer()).await
    }

    pub async fn post(&self, path: &str, body: Value) -> TestResponse {
        self.client.post(path, Some(body), bearer()).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> TestResponse {
        self.client.patch(path, Some(body), bearer()).await
    }

    pub async fn delete(&self, path: &str) -> TestResponse {
        self.client.delete(path, None, bearer()).await
    }

    /// Form-urlencoded POST (OAuth protocol endpoints).
    pub async fn form(
        &self,
        client: &TestClient,
        path: &str,
        params: &[(&str, &str)],
    ) -> TestResponse {
        form_post(
            &orbitid_server::build_app(self.app.app_state()),
            client.cookie_header().as_deref(),
            path,
            params,
            &[],
        )
        .await
    }
}

pub fn bearer() -> &'static [(&'static str, &'static str)] {
    &[("authorization", "Bearer sk_test_testsecret")]
}

/// A second stateless replica against an existing database: its own `AppState`
/// (pool, settings store and listeners) with no shared in-process state, like a
/// second container behind a load balancer.
pub async fn replica_state(database_url: &str) -> AppState {
    let data_dir = std::env::temp_dir().join(format!(
        "orbitid-rs-replica-{}",
        orbitid_core::crypto::random_token(8)
    ));
    let state = create_context(orbitid_core::testing::with_test_pool_gate(EnvOverrides {
        database_url: Some(database_url.to_string()),
        secret_key: Some(SECRET_KEY.to_string()),
        base_url: Some("http://localhost:4000".to_string()),
        node_env: Some("test".to_string()),
        encryption_key: Some("test-encryption-key-for-orbitid-0123456789".to_string()),
        data_dir: Some(data_dir),
        dashboard_dir: Some(PathBuf::from("/nonexistent-dashboard")),
        ..Default::default()
    }))
    .await
    .expect("second replica context");
    orbitid_identity::install_without_workers(&state)
        .await
        .expect("install second replica");
    state
}

/// Form-urlencoded POST carrying optional browser cookies and extra headers.
pub async fn form_post(
    app: &axum::Router,
    cookie: Option<&str>,
    path: &str,
    params: &[(&str, &str)],
    headers: &[(&str, &str)],
) -> TestResponse {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    let mut map = HeaderMap::new();
    map.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            name.parse::<header::HeaderName>(),
            header::HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    if let Some(cookie) = cookie {
        if let Ok(value) = header::HeaderValue::from_str(cookie) {
            map.insert(header::COOKIE, value);
        }
    }
    send(app, Method::POST, path, Body::from(body), &map).await
}

pub async fn send(
    app: &axum::Router,
    method: Method,
    path: &str,
    body: Body,
    headers: &HeaderMap,
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    let request = builder.body(body).expect("request");
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .expect("body");
    TestResponse {
        status,
        headers,
        body,
    }
}

pub fn location(response: &TestResponse) -> String {
    response
        .headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

pub fn query_of(url: &str) -> std::collections::HashMap<String, String> {
    url::Url::parse(url)
        .map(|url| {
            url.query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn pkce_verifier() -> String {
    orbitid_core::crypto::random_token(32)
}

pub fn challenge_for(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub fn cookie_pair(response: &TestResponse, name: &str) -> Option<String> {
    response
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{name}=")))
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
}

pub fn assert_ok(response: &TestResponse) {
    assert!(
        response.status == StatusCode::OK || response.status == StatusCode::CREATED,
        "expected 2xx, got {}: {}",
        response.status,
        response.text()
    );
}

/// Signs a user up through the Frontend API exactly as a browser would.
pub async fn sign_up(e2e: &E2e, client: &TestClient, email: &str, password: &str) -> Value {
    let created = client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": email, "password": password })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("sign_up id")
        .to_string();
    let prepared = client
        .post(
            &format!("/v1/client/sign_ups/{id}/prepare_verification"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = orbitid_platform::mail::latest_code_for(e2e.state(), email, None)
        .expect("verification code");
    let attempted = client
        .post(
            &format!("/v1/client/sign_ups/{id}/attempt_verification"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    let value = attempted.value();
    assert_eq!(value["response"]["status"], "complete");
    value
}
