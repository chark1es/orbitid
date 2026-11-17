//! L3 HTTP surface (`oidc`): the OrbitID OpenID Provider and machine
//! credentials.
//!
//! Covers the OpenID Provider, the device grant page and its Frontend API, the
//! machine credential surface and the self-service API keys.
//!
//! Mounting contract:
//!  - [`router`] holds every public/frontend route (`/oauth/*`, the discovery
//!    documents, `/oauth/jwks`, the device verification page and its assets,
//!    the `/v1/client` API-key and device routes, `/oauth/m2m/token`).
//!    `/v1/oauth_applications` is in this router **guarded internally** with
//!    `require_secret_key`, exactly like the TypeScript router (the server's
//!    `BACKEND_PREFIXES` does not include it).
//!  - [`backend_router`] holds the routes the TypeScript app mounts in its
//!    `backend` group: `/v1/api_keys…` and `/v1/m2m…`. The server wraps it with
//!    `orbitid_core::http::require_secret_key`; this crate does not repeat that
//!    layer.
//!  - [`oidc_cors`] is the `oidcCors` middleware (`modules/oidc/shared.ts`):
//!    mounted by the server globally *before* the Frontend API CORS policy so
//!    the bearer-only OIDC endpoints answer wildcard CORS preflights.

pub mod device_page;
pub mod redirects;
pub mod routes;
pub mod services;
pub mod web;

use axum::extract::Request;
use axum::http::{header, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use orbitid_core::AppState;

/// Routes for this surface, mounted by `orbitid-server`.
pub fn router() -> Router<AppState> {
    Router::new()
        .merge(routes::well_known::router())
        .merge(routes::discovery::router())
        .merge(routes::token::router())
        .merge(routes::logout::router())
        .merge(routes::device::router())
        .merge(routes::device_client::router())
        .merge(routes::applications::router())
        .merge(routes::api_keys_frontend::router())
        .merge(routes::m2m_oauth::router())
}

/// Backend API routes (`/v1/api_keys`, `/v1/m2m`), without the auth layer.
pub fn backend_router() -> Router<AppState> {
    Router::new()
        .merge(routes::api_keys::backend_router())
        .merge(routes::m2m::backend_router())
}

/// Paths whose CORS is answered by the OIDC policy instead of the Frontend API.
const CORS_PUBLIC: [&str; 8] = [
    "/oauth/jwks",
    "/oauth/token",
    "/oauth/userinfo",
    "/oauth/revoke",
    "/oauth/introspect",
    "/oauth/device_authorization",
    "/oauth/end_session",
    "/.well-known/jwks.json",
];

/// Whether `path` ends in `/.well-known/openid-configuration` or
/// `/.well-known/oauth-authorization-server`, at arbitrary prefix depth, with
/// an optional RFC 8414 suffix — the TypeScript server's `DISCOVERY_PATH`
/// regex.
pub fn is_discovery_path(path: &str) -> bool {
    let Some((_, rest)) = path.rsplit_once("/.well-known/") else {
        return false;
    };
    ["openid-configuration", "oauth-authorization-server"]
        .iter()
        .any(|name| rest == *name || rest.starts_with(&format!("{name}/")))
}

fn is_cors_public(path: &str) -> bool {
    CORS_PUBLIC.contains(&path) || is_discovery_path(path)
}

/// `oidcCors`: wildcard CORS for the bearer-token OIDC endpoints, answering
/// preflights itself. Mount with `axum::middleware::from_fn(orbitid_oidc::oidc_cors)`
/// before the Frontend API CORS policy.
pub async fn oidc_cors(request: Request, next: Next) -> Response {
    if !is_cors_public(request.uri().path()) {
        return next.run(request).await;
    }
    let preflight = request.method() == Method::OPTIONS;
    let mut response = if preflight {
        axum::http::StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Accept"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );
    response
}
