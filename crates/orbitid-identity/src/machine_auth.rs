//! Signed-in caller resolution for Frontend-API machine routes, ported from
//! `modules/machine/auth.ts`.
//!
//! The Frontend API is authenticated by the opaque `__client` cookie (or
//! `Authorization: Bearer <client token>`), with a session JWT accepted as a
//! fallback bearer.

use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::get_cookie;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::keys::cookies::CLIENT;
use orbitid_core::models::{ClientRow, SessionRow};
use orbitid_core::state::AppState;

use crate::sessions::is_session_expired;
use crate::tokens::verify_session_token;

/// The caller, which may be an anonymous client (no session) or a signed-in
/// user (active session).
#[derive(Debug, Clone)]
pub struct MachineCaller {
    pub client_id: String,
    pub client: ClientRow,
    pub session_id: Option<String>,
    pub session: Option<SessionRow>,
    pub user_id: Option<String>,
}

fn live(state: &AppState, row: Option<&SessionRow>) -> bool {
    row.map(|row| row.status == "active" && !is_session_expired(state, row))
        .unwrap_or(false)
}

/// Client's newest active session, preferring the one the client marked active.
async fn active_session_for_client(
    state: &AppState,
    client: &ClientRow,
) -> Result<Option<SessionRow>> {
    if let Some(session_id) = &client.last_active_session_id {
        let preferred = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&state.pool)
            .await?;
        if live(state, preferred.as_ref()) {
            return Ok(preferred);
        }
    }
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 ORDER BY last_active_at DESC LIMIT 10",
    )
    .bind(&client.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.into_iter().find(|row| live(state, Some(row))))
}

async fn caller_from_client(state: &AppState, client: ClientRow) -> Result<MachineCaller> {
    let session = active_session_for_client(state, &client).await?;
    Ok(MachineCaller {
        client_id: client.id.clone(),
        client,
        session_id: session.as_ref().map(|row| row.id.clone()),
        user_id: session.as_ref().map(|row| row.user_id.clone()),
        session,
    })
}

/// Resolves the caller from the `__client` cookie, falling back to a session
/// JWT in `Authorization: Bearer`. Returns `None` when there is no
/// client/cookie or the session is not active.
pub async fn resolve_caller(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<MachineCaller>> {
    let cookie = get_cookie(headers, CLIENT)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty());

    if let Some(cookie) = cookie {
        let client = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE token_hash = $1")
            .bind(orbitid_core::crypto::sha256(&cookie))
            .fetch_optional(&state.pool)
            .await?;
        if let Some(client) = client {
            return Ok(Some(caller_from_client(state, client).await?));
        }
    }
    if let Some(bearer) = bearer.filter(|value| !value.starts_with("sk_")) {
        let claims = match verify_session_token(state, &bearer, None).await {
            Ok(claims) => claims,
            Err(_) => return Ok(None),
        };
        let session = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(&claims.sid)
            .fetch_optional(&state.pool)
            .await?;
        if let Some(session) = session.as_ref() {
            if live(state, Some(session)) && session.user_id == claims.sub {
                let client = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE id = $1")
                    .bind(&session.client_id)
                    .fetch_optional(&state.pool)
                    .await?;
                if let Some(client) = client {
                    return Ok(Some(MachineCaller {
                        client_id: client.id.clone(),
                        client,
                        session_id: Some(session.id.clone()),
                        user_id: Some(session.user_id.clone()),
                        session: Some(session.clone()),
                    }));
                }
            }
        }
    }
    Ok(None)
}

/// Like [`resolve_caller`] but throws `401 authentication_invalid`.
pub async fn require_caller(state: &AppState, headers: &HeaderMap) -> Result<MachineCaller> {
    resolve_caller(state, headers).await?.ok_or_else(|| {
        OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Authentication invalid. Please sign in again.",
        )
    })
}

/// Like [`require_caller`] but also requires an active session (a signed-in
/// user).
pub async fn require_user_caller(state: &AppState, headers: &HeaderMap) -> Result<MachineCaller> {
    let caller = require_caller(state, headers).await?;
    if caller.user_id.is_none() || caller.session_id.is_none() || caller.session.is_none() {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "No active session. Please sign in.",
        ));
    }
    Ok(caller)
}

/// Creates a client row + its opaque cookie token (IdP-initiated SSO where no
/// browser client exists yet).
pub async fn create_machine_client(
    state: &AppState,
    ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(ClientRow, String)> {
    let token = orbitid_core::crypto::random_token(32);
    let now_ms = orbitid_core::http::now();
    let id = new_id(id_prefix::CLIENT);
    sqlx::query(
        "INSERT INTO clients (id, token_hash, token_issued_at, ip, user_agent, created_at, \
         updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    )
    .bind(&id)
    .bind(orbitid_core::crypto::sha256(&token))
    .bind(now_ms)
    .bind(ip)
    .bind(user_agent)
    .bind(now_ms)
    .execute(&state.pool)
    .await?;
    let client = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE id = $1")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    Ok((client, token))
}
