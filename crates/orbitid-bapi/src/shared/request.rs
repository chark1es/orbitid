use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;
use serde_json::{json, Map, Value};

pub use orbitid_identity::admin::get_user_or_throw;

/// The socket peer address, when the server installed `ConnectInfo`. Optional
/// because in-process test clients do not have one.

#[derive(Debug, Clone, Copy, Default)]
pub struct PeerAddr(pub Option<SocketAddr>);

impl<S: Send + Sync> FromRequestParts<S> for PeerAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(addr)| *addr),
        ))
    }
}

/// The caller's address, honouring `ORBITID_TRUST_PROXY` through the shared
/// client-IP helper.
pub fn request_ip(state: &AppState, headers: &HeaderMap, peer: PeerAddr) -> String {
    orbitid_core::http::client_ip(headers, peer.0, state.env.trust_proxy)
}

/// Loads a user or throws the Backend API 404.
pub async fn require_user(state: &AppState, id: &str) -> Result<UserRow> {
    get_user_or_throw(state, id).await
}

/// The `x-total-count` header value.
pub fn total_header(total: i64) -> (axum::http::header::HeaderName, axum::http::HeaderValue) {
    (
        axum::http::header::HeaderName::from_static("x-total-count"),
        axum::http::HeaderValue::from_str(&total.to_string())
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("0")),
    )
}

/// `Date.now()` in milliseconds.
pub fn now_ms() -> i64 {
    now()
}

/// Parses a JSON object body, keeping prototype keys out (already stripped by
/// the extractor) and asserting it is an object.
pub fn object_body(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "body: expected an object",
        )
        .with_meta(json!({ "param_name": "body" }))),
    }
}

// ───────────── serde helpers ─────────────
