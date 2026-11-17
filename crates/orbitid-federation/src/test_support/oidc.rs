//! A mock OpenID Connect provider that never leaves the process.
//!
//! It serves discovery, JWKS, authorization (with S256 PKCE and nonce binding),
//! token and userinfo endpoints over real loopback HTTP, so adapters exercise
//! `safe_fetch` and real signatures rather than a stub. Negative tests can
//! replace the staging claims, return a verbatim token, or sign with another key
//! while publishing the original JWKS.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::oneshot;

mod http;
use http::{authorize, discovery, jwks, token, userinfo};

use super::keys::{make_key_pair, rsa_jwk_parts, TestKeyPair};

/// The identity the mock provider asserts.
#[derive(Debug, Clone)]
pub struct OidcUser {
    pub sub: String,
    pub email: String,
    pub email_verified: bool,
    pub given_name: String,
    pub family_name: String,
}

impl Default for OidcUser {
    fn default() -> Self {
        Self {
            sub: "user_mock_1".to_string(),
            email: "ada@acme.test".to_string(),
            email_verified: true,
            given_name: "Ada".to_string(),
            family_name: "Lovelace".to_string(),
        }
    }
}

/// Configuration for [`start_oidc_server`].
#[derive(Debug, Clone)]
pub struct OidcServerOptions {
    pub client_id: String,
    pub client_secret: String,
    pub user: OidcUser,
    /// The fixed authorization code the authorize endpoint hands out.
    pub code: String,
}

impl Default for OidcServerOptions {
    fn default() -> Self {
        Self {
            client_id: "test-client".to_string(),
            client_secret: "test-secret".to_string(),
            user: OidcUser::default(),
            code: "test-code".to_string(),
        }
    }
}

/// One recorded token-endpoint request.
#[derive(Debug, Clone, Default)]
pub struct TokenRequest {
    pub authorization: Option<String>,
    pub form: BTreeMap<String, String>,
}

impl TokenRequest {
    /// Reads one form field.
    pub fn field(&self, name: &str) -> Option<&str> {
        self.form.get(name).map(String::as_str)
    }
}

pub(super) struct State {
    key: TestKeyPair,
    signing_key: TestKeyPair,
    kid: String,
    issuer: String,
    options: OidcServerOptions,
    token_requests: Vec<TokenRequest>,
    code_challenge: Option<String>,
    nonce: Option<String>,
    next_claims: Option<Value>,
    raw_id_token: Option<String>,
    userinfo: Option<Value>,
}

pub(super) type Shared = Arc<Mutex<State>>;

/// A running mock OIDC provider.
pub struct OidcTestServer {
    pub base_url: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub kid: String,
    pub jwks: Value,
    state: Shared,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl OidcTestServer {
    /// Records the token-endpoint requests seen so far.
    pub fn token_requests(&self) -> Vec<TokenRequest> {
        self.state
            .lock()
            .map(|state| state.token_requests.clone())
            .unwrap_or_default()
    }

    /// Replaces the claims staged for the next ID token.
    pub fn set_next_claims(&self, claims: Option<Value>) {
        if let Ok(mut state) = self.state.lock() {
            state.next_claims = claims;
        }
    }

    /// Returns this token verbatim instead of signing one (e.g. `alg=none`).
    pub fn set_raw_id_token(&self, token: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.raw_id_token = token;
        }
    }

    /// Replaces the userinfo document the provider serves.
    pub fn set_userinfo(&self, document: Option<Value>) {
        if let Ok(mut state) = self.state.lock() {
            state.userinfo = document;
        }
    }

    /// Signs future ID tokens with another key while still publishing the original JWKS.
    pub fn set_signing_key(&self, key: Option<TestKeyPair>) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(key) = key {
                state.signing_key = key;
            }
        }
    }

    /// Stops the HTTP server.
    pub async fn close(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

pub(super) fn state_of(shared: &Shared) -> std::sync::MutexGuard<'_, State> {
    match shared.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub async fn start_oidc_server(options: OidcServerOptions) -> Result<OidcTestServer, String> {
    let key = make_key_pair("oidc-idp")?;
    let kid = "test-key-1".to_string();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let issuer = format!("http://127.0.0.1:{}", address.port());
    let (n, e) = rsa_jwk_parts(&key.key)?;
    let jwks_value = json!({
        "keys": [{
            "kty": "RSA", "use": "sig", "alg": "RS256", "kid": kid, "n": n, "e": e,
        }]
    });
    let client_id = options.client_id.clone();
    let client_secret = options.client_secret.clone();
    let shared: Shared = Arc::new(Mutex::new(State {
        signing_key: key.clone(),
        key,
        kid: kid.clone(),
        issuer: issuer.clone(),
        options,
        token_requests: Vec::new(),
        code_challenge: None,
        nonce: None,
        next_claims: None,
        raw_id_token: None,
        userinfo: None,
    }));
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/authorize", get(authorize))
        .route("/token", post(token))
        .route("/userinfo", get(userinfo))
        .with_state(shared.clone());
    let (shutdown, receiver) = oneshot::channel();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await;
    });
    Ok(OidcTestServer {
        base_url: issuer.clone(),
        issuer,
        client_id,
        client_secret,
        kid,
        jwks: jwks_value,
        state: shared,
        shutdown: Some(shutdown),
        join: Some(join),
    })
}

#[cfg(test)]
mod tests;
