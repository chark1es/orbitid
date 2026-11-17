//! Active-session and trusted-device routes (`modules/me/sessions.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::SessionRow;
use orbitid_core::state::AppState;
use orbitid_identity::serializers::{
    serialize_session, serialize_trusted_device, SessionSerializeOptions,
};
use orbitid_identity::sessions::{end_session, is_session_expired};
use orbitid_identity::trusted_devices::{
    list_trusted_devices as list_user_trusted_devices, revoke_trusted_device,
};
use serde_json::json;

use crate::reply::json_reply;
use crate::util::require_reverification;

use super::{authenticate, HttpMeta};

pub async fn active_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE user_id = $1 AND status = 'active' \
         ORDER BY last_active_at DESC",
    )
    .bind(&me.user.id)
    .fetch_all(&state.pool)
    .await?;
    let rows: Vec<SessionRow> = rows
        .into_iter()
        .filter(|row| row.id != me.session.id && !is_session_expired(&state, row))
        .collect();
    let mut response = Vec::with_capacity(rows.len());
    for row in &rows {
        response.push(
            serialize_session(
                &state,
                row,
                SessionSerializeOptions {
                    with_user: true,
                    last_token: None,
                },
            )
            .await?,
        );
    }
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let row =
        sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1 AND user_id = $2")
            .bind(&id)
            .bind(&me.user.id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found")
            })?;
    let updated = end_session(&state, &row, "revoked").await?;
    let response = serialize_session(
        &state,
        &updated,
        SessionSerializeOptions {
            with_user: true,
            last_token: None,
        },
    )
    .await?;
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn list_trusted_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = list_user_trusted_devices(&state, &me.user.id).await?;
    let response: Vec<_> = rows.iter().map(serialize_trusted_device).collect();
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn delete_trusted_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    // Scoped to the owner: another user's device id is indistinguishable from an
    // unknown one.
    let row = revoke_trusted_device(&state, &me.user.id, &id).await?;
    if row.is_none() {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Trusted device not found",
        ));
    }
    Ok(json_reply(
        json!({ "response": { "object": "trusted_device", "id": id, "deleted": true } }),
        cookies,
    ))
}
