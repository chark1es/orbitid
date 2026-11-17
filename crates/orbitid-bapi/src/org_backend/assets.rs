//! Organization logo storage. The TypeScript server wrote files under
//! `<dataDir>/uploads/orgs`; this port stores the bytes in the shared `uploads`
//! table (like the Frontend API crate) so every replica can serve them.

use axum::extract::{FromRequest, Request};
use axum::http::{header, HeaderMap};
use base64::Engine;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{read_body_capped, MAX_UPLOAD_BYTES};
use orbitid_core::state::AppState;
use orbitid_platform::images::{assert_image_bytes, random_image_name};
use serde::Deserialize;

pub const LOGO_BUCKET: &str = orbitid_identity::uploads::LOGO_BUCKET;

/// Stores one logo in the caller's transaction and returns its public file
/// name. The upload row and the organization pointer commit together.
pub async fn store_logo_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    data: &[u8],
    _declared_mime: &str,
) -> Result<String> {
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(too_large());
    }
    let kind = assert_image_bytes(data, "file")?;
    let file = random_image_name(org_id, kind);
    orbitid_identity::uploads::store_upload_on(
        conn,
        LOGO_BUCKET,
        org_id,
        &file,
        kind.content_type(),
        data,
    )
    .await?;
    Ok(file)
}

fn too_large() -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        error_codes::FORM_PARAM_FORMAT_INVALID,
        "Logo must be smaller than 5MB",
    )
    .with_meta(serde_json::json!({ "param_name": "file" }))
}

fn malformed() -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PARAM_FORMAT_INVALID,
        "file must be a base64 data URL",
    )
    .with_meta(serde_json::json!({ "param_name": "file" }))
}

#[derive(Debug, Deserialize)]
struct ImageBody {
    file: String,
}

/// Multipart upload or `{ file: "data:image/png;base64,…" }` JSON.
pub async fn read_logo_payload(state: &AppState, request: Request) -> Result<(Vec<u8>, String)> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if content_type.contains("multipart/form-data") {
        let declared = request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        if declared > MAX_UPLOAD_BYTES + 64 * 1024 {
            return Err(too_large());
        }
        let mut multipart = axum::extract::Multipart::from_request(request, state)
            .await
            .map_err(|_| malformed())?;
        while let Some(field) = multipart.next_field().await.map_err(|_| malformed())? {
            if field.name() != Some("file") {
                continue;
            }
            let mime = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_string();
            let bytes = field.bytes().await.map_err(|_| malformed())?;
            if bytes.len() > MAX_UPLOAD_BYTES {
                return Err(too_large());
            }
            return Ok((bytes.to_vec(), mime));
        }
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "file is missing")
                .with_meta(serde_json::json!({ "param_name": "file" })),
        );
    }
    let bytes = read_body_capped(request.into_body(), MAX_UPLOAD_BYTES).await?;
    let body: ImageBody = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
    read_data_url(&body.file)
}

fn read_data_url(value: &str) -> Result<(Vec<u8>, String)> {
    let trimmed = value.trim();
    let (mime, payload) = trimmed
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(malformed)?;
    if mime.is_empty()
        || !mime
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ".+/-".contains(ch))
    {
        return Err(malformed());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| malformed())?;
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(too_large());
    }
    Ok((data, mime.to_ascii_lowercase()))
}

/// Whether a request body is multipart (`read_logo_payload` re-checks).
#[allow(dead_code)]
pub fn is_multipart(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("multipart/form-data"))
        .unwrap_or(false)
}
