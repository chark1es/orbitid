//! Test harness: the fapi-auth router wrapped in the same middleware order the
//! server applies, on top of the identity test fixtures.

#![allow(dead_code)]

use axum::middleware;
use axum::Router;
use orbitid_core::config::EnvOverrides;
use orbitid_core::http::{csrf_protection, error_logging, security_headers, upload_size_limit};
use orbitid_core::testing::TestClient;
use orbitid_core::AppState;
use orbitid_identity::testing::{test_app_state_with, TestApp};

pub fn build(state: AppState) -> Router {
    orbitid_fapi_auth::router()
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            csrf_protection,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            upload_size_limit,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(middleware::from_fn(error_logging))
}

pub struct Harness {
    pub app: TestApp,
    pub client: TestClient,
}

impl Harness {
    pub fn state(&self) -> &AppState {
        self.app.state()
    }

    /// A second browser with its own cookie jar, against the same state.
    pub fn other_browser(&self) -> TestClient {
        TestClient::new(build(self.app.state().clone()))
    }
}

pub async fn harness() -> Harness {
    harness_with(EnvOverrides::default()).await
}

pub async fn harness_with(overrides: EnvOverrides) -> Harness {
    let app = test_app_state_with(overrides).await;
    let client = TestClient::new(build(app.state().clone()));
    Harness { app, client }
}

/// Sends a `application/x-www-form-urlencoded` POST through the same router
/// (the `OrbitJson` extractor accepts forms as well as JSON).
pub async fn raw_form(
    state: &AppState,
    path: &str,
    cookie: Option<&str>,
    form: &[(&str, &str)],
) -> orbitid_core::testing::TestResponse {
    use tower::ServiceExt;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in form {
        serializer.append_pair(key, value);
    }
    let mut builder = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/x-www-form-urlencoded");
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let request = builder
        .body(axum::body::Body::from(serializer.finish()))
        .expect("request");
    let response = build(state.clone()).oneshot(request).await.expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    orbitid_core::testing::TestResponse {
        status,
        headers,
        body,
    }
}

/// Sign in with a password and return the completed sign-in resource.
pub async fn password_sign_in(
    harness: &Harness,
    identifier: &str,
    password: &str,
) -> serde_json::Value {
    let response = harness
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": identifier, "password": password })),
            &[],
        )
        .await;
    assert_eq!(response.status, 200, "{}", response.text());
    response.value()["response"].clone()
}

/// Creates a verified password user through the identity fixtures.
pub async fn seed_user(
    harness: &Harness,
    email: &str,
    password: &str,
) -> orbitid_identity::testing::TestUser {
    orbitid_identity::testing::create_test_user(harness.state(), email, password)
        .await
        .expect("create user")
}
