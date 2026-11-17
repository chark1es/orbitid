//! Client (browser/device) authentication and `ClientJSON`, ported from
//! `modules/auth/client-auth.ts`.
//!
//! The browser's `__client` cookie is an opaque 256-bit token; only its sha256
//! is stored. A token presented but unknown is *not* replaced except on the
//! SDK's own bootstrap (`GET /v1/client`), so a rotation in another tab cannot
//! silently sign the user out here.

use std::collections::HashMap;

use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::{
    append_cookie, clear_cookie, get_cookie, set_cookie, CookieOptions, SameSite,
};
use orbitid_core::http::{client_ip, now, request_is_secure};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::keys::cookies::CLIENT;
use orbitid_core::keys::COOKIE_MAX_AGE_SECONDS;
use orbitid_core::models::{ClientRow, SessionRow, SignInRow, SignUpRow};
use orbitid_core::resources::{ClientJson, SessionJson, SignInJson, SignUpJson};
use orbitid_core::state::AppState;
use percent_encoding::percent_decode_str;

use crate::serializers::{serialize_sessions, serialize_user, UserSerializeOptions};
use crate::sessions::{evaluate_session_status, get_session, is_session_expired};
use crate::tokens::{sign_session_token, SignSessionTokenOptions};

/// Re-issue the same client cookie when it is at least this old, so an actively
/// used browser never hits the 400-day cap.
pub const CLIENT_COOKIE_RENEW_AFTER_MS: i64 = 24 * 60 * 60 * 1000;

/// Builds the `Set-Cookie` line for the client token.
pub fn client_cookie(headers: &HeaderMap, state: &AppState, token: &str) -> String {
    let options = CookieOptions {
        path: "/".into(),
        http_only: true,
        secure: request_is_secure(headers, &state.env.base_url, state.env.trust_proxy),
        same_site: SameSite::Lax,
        max_age: Some(COOKIE_MAX_AGE_SECONDS),
        domain: None,
    };
    set_cookie(CLIENT, token, &options)
}

pub fn set_client_cookie(headers: &mut HeaderMap, state: &AppState, token: &str) {
    append_cookie(headers, client_cookie(headers, state, token));
}

pub fn clear_client_cookie(headers: &mut HeaderMap, state: &AppState) {
    let secure = request_is_secure(headers, &state.env.base_url, state.env.trust_proxy);
    append_cookie(headers, clear_cookie(CLIENT, "/", secure));
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// The client token presented by this request: `__client` cookie, a non-key
/// bearer token, or `X-Orbitid-Client`.
pub fn read_client_token(headers: &HeaderMap) -> Option<String> {
    if let Some(raw) = get_cookie(headers, CLIENT).filter(|value| !value.is_empty()) {
        return Some(percent_decode_str(raw).decode_utf8_lossy().into_owned());
    }
    let authorization = header(headers, "authorization").unwrap_or_default();
    if let Some(token) = authorization.strip_prefix("Bearer ") {
        let token = token.trim();
        if !token.is_empty() && !token.starts_with("sk_") && !token.starts_with("pk_") {
            return Some(token.to_string());
        }
    }
    header(headers, "x-orbitid-client").filter(|value| !value.is_empty())
}

/// Creates a client row and returns it plus the opaque token for the cookie.
pub async fn create_client(
    state: &AppState,
    ip: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(ClientRow, String)> {
    let token = orbitid_core::crypto::random_token(32);
    insert_client(state, ip, user_agent, token).await
}

/// Inserts a freshly minted client token. The caller always supplies a random
/// token: a client-presented value is never adopted as a credential.
async fn insert_client(
    state: &AppState,
    ip: Option<&str>,
    user_agent: Option<&str>,
    token: String,
) -> Result<(ClientRow, String)> {
    let id = new_id(id_prefix::CLIENT);
    let now_ms = now();
    let row = sqlx::query_as::<_, ClientRow>(
        "INSERT INTO clients (id, token_hash, token_issued_at, ip, user_agent, created_at, \
         updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) \
         ON CONFLICT (token_hash) DO UPDATE SET updated_at = EXCLUDED.updated_at \
         RETURNING *",
    )
    .bind(&id)
    .bind(orbitid_core::crypto::sha256(&token))
    .bind(now_ms)
    .bind(ip)
    .bind(user_agent)
    .bind(now_ms)
    .fetch_one(&state.pool)
    .await?;
    Ok((row, token))
}

/// A request that presents a client cookie refreshes `updated_at` at most this
/// often. Retention keeps session-less clients for the cookie lifetime, and this
/// touch ensures a browser that keeps using an old client never ages toward the
/// sweep cutoff while it is active.
pub const CLIENT_TOUCH_INTERVAL_MS: i64 = 60 * 60 * 1000;

/// Looks up the client from the cookie / bearer token without creating one.
pub async fn find_client(state: &AppState, headers: &HeaderMap) -> Result<Option<ClientRow>> {
    let Some(token) = read_client_token(headers) else {
        return Ok(None);
    };
    let mut row = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE token_hash = $1")
        .bind(orbitid_core::crypto::sha256(&token))
        .fetch_optional(&state.pool)
        .await?;
    if let Some(client) = row.as_mut() {
        let now_ms = now();
        if now_ms - client.updated_at >= CLIENT_TOUCH_INTERVAL_MS {
            sqlx::query("UPDATE clients SET updated_at = $1 WHERE id = $2")
                .bind(now_ms)
                .bind(&client.id)
                .execute(&state.pool)
                .await?;
            client.updated_at = now_ms;
        }
    }
    Ok(row)
}

/// Returns the request's client, creating one (and a `Set-Cookie` value) when
/// absent. `method` and `path` decide whether an unknown presented token may be
/// replaced (only the SDK bootstrap may).
pub async fn get_or_create_client(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
) -> Result<(ClientRow, Option<String>)> {
    let presented = read_client_token(headers);
    if let Some(existing) = find_client(state, headers).await? {
        let cookie = renew_client_cookie_if_due(state, headers, &existing).await?;
        return Ok((existing, cookie));
    }
    if presented.is_some() && !(method == "GET" && path == "/v1/client") {
        return Err(OrbitError::unauthorized(
            error_codes::CLIENT_STATE_INVALID,
            "This browser's client token is no longer valid. Reload the page to continue.",
        ));
    }
    let ip = client_ip(headers, None, state.env.trust_proxy);
    let user_agent = header(headers, "user-agent");
    // Always mint a random credential. A presented but unknown token could have
    // been planted by an attacker (sibling subdomain, HTTP MITM), so it must
    // never become the credential of the client we create — exactly like the
    // TypeScript `createClient`. Concurrent first requests may create two rows;
    // the losing one is harmless and is swept by retention.
    let token = orbitid_core::crypto::random_token(32);
    let (row, token) = insert_client(state, Some(&ip), user_agent.as_deref(), token).await?;
    Ok((row, Some(client_cookie(headers, state, &token))))
}

pub async fn require_client(state: &AppState, headers: &HeaderMap) -> Result<ClientRow> {
    find_client(state, headers).await?.ok_or_else(|| {
        OrbitError::unauthorized(
            error_codes::CLIENT_STATE_INVALID,
            "No client found. Reload the page to create one.",
        )
    })
}

/// Rotates the opaque client token (used after an OAuth form_post callback where
/// the cookie may be missing) and returns the new token plus cookie line.
pub async fn regenerate_client_token(
    state: &AppState,
    headers: &HeaderMap,
    client_id: &str,
) -> Result<(String, String)> {
    let token = orbitid_core::crypto::random_token(32);
    let now_ms = now();
    sqlx::query(
        "UPDATE clients SET token_hash = $1, token_issued_at = $2, updated_at = $2 WHERE id = $3",
    )
    .bind(orbitid_core::crypto::sha256(&token))
    .bind(now_ms)
    .bind(client_id)
    .execute(&state.pool)
    .await?;
    let cookie = client_cookie(headers, state, &token);
    Ok((token, cookie))
}

/// Re-issues the *same* opaque client token when the cookie is old enough to be
/// near the 400-day cap. Returns a `Set-Cookie` value when it did.
pub async fn renew_client_cookie_if_due(
    state: &AppState,
    headers: &HeaderMap,
    client: &ClientRow,
) -> Result<Option<String>> {
    let Some(token) = read_client_token(headers) else {
        return Ok(None);
    };
    let issued_at = client
        .token_issued_at
        .unwrap_or(client.updated_at.max(client.created_at));
    if now() - issued_at < CLIENT_COOKIE_RENEW_AFTER_MS {
        return Ok(None);
    }
    let now_ms = now();
    sqlx::query("UPDATE clients SET token_issued_at = $1, updated_at = $1 WHERE id = $2")
        .bind(now_ms)
        .bind(&client.id)
        .execute(&state.pool)
        .await?;
    Ok(Some(client_cookie(headers, state, &token)))
}

/// Rotates the client token when a session is created from it.
pub async fn rotate_client_token_on_sign_in(
    state: &AppState,
    headers: &HeaderMap,
    client_id: &str,
) -> Result<String> {
    Ok(regenerate_client_token(state, headers, client_id).await?.0)
}

/// A-Z-P for the session token: the request's `Origin`, else the `Referer`
/// origin.
pub fn client_azp(headers: &HeaderMap) -> Option<String> {
    if let Some(origin) = header(headers, "origin").filter(|value| !value.is_empty()) {
        return Some(origin);
    }
    let referer = header(headers, "referer")?;
    url::Url::parse(&referer)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

/// Latest in-flight sign-in for the client (completed attempts are hidden).
pub async fn inflight_sign_in(state: &AppState, client_id: &str) -> Result<Option<SignInRow>> {
    let row = sqlx::query_as::<_, SignInRow>(
        "SELECT * FROM sign_ins WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(client_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.filter(|row| row.status != "complete" && row.status != "abandoned"))
}

/// Latest in-flight sign-up for the client (completed attempts are hidden).
pub async fn inflight_sign_up(state: &AppState, client_id: &str) -> Result<Option<SignUpRow>> {
    let row = sqlx::query_as::<_, SignUpRow>(
        "SELECT * FROM sign_ups WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(client_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.filter(|row| row.status != "complete" && row.status != "abandoned"))
}

/// Wire representation of a client including its sessions (with users).
///
/// `sign_in`/`sign_up` are supplied by the auth layer: building those resources
/// needs the sign-in/sign-up state machine, which lives in `orbitid-fapi-auth`.
/// Use [`serialize_client_with`] when an in-flight attempt exists.
pub async fn serialize_client(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
    mint_tokens: bool,
) -> Result<ClientJson> {
    serialize_client_with(state, client, azp, mint_tokens, None, None).await
}

/// Same as [`serialize_client`] but with the in-flight `sign_in`/`sign_up`
/// resources already projected by the caller.
pub async fn serialize_client_with(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
    mint_tokens: bool,
    sign_in: Option<SignInJson>,
    sign_up: Option<SignUpJson>,
) -> Result<ClientJson> {
    let fresh = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE id = $1")
        .bind(&client.id)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_else(|| client.clone());
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 ORDER BY created_at DESC",
    )
    .bind(&fresh.id)
    .fetch_all(&state.pool)
    .await?;
    let mut sessions: Vec<SessionRow> = Vec::new();
    let mut last_tokens: HashMap<String, String> = HashMap::new();
    for stored in rows {
        let status = evaluate_session_status(state, &stored).await?;
        if status == "expired" {
            continue;
        }
        let mut row = stored;
        row.status = status.clone();
        if mint_tokens
            && (status == "active" || status == "pending")
            && !is_session_expired(state, &row)
        {
            if let Ok(token) = sign_session_token(
                state,
                &row.id,
                SignSessionTokenOptions {
                    template: None,
                    azp: azp.map(str::to_string),
                },
            )
            .await
            {
                last_tokens.insert(row.id.clone(), token);
            }
        }
        sessions.push(row);
    }
    let serialized: Vec<SessionJson> =
        serialize_sessions(state, &sessions, true, &last_tokens).await?;
    Ok(ClientJson {
        object: "client".into(),
        id: fresh.id.clone(),
        sessions: serialized,
        sign_in,
        sign_up,
        last_active_session_id: fresh.last_active_session_id.clone(),
        cookie_expires_at: Some(now() + COOKIE_MAX_AGE_SECONDS * 1000),
        created_at: fresh.created_at,
        updated_at: fresh.updated_at,
    })
}

/// Active session for the client (the one the SDK is using), or `None`.
pub async fn active_client_session(
    state: &AppState,
    client: &ClientRow,
) -> Result<Option<SessionRow>> {
    if let Some(session_id) = &client.last_active_session_id {
        if let Some(row) = get_session(state, session_id).await? {
            if row.client_id == client.id {
                let status = evaluate_session_status(state, &row).await?;
                if status == "active" || status == "pending" {
                    let mut row = row;
                    row.status = status;
                    return Ok(Some(row));
                }
            }
        }
    }
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 AND status = 'active' \
         ORDER BY last_active_at DESC",
    )
    .bind(&client.id)
    .fetch_all(&state.pool)
    .await?;
    for candidate in rows {
        let status = evaluate_session_status(state, &candidate).await?;
        if status == "active" || status == "pending" {
            let mut row = candidate;
            row.status = status;
            return Ok(Some(row));
        }
    }
    Ok(None)
}

/// The signed-in user for a client (throws when there is none).
pub async fn require_active_user(
    state: &AppState,
    client: &ClientRow,
) -> Result<(SessionRow, orbitid_core::models::UserRow)> {
    let Some(session) = active_client_session(state, client).await? else {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        ));
    };
    let user =
        sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(&session.user_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| {
                OrbitError::unauthorized(error_codes::AUTHENTICATION_INVALID, "Not signed in")
            })?;
    if user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        ));
    }
    Ok((session, user))
}

/// Convenience for callers that want the wire user for a client.
pub async fn client_user_json(
    state: &AppState,
    user: &orbitid_core::models::UserRow,
) -> Result<orbitid_core::resources::UserJson> {
    serialize_user(state, user, UserSerializeOptions::default()).await
}
