//! Shared harness: the OIDC routers wrapped the way `orbitid-server` will wrap
//! them, on top of the identity test fixtures.
//!
//! `router()` is mounted publicly (its `/v1/oauth_applications` guard is
//! internal); `backend_router()` gets `require_secret_key`, exactly like the
//! server's Backend API group.

#![allow(dead_code)]

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Request, StatusCode};
use axum::middleware;
use axum::Router;
use http_body_util::BodyExt;
use orbitid_core::http::{error_logging, require_secret_key, security_headers};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{test_app_state, TestApp};
use serde_json::{json, Value};
use tower::ServiceExt;

pub const SECRET_KEY: &str = "sk_test_testsecret";
pub const BASE_URL: &str = "http://localhost:4000";
pub const REDIRECT_URI: &str = "http://localhost:3000/callback";
/// Mirrors the server's per-code attempt budget for the device verification endpoints.
pub const DEVICE_ATTEMPT_BUDGET: usize = 10;

pub fn build_app(state: &AppState) -> Router {
    Router::new()
        .merge(
            orbitid_oidc::backend_router().layer(middleware::from_fn_with_state(
                state.clone(),
                require_secret_key,
            )),
        )
        .merge(orbitid_oidc::router())
        .merge(orbitid_credentials::routes::jwks_router())
        .with_state(state.clone())
        .layer(middleware::from_fn(orbitid_oidc::oidc_cors))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(middleware::from_fn(error_logging))
}

pub struct Harness {
    pub app: TestApp,
    pub router: Router,
    pub client: TestClient,
}

impl Harness {
    pub fn state(&self) -> &AppState {
        self.app.state()
    }

    pub fn other_browser(&self) -> TestClient {
        TestClient::new(self.router.clone())
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

    /// A form-urlencoded request carrying the harness browser's cookies.
    pub async fn form(&self, path: &str, params: &[(&str, &str)]) -> TestResponse {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        let mut headers: Vec<(&str, &str)> =
            vec![("content-type", "application/x-www-form-urlencoded")];
        let cookie = self.client.cookie_header();
        if let Some(cookie) = cookie.as_deref() {
            headers.push(("cookie", cookie));
        }
        send(&self.router, Method::POST, path, Body::from(body), &headers).await
    }

    /// A form request with an explicit `Authorization` header (Basic client auth).
    pub async fn form_with_auth(
        &self,
        path: &str,
        params: &[(&str, &str)],
        authorization: &str,
    ) -> TestResponse {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params)
            .finish();
        let mut headers: Vec<(&str, &str)> = vec![
            ("content-type", "application/x-www-form-urlencoded"),
            ("authorization", authorization),
        ];
        let cookie = self.client.cookie_header();
        if let Some(cookie) = cookie.as_deref() {
            headers.push(("cookie", cookie));
        }
        send(&self.router, Method::POST, path, Body::from(body), &headers).await
    }

    /// Creates an OAuth application through the Backend API.
    pub async fn create_app(&self, overrides: Value) -> Value {
        let mut body = json!({
            "name": "Test App",
            "redirect_uris": [REDIRECT_URI],
            "consent_screen_enabled": false,
            "scopes": "openid profile email phone groups organizations offline_access",
        });
        if let (Some(base), Value::Object(extra)) = (body.as_object_mut(), overrides) {
            for (key, value) in extra {
                base.insert(key, value);
            }
        }
        let response = self.post("/v1/oauth_applications", body).await;
        assert_eq!(
            response.status,
            StatusCode::CREATED,
            "create application failed: {}",
            response.text()
        );
        response.value()
    }
}

pub async fn send(
    router: &Router,
    method: Method,
    path: &str,
    body: Body,
    headers: &[(&str, &str)],
) -> TestResponse {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            name.parse::<header::HeaderName>(),
            HeaderValue::from_str(value),
        ) {
            builder = builder.header(name, value);
        }
    }
    let response = router
        .clone()
        .oneshot(builder.body(body).expect("request is well-formed"))
        .await
        .expect("router is infallible");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body can be read")
        .to_bytes();
    TestResponse {
        status,
        headers,
        body: bytes,
    }
}

pub fn bearer() -> &'static [(&'static str, &'static str)] {
    &[("authorization", "Bearer sk_test_testsecret")]
}

/// A verified user with an optional display name, plus their browser session.
pub struct Browser {
    pub user: orbitid_core::models::UserRow,
    pub client: TestClient,
    pub session_id: String,
    pub cookie: String,
}

pub async fn harness() -> Harness {
    let app = test_app_state().await;
    let router = build_app(app.state());
    let client = TestClient::new(router.clone());
    Harness {
        app,
        router,
        client,
    }
}

/// A user with an email address and a live browser session (the TS
/// `insertUser` + `insertClientSession` fixtures).
pub async fn insert_user(h: &Harness, email: &str) -> Browser {
    let created = orbitid_identity::testing::create_test_user(h.state(), email, "Sup3r-secret!")
        .await
        .expect("create user");
    sqlx::query("UPDATE users SET first_name = $2, last_name = $3 WHERE id = $1")
        .bind(&created.user.id)
        .bind("Ada")
        .bind("Lovelace")
        .execute(&h.state().pool)
        .await
        .expect("set name");
    let session =
        orbitid_identity::testing::create_test_client_session(h.state(), &created.user.id)
            .await
            .expect("create session");
    let client = TestClient::with_cookie(h.router.clone(), &session.cookie);
    Browser {
        user: created.user,
        client,
        session_id: session.session.id.clone(),
        cookie: session.cookie,
    }
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

pub fn basic(client_id: &str, secret: &str) -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{secret}"))
    )
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

/// Runs `/oauth/authorize` for a signed-in browser; returns the parsed redirect
/// query string.
pub async fn authorize(
    h: &Harness,
    browser: &Browser,
    params: &[(&str, &str)],
) -> std::collections::HashMap<String, String> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish();
    let response = send(
        &h.router,
        Method::GET,
        &format!("/oauth/authorize?{query}"),
        Body::empty(),
        &[("cookie", &browser.cookie)],
    )
    .await;
    assert_eq!(response.status, StatusCode::FOUND, "{}", response.text());
    query_of(&location(&response))
}

/// Code + PKCE flow. Returns the token response body.
pub struct CodeFlow {
    pub tokens: Value,
    pub code: String,
}

pub async fn code_flow(
    h: &Harness,
    browser: &Browser,
    application: &Value,
    scopes: &str,
) -> CodeFlow {
    let verifier = pkce_verifier();
    let challenge = challenge_for(&verifier);
    let client_id = application["client_id"].as_str().unwrap_or_default();
    let secret = application["client_secret"].as_str().unwrap_or_default();
    let query = authorize(
        h,
        browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", scopes),
            ("state", "state-123"),
            ("nonce", "nonce-123"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .await;
    let code = query.get("code").cloned().expect("authorize issued a code");
    let response = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", REDIRECT_URI),
                ("code_verifier", &verifier),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    CodeFlow {
        tokens: response.value(),
        code,
    }
}

pub fn decode_claims(token: &str) -> Value {
    orbitid_credentials::jwt::decode_jwt_payload(token).unwrap_or(Value::Null)
}

pub async fn settings(h: &Harness, patch: Value) {
    h.state()
        .settings
        .update(patch)
        .await
        .expect("update settings");
}
