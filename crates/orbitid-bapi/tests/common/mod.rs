//! Shared harness: the Backend API router wrapped the way `orbitid-server`
//! wraps it, on top of the identity test fixtures.

#![allow(dead_code)]

use axum::middleware;
use axum::Router;
use orbitid_core::http::require_secret_key;
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{test_app_state, TestApp};
use serde_json::Value;

pub const SECRET_KEY: &str = "sk_test_testsecret";

/// Builds the app from both public routers, applying the secret-key guard to
/// the Backend API group only (mirrors `orbitid-server`).
pub fn build_app(state: &AppState) -> Router {
    Router::new()
        .merge(
            orbitid_bapi::backend_router().layer(middleware::from_fn_with_state(
                state.clone(),
                require_secret_key,
            )),
        )
        .merge(orbitid_bapi::router())
        .with_state(state.clone())
}

/// A fully installed test instance plus an authenticated Backend API client.
pub struct Harness {
    pub app: TestApp,
    pub client: TestClient,
}

impl Harness {
    pub fn state(&self) -> &AppState {
        self.app.state()
    }

    pub async fn get(&self, path: &str) -> TestResponse {
        self.client.get(path, bearer()).await
    }

    pub async fn post(&self, path: &str, body: Value) -> TestResponse {
        self.client.post(path, Some(body), bearer()).await
    }

    pub async fn post_empty(&self, path: &str) -> TestResponse {
        self.client.post(path, None, bearer()).await
    }

    pub async fn patch(&self, path: &str, body: Value) -> TestResponse {
        self.client.patch(path, Some(body), bearer()).await
    }

    pub async fn put(&self, path: &str, body: Value) -> TestResponse {
        self.client.request("PUT", path, Some(body), bearer()).await
    }

    pub async fn delete(&self, path: &str) -> TestResponse {
        self.client.delete(path, None, bearer()).await
    }

    /// An owner signed in on this browser with the console open; its `cookie`
    /// carries both the account and the console cookie.
    pub async fn console(&self) -> orbitid_identity::testing::TestConsole {
        orbitid_identity::testing::create_test_console(self.state(), "console-owner@example.com")
            .await
            .expect("console session")
    }

    /// A request with the operator cookie instead of the bearer key.
    pub async fn cookie(&self, path: &str, cookie: &str) -> TestResponse {
        self.client.get(path, &[("cookie", cookie)]).await
    }

    /// Creates a user through the API and returns its JSON.
    pub async fn create_user(&self, body: Value) -> Value {
        let response = self.post("/v1/users", body).await;
        assert_eq!(
            response.status,
            axum::http::StatusCode::OK,
            "create user failed: {}",
            response.text()
        );
        response.value()
    }

    pub async fn create_session(&self, user_id: &str) -> SessionFixture {
        self.create_session_with(user_id, "active").await
    }

    pub async fn create_session_with(&self, user_id: &str, status: &str) -> SessionFixture {
        let now = orbitid_core::http::now();
        let client_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::CLIENT);
        let token = format!("client-token-{client_id}");
        sqlx::query(
            "INSERT INTO clients (id, token_hash, created_at, updated_at) VALUES ($1,$2,$3,$3)",
        )
        .bind(&client_id)
        .bind(orbitid_core::crypto::sha256(&token))
        .bind(now)
        .execute(&self.state().pool)
        .await
        .expect("insert client");
        let session_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::SESSION);
        sqlx::query(
            "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, \
             abandon_at, created_at, updated_at) \
             VALUES ($1,$2,$3,$6,$4,$5,$5,$4,$4)",
        )
        .bind(&session_id)
        .bind(&client_id)
        .bind(user_id)
        .bind(now)
        .bind(now + 3_600_000)
        .bind(status)
        .execute(&self.state().pool)
        .await
        .expect("insert session");
        SessionFixture {
            client_id,
            session_id,
            token,
        }
    }
}

pub struct SessionFixture {
    pub client_id: String,
    pub session_id: String,
    pub token: String,
}

pub fn bearer() -> &'static [(&'static str, &'static str)] {
    &[("authorization", "Bearer sk_test_testsecret")]
}

pub async fn setup() -> Harness {
    let app = test_app_state().await;
    let client = TestClient::new(build_app(app.state()));
    Harness { app, client }
}

/// [`setup`] with explicit overrides, e.g. `test_pool_exemption(n)` for a test
/// that holds several connections at once by design.
pub async fn setup_with(overrides: orbitid_core::config::EnvOverrides) -> Harness {
    let app = orbitid_identity::testing::test_app_state_with(overrides).await;
    let client = TestClient::new(build_app(app.state()));
    Harness { app, client }
}

/// The first error code in an error body.
pub fn error_code(response: &TestResponse) -> Option<String> {
    response.value()["errors"][0]["code"]
        .as_str()
        .map(str::to_string)
}
