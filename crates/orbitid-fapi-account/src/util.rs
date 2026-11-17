//! Helpers shared by the Frontend API routes in this crate.
//!
//! Most of these mirror small TypeScript helpers that live in `modules/auth`
//! (`redirects.ts`, `reverification.ts`) and `services/oidc/revocation.ts`.
//! They are duplicated here because those modules belong to the auth crate (a
//! sibling L3 crate this one may not depend on) and `orbitid-identity` does not
//! expose them; see the crate report for the layering note.

use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{SessionRow, UserRow};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::find_client;
use orbitid_identity::sessions::{evaluate_session_status, get_session};
use orbitid_identity::users::{get_user_by_id, require_user};
use orbitid_platform::emit_event;
use serde_json::{json, Value};

/// A request header as an owned string.
pub fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Reloads a user or fails with the canonical "User not found" 404.
pub async fn reload_user(state: &AppState, id: &str) -> Result<UserRow> {
    require_user(state, id).await
}

/// Emits `user.updated` with the Backend API serialization (private metadata
/// included), exactly like `emitUserUpdated` in `me/helpers.ts`.
pub async fn emit_user_updated(state: &AppState, user_id: &str) -> Result<()> {
    let Some(user) = get_user_by_id(state, user_id).await? else {
        return Ok(());
    };
    let json = orbitid_identity::serializers::serialize_user(
        state,
        &user,
        orbitid_identity::serializers::UserSerializeOptions { backend: true },
    )
    .await?;
    emit_event(
        state,
        "user.updated",
        serde_json::to_value(json).unwrap_or_default(),
    )
    .await;
    Ok(())
}

/// [`emit_user_updated`] on a caller-owned connection, so the event row commits
/// with the change it describes.
pub async fn emit_user_updated_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
) -> Result<()> {
    let user = orbitid_identity::users::require_user_on(conn, user_id).await?;
    let json = orbitid_identity::serializers::serialize_user_on(
        conn,
        state,
        &user,
        orbitid_identity::serializers::UserSerializeOptions { backend: true },
    )
    .await?;
    orbitid_platform::webhooks::emit_event_on(
        conn,
        "user.updated",
        serde_json::to_value(json).unwrap_or_default(),
    )
    .await
}

/// `deletedObject(object, id)`.
pub fn deleted_object(object: &str, id: &str) -> Value {
    json!({ "object": object, "id": id, "deleted": true })
}

// ───────────── safe redirects (`modules/auth/redirects.ts`) ─────────────

fn safe_origin(value: &str) -> Option<String> {
    url::Url::parse(value)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

/// `localhost` / `127.0.0.1` on any port, for development mode.
pub fn is_dev_localhost(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
}

/// Validates a post-auth redirect (`form_param_format_invalid`, 422), returning
/// the normalized absolute URL. Untrusted origins are refused before they can
/// receive a ticket.
pub fn validate_redirect_url(
    state: &AppState,
    value: Option<&str>,
    param: &str,
) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let raw = value.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let settings = state.settings.get();
    let base = if settings.application.home_url.is_empty() {
        state.env.base_url.clone()
    } else {
        settings.application.home_url.clone()
    };
    let url = match url::Url::parse(raw).or_else(|_| url::Url::parse(&base)?.join(raw)) {
        Ok(url) => url,
        Err(_) => {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                format!("{param} is not a valid URL"),
            )
            .with_meta(json!({ "param_name": param })));
        }
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must use http(s)"),
        )
        .with_meta(json!({ "param_name": param })));
    }
    let app = &settings.application;
    let mut allowed: Vec<String> = Vec::new();
    for origin in app
        .allowed_origins
        .iter()
        .chain(app.allowed_redirect_origins.iter())
    {
        if let Some(origin) = safe_origin(origin) {
            if !allowed.contains(&origin) {
                allowed.push(origin);
            }
        }
    }
    let origin = url.origin().ascii_serialization();
    if allowed.contains(&origin)
        || (app.development_mode && is_dev_localhost(&origin))
        || safe_origin(&app.home_url).as_deref() == Some(origin.as_str())
    {
        return Ok(Some(url.to_string()));
    }
    Err(OrbitError::unprocessable(
        error_codes::FORM_PARAM_FORMAT_INVALID,
        format!("{param} origin is not allowed"),
    )
    .with_meta(json!({ "param_name": param, "allowed_origins": allowed })))
}

// ───────────── OIDC grant revocation (`services/oidc/revocation.ts`) ─────────────

/// Revokes the grants of applications whose tokens assert organization or
/// group authority. Deliberately leaves the browser session signed in; the
/// canonical transaction lives in `orbitid_identity::grants`.
pub use orbitid_identity::grants::revoke_organization_authority_grants;

// ───────────── session reverification (`modules/auth/reverification.ts`) ─────────────

fn age_minutes(at: Option<i64>) -> Option<i64> {
    at.map(|at| (now() - at).max(0) / 60_000)
}

fn within(at: Option<i64>, after_minutes: i64) -> bool {
    at.map(|at| now() - at <= after_minutes * 60_000)
        .unwrap_or(false)
}

/// Whether the session verified `level` within `after_minutes`.
pub fn is_reverified(session: &SessionRow, level: &str, after_minutes: i64) -> bool {
    match level {
        "second_factor" => within(session.second_factor_verified_at, after_minutes),
        "both" => {
            within(session.first_factor_verified_at, after_minutes)
                && within(session.second_factor_verified_at, after_minutes)
        }
        _ => within(session.first_factor_verified_at, after_minutes),
    }
}

/// Sensitive mutations need a recent first-factor verification. Returns the
/// session that authorized the request.
pub async fn require_reverification(
    state: &AppState,
    headers: &HeaderMap,
    level: &str,
    after_minutes: i64,
) -> Result<SessionRow> {
    let Some(client) = find_client(state, headers).await? else {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    };
    let Some(session_id) = client.last_active_session_id.clone() else {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    };
    let Some(row) = get_session(state, &session_id).await? else {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    };
    if row.client_id != client.id {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    }
    let status = evaluate_session_status(state, &row).await?;
    if status != "active" && status != "pending" {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    }
    let mut row = row;
    row.status = status;
    if !is_reverified(&row, level, after_minutes) {
        return Err(OrbitError::forbidden(
            error_codes::REVERIFICATION_REQUIRED,
            "Session verification is required to perform this action",
        )
        .with_meta(json!({
            "level": level,
            "after_minutes": after_minutes,
            "session_id": row.id,
            "first_factor_age_minutes": age_minutes(row.first_factor_verified_at),
            "second_factor_age_minutes": age_minutes(row.second_factor_verified_at),
        })));
    }
    Ok(row)
}

// ───────────── metadata validation (`zMetadata`) ─────────────

/// A bounded metadata blob: at most 100 keys, 256-char keys, 4 KB strings,
/// 16 KB overall. `param` names the offending request field.
pub fn validate_metadata(metadata: &Metadata, param: &str) -> Result<()> {
    let invalid = |message: &str| {
        Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message.to_string())
                .with_meta(json!({ "param_name": param })),
        )
    };
    if metadata.len() > 100 {
        return invalid("metadata may contain at most 100 keys");
    }
    for (key, value) in metadata {
        if key.chars().count() > 256 {
            return invalid("metadata: keys may be at most 256 characters");
        }
        validate_metadata_value(value, param)?;
    }
    let size = serde_json::to_string(metadata)
        .map(|text| text.chars().count())
        .unwrap_or(usize::MAX);
    if size > 16 * 1024 {
        return invalid("metadata must serialize to at most 16 KB");
    }
    Ok(())
}

fn validate_metadata_value(value: &Value, param: &str) -> Result<()> {
    let invalid = |message: &str| {
        Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message.to_string())
                .with_meta(json!({ "param_name": param })),
        )
    };
    match value {
        Value::String(text) if text.chars().count() > 4096 => {
            invalid("metadata: string values may be at most 4096 characters")
        }
        Value::Array(items) => {
            if items.len() > 100 {
                return invalid("metadata: arrays may contain at most 100 items");
            }
            for item in items {
                validate_metadata_value(item, param)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            if map.len() > 100 {
                return invalid("metadata: objects may contain at most 100 keys");
            }
            for (key, item) in map {
                if key.chars().count() > 256 {
                    return invalid("metadata: keys may be at most 256 characters");
                }
                validate_metadata_value(item, param)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Parses a raw JSON value into a metadata object (422 for non-objects).
pub fn parse_metadata(value: Value, param: &str) -> Result<Metadata> {
    let Value::Object(map) = value else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param}: expected an object"),
        )
        .with_meta(json!({ "param_name": param })));
    };
    validate_metadata(&map, param)?;
    Ok(map)
}
