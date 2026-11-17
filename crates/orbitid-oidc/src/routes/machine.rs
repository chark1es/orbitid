//! Caller helpers shared by the machine-owned Frontend API routes, ported from
//! `modules/machine/auth.ts`.
//!
//! The domain logic lives in `orbitid_identity::machine_auth`; this module only
//! adapts header access and the error shapes the routes expect.

use axum::http::HeaderMap;
use orbitid_core::error::Result;
use orbitid_core::state::AppState;
use orbitid_identity::machine_auth::{resolve_caller, MachineCaller};

pub use orbitid_identity::machine_auth::require_user_caller;

/// `Authorization: Bearer …` with the scheme removed, trimmed.
pub fn bearer_token(headers: &HeaderMap) -> String {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let value = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or("")
        .trim();
    value.to_string()
}

/// Resolves the signed-in user (or anonymous client) for a Frontend API route.
pub async fn caller(state: &AppState, headers: &HeaderMap) -> Result<Option<MachineCaller>> {
    resolve_caller(state, headers).await
}
