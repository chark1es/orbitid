//! Minimal caller resolution for Frontend API organization routes, ported
//! from `modules/orgs/auth.ts`.

use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::get_cookie;
use orbitid_core::keys::cookies::CLIENT;
use orbitid_core::models::{ClientRow, SessionRow, UserRow};
use orbitid_core::state::AppState;

use crate::sessions::is_session_expired;
use crate::tokens::verify_session_token;

/// A signed-in user on the Frontend API.
#[derive(Debug, Clone)]
pub struct Caller {
    pub user: UserRow,
    pub user_id: String,
    pub session_id: String,
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn looks_like_jwt(token: &str) -> bool {
    token.split('.').count() == 3
}

/// Active, not past its absolute expiry and not idle longer than the instance's
/// inactivity timeout.
fn active(state: &AppState, row: Option<&SessionRow>) -> bool {
    row.map(|row| row.status == "active" && !is_session_expired(state, row))
        .unwrap_or(false)
}

async fn session_user(state: &AppState, row: &SessionRow) -> Result<Option<Caller>> {
    let Some(user) = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&state.pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(Caller {
        user_id: user.id.clone(),
        user,
        session_id: row.id.clone(),
    }))
}

async fn session_by_id(state: &AppState, id: &str) -> Result<Option<SessionRow>> {
    Ok(
        sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

async fn belongs(
    state: &AppState,
    client: &ClientRow,
    session_id: Option<String>,
) -> Result<Option<SessionRow>> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let row = session_by_id(state, &session_id).await?;
    Ok(row.filter(|row| row.client_id == client.id))
}

/// The account signed in on *this browser*: only the instance's own `__client`
/// cookie counts. A session JWT or client token sent as a bearer, and the
/// session-id hint, are ignored. The dashboard uses this before handing out a
/// console session, so a token an application received (or an attacker lifted
/// from one) cannot be exchanged for Backend API access.
pub async fn try_resolve_browser_caller(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<Caller>> {
    let mut cookies = HeaderMap::new();
    for value in headers.get_all(axum::http::header::COOKIE) {
        cookies.append(axum::http::header::COOKIE, value.clone());
    }
    try_resolve_caller(state, &cookies, None).await
}

/// Resolves the calling user from (in order): the `x-orbitid-session-id`
/// header / `_session_id` query hint, `Authorization: Bearer <session JWT>`, or
/// the opaque `__client` cookie (+ that client's active session).
pub async fn try_resolve_caller(
    state: &AppState,
    headers: &HeaderMap,
    hinted_session_id: Option<&str>,
) -> Result<Option<Caller>> {
    let hinted =
        header(headers, "x-orbitid-session-id").or_else(|| hinted_session_id.map(str::to_string));
    let authorization = header(headers, "authorization").unwrap_or_default();
    let bearer = authorization
        .strip_prefix("Bearer ")
        .map(str::trim)
        .unwrap_or("");
    let bearer = if bearer.is_empty() {
        None
    } else {
        Some(bearer)
    };

    if let Some(bearer) = bearer.filter(|token| looks_like_jwt(token)) {
        // Malformed / expired / foreign tokens simply mean "not signed in" for
        // organization routes.
        let claims = match verify_session_token(state, bearer, None).await {
            Ok(claims) => claims,
            Err(_) => return Ok(None),
        };
        let row = session_by_id(state, &claims.sid).await?;
        if let Some(row) = row.as_ref() {
            if active(state, Some(row)) && row.user_id == claims.sub {
                return session_user(state, row).await;
            }
        }
        return Ok(None);
    }

    let client_token = get_cookie(headers, CLIENT)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            bearer
                .filter(|token| !looks_like_jwt(token))
                .map(str::to_string)
        });
    let Some(client_token) = client_token else {
        return Ok(None);
    };
    let client = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE token_hash = $1")
        .bind(orbitid_core::crypto::sha256(&client_token))
        .fetch_optional(&state.pool)
        .await?;
    let Some(client) = client else {
        return Ok(None);
    };

    if let Some(row) = belongs(state, &client, hinted.clone()).await? {
        if active(state, Some(&row)) {
            return session_user(state, &row).await;
        }
    }
    if let Some(row) = belongs(state, &client, client.last_active_session_id.clone()).await? {
        if active(state, Some(&row)) {
            return session_user(state, &row).await;
        }
    }

    let fallback = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 AND status = 'active' \
         ORDER BY last_active_at DESC LIMIT 1",
    )
    .bind(&client.id)
    .fetch_optional(&state.pool)
    .await?;
    match fallback {
        Some(row) if active(state, Some(&row)) => session_user(state, &row).await,
        _ => Ok(None),
    }
}

/// Same as [`try_resolve_caller`] but throws a 401 when nobody is signed in.
pub async fn resolve_caller(
    state: &AppState,
    headers: &HeaderMap,
    hinted_session_id: Option<&str>,
) -> Result<Caller> {
    try_resolve_caller(state, headers, hinted_session_id)
        .await?
        .ok_or_else(|| {
            OrbitError::unauthorized(error_codes::AUTHENTICATION_INVALID, "Not authenticated")
        })
}
