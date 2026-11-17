//! Profile-image routes (`modules/me/profile.ts` avatar half).

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::json::parse_request_body;
use orbitid_core::http::{now, MAX_JSON_BYTES};
use orbitid_core::state::AppState;
use orbitid_platform::images::assert_image_bytes;
use serde_json::json;

use crate::uploads;
use crate::util::{header, reload_user};

use super::profile::user_reply;
use super::shared::{assert_max_chars, ImageBody};
use super::{authenticate, HttpMeta};

/// The avatar upload accepts `multipart/form-data` or a JSON body with a base64
/// data URL, exactly like `POST /v1/client/me/profile_image`.
pub async fn upload_profile_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    request: Request,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    if !state
        .settings
        .get()
        .user_settings
        .allow_profile_image_upload
    {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Profile image uploads are disabled",
        ));
    }
    let content_type = header(&headers, "content-type").unwrap_or_default();
    let bytes = read_avatar_bytes(&headers, request, &content_type).await?;
    if bytes.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "The uploaded file is empty",
        )
        .with_meta(json!({ "param_name": "file" })));
    }
    if bytes.len() > uploads::MAX_IMAGE_BYTES {
        return Err(OrbitError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            error_codes::FORM_PARAM_VALUE_INVALID,
            "Images must be smaller than 5MB",
        )
        .with_meta(json!({ "param_name": "file" })));
    }
    // The bytes decide: declared type and extension are ignored.
    let kind = assert_image_bytes(&bytes, "file")?;
    // The upload row, the user's pointer, the replaced file's deletion and
    // `user.updated` commit together.
    let mut tx = state.pool.begin().await?;
    let current = sqlx::query_as::<_, orbitid_core::models::UserRow>(
        "SELECT * FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(&me.user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
    let name = uploads::random_image_name(&current.id, kind);
    let image_url = format!("{}/v1/client/images/{}", state.env.base_url, name);
    uploads::store_upload_on(
        &mut tx,
        uploads::AVATAR_BUCKET,
        &current.id,
        &name,
        kind.content_type(),
        &bytes,
    )
    .await?;
    sqlx::query("UPDATE users SET image_url = $1, has_image = true, updated_at = $2 WHERE id = $3")
        .bind(&image_url)
        .bind(now())
        .bind(&current.id)
        .execute(&mut *tx)
        .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &current.id).await?;
    orbitid_identity::uploads::delete_upload_by_url_on(
        &mut tx,
        uploads::AVATAR_BUCKET,
        uploads::AVATAR_MARKER,
        current.image_url.as_deref(),
    )
    .await?;
    tx.commit().await?;
    let reloaded = reload_user(&state, &me.user.id).await?;
    user_reply(&state, &reloaded, cookies).await
}

async fn read_avatar_bytes(
    headers: &HeaderMap,
    request: Request,
    content_type: &str,
) -> Result<Vec<u8>> {
    let body = axum::body::to_bytes(request.into_body(), uploads::MAX_IMAGE_BYTES + 64 * 1024)
        .await
        .map_err(|_| {
            OrbitError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                error_codes::REQUEST_BODY_INVALID,
                "Request body is too large",
            )
        })?;
    if content_type
        .to_ascii_lowercase()
        .contains("multipart/form-data")
    {
        let Some(file) = uploads::multipart_file(content_type, &body, "file") else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "file is missing",
            )
            .with_meta(json!({ "param_name": "file" })));
        };
        if file.bytes.len() > uploads::MAX_IMAGE_BYTES {
            return Err(OrbitError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                error_codes::FORM_PARAM_VALUE_INVALID,
                "Images must be smaller than 5MB",
            )
            .with_meta(json!({ "param_name": "file" })));
        }
        return Ok(file.bytes);
    }
    let value = parse_request_body(headers, Body::from(body), MAX_JSON_BYTES).await?;
    let body: ImageBody = serde_json::from_value(value).map_err(|error| {
        OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, format!("file: {error}"))
            .with_meta(json!({ "param_name": "file" }))
    })?;
    assert_max_chars(&body.file, uploads::MAX_IMAGE_BYTES, "file")?;
    uploads::decode_image_payload(&body.file, "file")
}

pub async fn delete_profile_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let mut tx = state.pool.begin().await?;
    let current = sqlx::query_as::<_, orbitid_core::models::UserRow>(
        "SELECT * FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(&me.user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
    sqlx::query(
        "UPDATE users SET image_url = NULL, has_image = false, updated_at = $1 WHERE id = $2",
    )
    .bind(now())
    .bind(&current.id)
    .execute(&mut *tx)
    .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &current.id).await?;
    orbitid_identity::uploads::delete_upload_by_url_on(
        &mut tx,
        uploads::AVATAR_BUCKET,
        uploads::AVATAR_MARKER,
        current.image_url.as_deref(),
    )
    .await?;
    tx.commit().await?;
    let reloaded = reload_user(&state, &me.user.id).await?;
    user_reply(&state, &reloaded, cookies).await
}
