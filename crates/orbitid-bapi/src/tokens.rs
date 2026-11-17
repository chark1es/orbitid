//! Removed impersonation endpoints, ported from `modules/admin/tokens.ts`.
//!
//! The routes stay mounted so an existing integration gets a clear, typed
//! refusal instead of a confusing 404.

use axum::response::Response;
use axum::routing::post;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/sign_in_tokens", post(refuse))
        .route("/v1/sign_in_tokens/{id}/revoke", post(refuse_id))
        .route("/v1/actor_tokens", post(refuse))
        .route("/v1/actor_tokens/{id}/revoke", post(refuse_id))
}

fn refusal() -> OrbitError {
    OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        "Impersonation and one-time sign-in tokens were removed. An operator cannot mint a session for another user. \
         Ask the user to sign in, or send them a password-reset or invitation email.",
    )
}

async fn refuse() -> Result<Response> {
    Err(refusal())
}

async fn refuse_id() -> Result<Response> {
    Err(refusal())
}
