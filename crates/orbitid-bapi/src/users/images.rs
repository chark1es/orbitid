//! User profile-image routes (`POST`/`DELETE /v1/users/:id/profile_image`).

use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use base64::Engine;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, read_body_capped, MAX_UPLOAD_BYTES};
use orbitid_core::state::AppState;
use orbitid_identity::admin::MAX_PROFILE_IMAGE_BYTES;
use orbitid_identity::serializers::UserSerializeOptions;
use orbitid_platform::audit::{audit, AuditInput};
use orbitid_platform::images::assert_image_bytes;
use serde::Deserialize;
use serde_json::json;

use crate::shared::{get_user_or_throw, json_response, to_value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/users/{id}/profile_image", post(upload).delete(remove))
}

#[derive(Debug, Deserialize)]
struct ImageBody {
    file: String,
}

async fn upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    let content_type = request
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let data_url = if content_type.contains("multipart/form-data") {
        let multipart = Multipart::from_request(request, &state)
            .await
            .map_err(|_| {
                OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "Malformed multipart body",
                )
            })?;
        multipart_data_url(multipart).await?
    } else {
        json_data_url(request).await?
    };
    let value = {
        let mut tx = state.pool.begin().await?;
        // Read the row under the lock so this upload replaces the current
        // pointer, not a value read before the transaction.
        let current = sqlx::query_as::<_, orbitid_core::models::UserRow>(
            "SELECT * FROM users WHERE id = $1 FOR UPDATE",
        )
        .bind(&existing.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
        sqlx::query(
            "UPDATE users SET image_url = $1, has_image = true, updated_at = $2 WHERE id = $3",
        )
        .bind(&data_url)
        .bind(now())
        .bind(&current.id)
        .execute(&mut *tx)
        .await?;
        let user = orbitid_identity::users::require_user_on(&mut tx, &current.id).await?;
        let value = to_value(
            orbitid_identity::serializers::serialize_user_on(
                &mut tx,
                &state,
                &user,
                UserSerializeOptions { backend: true },
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value.clone()).await?;
        orbitid_identity::uploads::delete_upload_by_url_on(
            &mut tx,
            orbitid_identity::uploads::AVATAR_BUCKET,
            orbitid_identity::uploads::AVATAR_MARKER,
            current.image_url.as_deref(),
        )
        .await?;
        tx.commit().await?;
        value
    };
    audit(
        &state,
        AuditInput::new("user.profile_image.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id.clone()),
    )
    .await;
    Ok(json_response(value))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    let value = {
        let mut tx = state.pool.begin().await?;
        let current = sqlx::query_as::<_, orbitid_core::models::UserRow>(
            "SELECT * FROM users WHERE id = $1 FOR UPDATE",
        )
        .bind(&existing.id)
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
        let user = orbitid_identity::users::require_user_on(&mut tx, &current.id).await?;
        let value = to_value(
            orbitid_identity::serializers::serialize_user_on(
                &mut tx,
                &state,
                &user,
                UserSerializeOptions { backend: true },
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value.clone()).await?;
        orbitid_identity::uploads::delete_upload_by_url_on(
            &mut tx,
            orbitid_identity::uploads::AVATAR_BUCKET,
            orbitid_identity::uploads::AVATAR_MARKER,
            current.image_url.as_deref(),
        )
        .await?;
        tx.commit().await?;
        value
    };
    audit(
        &state,
        AuditInput::new("user.profile_image.removed")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id.clone()),
    )
    .await;
    Ok(json_response(value))
}

async fn multipart_data_url(mut multipart: Multipart) -> Result<String> {
    while let Some(field) = multipart.next_field().await.map_err(|_| {
        OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "Malformed multipart body",
        )
    })? {
        if field.name() != Some("file") {
            continue;
        }
        let bytes = field.bytes().await.map_err(|_| {
            OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "Malformed multipart body",
            )
        })?;
        if bytes.len() as i64 > MAX_PROFILE_IMAGE_BYTES {
            return Err(too_large());
        }
        return data_url_for(&bytes);
    }
    Err(
        OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "file is required.")
            .with_meta(json!({ "param_name": "file" })),
    )
}

async fn json_data_url(request: Request) -> Result<String> {
    let bytes = read_body_capped(request.into_body(), MAX_UPLOAD_BYTES).await?;
    let body: ImageBody = serde_json::from_slice(&bytes).map_err(|_| {
        OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "file must be a base64 image data URL",
        )
        .with_meta(json!({ "param_name": "file" }))
    })?;
    if body.file.len() as i64 > MAX_PROFILE_IMAGE_BYTES {
        return Err(too_large());
    }
    // Only an image data URL of an allowed raster format; remote URLs are not
    // fetched by the server.
    let (mime_part, payload) = body
        .file
        .trim()
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| {
            OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "file must be a base64 image data URL",
            )
            .with_meta(json!({ "param_name": "file" }))
        })?;
    if !mime_part
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ".+/-".contains(ch))
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "file must be a base64 image data URL",
        )
        .with_meta(json!({ "param_name": "file" })));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| {
            OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "file must be a base64 image data URL",
            )
            .with_meta(json!({ "param_name": "file" }))
        })?;
    if bytes.len() as i64 > MAX_PROFILE_IMAGE_BYTES {
        return Err(too_large());
    }
    data_url_for(&bytes)
}

fn data_url_for(bytes: &[u8]) -> Result<String> {
    let kind = assert_image_bytes(bytes, "file")?;
    Ok(format!(
        "data:{};base64,{}",
        kind.content_type(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn too_large() -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        error_codes::FORM_PARAM_FORMAT_INVALID,
        "Image must be smaller than 512 KB.",
    )
    .with_meta(json!({ "param_name": "file" }))
}
