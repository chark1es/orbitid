//! Public JWKS routes, ported from `modules/jwks.ts`.

use axum::http::header::CACHE_CONTROL;
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{extract::State, Json, Router};

use orbitid_core::{AppState, Result};

use crate::keys::get_jwks;

async fn jwks_handler(State(state): State<AppState>) -> Result<Response> {
    let keys = get_jwks(&state).await?;
    let mut response = Json(serde_json::json!({ "keys": keys })).into_response();
    response.headers_mut().insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    Ok(response)
}

/// `GET /.well-known/jwks.json` and `GET /v1/jwks`.
pub fn jwks_router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/jwks.json", get(jwks_handler))
        .route("/v1/jwks", get(jwks_handler))
}
