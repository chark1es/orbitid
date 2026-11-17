//! OpenID discovery and JWKS documents, ported from `modules/oidc/discovery.ts`
//! and `modules/jwks.ts`.

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use orbitid_core::state::AppState;
use orbitid_credentials::keys::get_jwks;

use crate::services::oidc::discovery::discovery_document;
use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::shared::{HandlerError, HandlerResult};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/.well-known/oauth-authorization-server", get(discovery))
        // Path-bearing issuers: `https://issuer/<path>/.well-known/…` and the
        // RFC 8414 suffix form. The TypeScript server matches arbitrary depth;
        // axum can only route a single path prefix, so one segment is covered.
        .route("/{prefix}/.well-known/openid-configuration", get(discovery))
        .route(
            "/{prefix}/.well-known/oauth-authorization-server",
            get(discovery),
        )
        .route(
            "/.well-known/oauth-authorization-server/{*suffix}",
            get(discovery),
        )
        .route(
            "/{prefix}/.well-known/oauth-authorization-server/{*suffix}",
            get(discovery),
        )
        .route("/oauth/jwks", get(jwks))
}

/// The discovery document for any path that ends in a well-known discovery
/// suffix. Public so the server's fallback can answer the arbitrary-depth
/// issuer paths that axum's single-segment route cannot express.
pub async fn discovery_response(state: &AppState, headers: &HeaderMap) -> Response {
    let issuer = issuer_for(state, headers);
    let mut response = axum::Json(discovery_document(state, &issuer)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    response
}

async fn discovery(State(state): State<AppState>, headers: HeaderMap) -> Response {
    discovery_response(&state, &headers).await
}

async fn jwks(State(state): State<AppState>) -> HandlerResult<Response> {
    let keys = get_jwks(&state).await.map_err(HandlerError::Orbit)?;
    let mut response = axum::Json(json!({ "keys": keys })).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    Ok(response)
}
