//! Test harness: a fully installed state, the crate router with the same
//! middleware ordering `orbitid-server` uses, and the identity fixtures.

#![allow(dead_code)]

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::Router;
use orbitid_core::http::{csrf_protection, security_headers, upload_size_limit};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{sign_up_user, test_app_state, TestApp, TestSession};
use serde_json::Value;
use tower::ServiceExt;

/// A test state plus the composed router.
pub struct Harness {
    pub test: TestApp,
    pub app: Router,
}

impl Harness {
    pub fn state(&self) -> &AppState {
        self.test.state()
    }

    pub fn client(&self) -> TestClient {
        TestClient::new(self.app.clone())
    }

    pub fn client_with_cookie(&self, cookie: &str) -> TestClient {
        TestClient::with_cookie(self.app.clone(), cookie)
    }

    /// Creates a verified user and returns their browser client.
    pub async fn signed_in(&self, email: &str, password: &str) -> SignedIn {
        let signed = sign_up_user(self.state(), email, password)
            .await
            .expect("sign-up fixture");
        let client = TestClient::with_cookie(self.app.clone(), &signed.auth.cookie);
        SignedIn {
            user_id: signed.user.user.id.clone(),
            email: signed.user.email.clone(),
            password: signed.user.password.clone(),
            auth: signed.auth,
            client,
        }
    }
}

/// A signed-in test user.
pub struct SignedIn {
    pub user_id: String,
    pub email: String,
    pub password: String,
    pub auth: TestSession,
    pub client: TestClient,
}

pub async fn harness() -> Harness {
    let test = test_app_state().await;
    let app = build_app(test.state().clone());
    Harness { test, app }
}

/// Mirrors `orbitid-server::app::build_app` for this crate: the global
/// middleware (security headers → upload cap → CSRF) around the routes.
pub fn build_app(state: AppState) -> Router {
    orbitid_fapi_account::router()
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            csrf_protection,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            upload_size_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            security_headers,
        ))
}

/// Sends a raw request (used for multipart uploads, which the JSON-only
/// `TestClient` cannot express).
pub async fn raw_request(
    app: &Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> TestResponse {
    let mut builder = Request::builder()
        .method(Method::from_bytes(method.to_ascii_uppercase().as_bytes()).expect("method"))
        .uri(path);
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            name.parse::<header::HeaderName>(),
            HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    for (name, value) in &map {
        builder = builder.header(name, value);
    }
    let request = builder.body(Body::from(body)).expect("well-formed request");
    let response = app.clone().oneshot(request).await.expect("infallible");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("readable body");
    TestResponse {
        status,
        headers,
        body,
    }
}

/// A minimal single-file multipart body.
pub fn multipart_body(
    boundary: &str,
    file_name: &str,
    content_type: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    out.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\n")
            .as_bytes(),
    );
    out.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    out.extend_from_slice(bytes);
    out.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    out
}

pub fn multipart_content_type(boundary: &str) -> String {
    format!("multipart/form-data; boundary={boundary}")
}

pub fn error_codes(response: &TestResponse) -> Vec<String> {
    response
        .value()
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(|item| item.get("code").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// A valid 1x1 PNG.
pub const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/// A valid 1x1 GIF.
pub const GIF_1X1: &str = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/// An SVG payload (must be refused).
pub const SVG_PAYLOAD: &str =
    "PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=";

pub fn data_url(mime: &str, base64: &str) -> String {
    format!("data:{mime};base64,{base64}")
}

pub fn decode_base64(value: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .expect("valid fixture")
}

pub async fn get_json(client: &TestClient, path: &str) -> TestResponse {
    client.request("GET", path, None, &[]).await
}

pub fn assert_status(response: &TestResponse, expected: StatusCode) {
    assert_eq!(
        response.status,
        expected,
        "unexpected status for response: {}",
        response.text()
    );
}
