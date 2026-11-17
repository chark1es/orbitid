//! Public image serving: profile avatars (`/v1/client/images/:file`, from
//! `modules/client.ts`) and organization logos
//! (`/v1/client/organization_logos/:file`, from `modules/org-client/public.ts`).
//!
//! Bytes come from the `uploads` table so every replica can answer.

use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

use crate::uploads;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/images/{file}", get(avatar))
        .route("/v1/client/organization_logos/{file}", get(logo))
}

fn not_found(message: &str) -> OrbitError {
    OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, message)
}

fn binary_response(content_type: &str, bytes: Vec<u8>) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    response
}

async fn avatar(State(state): State<AppState>, Path(file): Path<String>) -> Result<Response> {
    if !uploads::is_safe_file_name(&file) {
        return Err(not_found("Image not found"));
    }
    let Some(content_type) = uploads::avatar_content_type(&file) else {
        return Err(not_found("Image not found"));
    };
    let Some(stored) = uploads::read_upload(&state, uploads::AVATAR_BUCKET, &file).await? else {
        return Err(not_found("Image not found"));
    };
    Ok(binary_response(content_type, stored.bytes))
}

async fn logo(State(state): State<AppState>, Path(file): Path<String>) -> Result<Response> {
    if !uploads::is_safe_file_name(&file) {
        return Err(not_found("Not found"));
    }
    let Some(stored) = uploads::read_upload(&state, uploads::LOGO_BUCKET, &file).await? else {
        return Err(not_found("Not found"));
    };
    let content_type = uploads::logo_content_type(&file);
    Ok(binary_response(content_type, stored.bytes))
}
