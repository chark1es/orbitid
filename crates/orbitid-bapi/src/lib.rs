//! L3 Backend (admin) API: `/v1` routes used by the dashboard and server-side
//! SDKs, plus the dashboard operator-session exchange.
//!
//! The server mounts [`router`] publicly and wraps [`backend_router`] with
//! `orbitid_core::http::require_secret_key` (bearer secret key or the
//! same-origin operator-session cookie).

use axum::Router;
use orbitid_core::AppState;

pub mod console;
pub mod enterprise;
pub mod identifiers;
pub mod instance;
pub mod invitations;
pub mod jwt_templates;
pub mod operator_sessions;
pub mod org_backend;
pub mod sessions;
pub mod shared;
pub mod tokens;
pub mod users;
pub mod waitlist;
pub mod webhooks;

/// Routes that are not behind the Backend API guard: the operator-session
/// exchange and its session endpoints.
pub fn router() -> Router<AppState> {
    Router::new().merge(operator_sessions::router())
}

/// Every route in the TypeScript `backend` group (without the auth layer).
pub fn backend_router() -> Router<AppState> {
    Router::new()
        .merge(users::router())
        .merge(invitations::router())
        .merge(identifiers::router())
        .merge(waitlist::router())
        .merge(jwt_templates::router())
        .merge(sessions::router())
        .merge(instance::router())
        .merge(org_backend::router())
        .merge(webhooks::router())
        .merge(enterprise::router())
        .merge(tokens::router())
}
