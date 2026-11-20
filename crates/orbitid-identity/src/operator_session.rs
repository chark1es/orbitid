//! Dashboard console sessions: an opaque, revocable cookie for an account that
//! holds [`DASHBOARD_ACCESS`] and is signed in on this browser.
//!
//! The secret key never opens the dashboard. A console session is issued only
//! for a signed-in account (owner setup or "Open the admin console") and is
//! re-checked on every request against that account's own session, its ban
//! state and its roles. The server stores only the sha256 of the cookie token
//! and a fingerprint of the secret key, so rotating the key still ends every
//! console session at once.

use std::sync::Arc;

use axum::http::HeaderMap;
use orbitid_core::error::Result;
use orbitid_core::http::cookies::{
    append_cookie, clear_cookie, get_cookie, set_cookie, CookieOptions, SameSite,
};
use orbitid_core::http::now;
use orbitid_core::http::OperatorSessionChecker;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::keys::cookies::OPERATOR;
use orbitid_core::models::{OperatorSessionRow, SessionRow};
use orbitid_core::state::AppState;

use crate::rbac::DASHBOARD_ACCESS;
use crate::sessions::is_session_expired;

/// 8 hours: long enough for a working day, short enough that a stolen cookie
/// ages out.
pub const OPERATOR_SESSION_TTL_MS: i64 = 8 * 60 * 60 * 1000;
const COOKIE_PATH: &str = "/v1";

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Stable, non-reversible tag of the secret key; rotating the key ends every
/// console session.
pub fn key_fingerprint(secret_key: &str) -> String {
    base64_url(&orbitid_core::crypto::hmac_sha256(
        secret_key.as_bytes(),
        b"orbitid/operator-session/fingerprint",
    ))
}

fn cookie_options(state: &AppState) -> CookieOptions {
    CookieOptions {
        path: COOKIE_PATH.into(),
        http_only: true,
        // Parity with `services/operator-session.ts`: the operator cookie is
        // deliberately `Secure` only from `baseUrl`, not `X-Forwarded-Proto`.
        // The dashboard is same-origin with the configured public URL; client
        // cookies are the ones that must also work on a plain-http dev proxy.
        secure: state.env.base_url.starts_with("https://"),
        same_site: SameSite::Strict,
        max_age: Some(OPERATOR_SESSION_TTL_MS / 1000),
        domain: None,
    }
}

/// The signed-in account behind a console session.
#[derive(Debug, Clone, Copy)]
pub struct ConsoleUser<'a> {
    pub user_id: &'a str,
    /// The user's own session on this browser; ending it ends the console session.
    pub session_id: &'a str,
}

/// Creates a console session for a signed-in user who holds
/// [`DASHBOARD_ACCESS`] and returns its plaintext token (for the httpOnly
/// cookie only). The caller has already checked the permission; every later
/// request checks it again (see [`find_operator_session`]).
pub async fn issue_user_operator_session(
    state: &AppState,
    user: ConsoleUser<'_>,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<(OperatorSessionRow, String)> {
    let token = orbitid_core::crypto::random_token(32);
    let now_ms = now();
    let id = new_id(id_prefix::OPERATOR_SESSION);
    sqlx::query(
        "INSERT INTO operator_sessions (id, token_hash, key_fingerprint, user_agent, ip_address, \
         expires_at, created_at, updated_at, user_id, session_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)",
    )
    .bind(&id)
    .bind(orbitid_core::crypto::sha256(&token))
    .bind(key_fingerprint(&state.env.secret_key))
    .bind(user_agent)
    .bind(ip)
    .bind(now_ms + OPERATOR_SESSION_TTL_MS)
    .bind(now_ms)
    .bind(user.user_id)
    .bind(user.session_id)
    .execute(&state.pool)
    .await?;
    // Expired and revoked rows are dead weight; sweep them now and then.
    if rand::random::<f64>() < 0.05 {
        let sweep_state = state.clone();
        tokio::spawn(async move {
            let _ = sweep_operator_sessions(&sweep_state).await;
        });
    }
    let row =
        sqlx::query_as::<_, OperatorSessionRow>("SELECT * FROM operator_sessions WHERE id = $1")
            .bind(&id)
            .fetch_one(&state.pool)
            .await?;
    Ok((row, token))
}

pub fn set_operator_cookie(headers: &mut HeaderMap, state: &AppState, token: &str) {
    append_cookie(headers, set_cookie(OPERATOR, token, &cookie_options(state)));
}

pub fn clear_operator_cookie(headers: &mut HeaderMap) {
    append_cookie(headers, clear_cookie(OPERATOR, COOKIE_PATH, false));
}

fn operator_token(headers: &HeaderMap) -> Option<String> {
    get_cookie(headers, OPERATOR)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Resolves the console session behind the request, or `None` when there is
/// none. An expired, revoked or key-mismatched session is rejected, and so is
/// one whose account signed out, was banned or lost console access.
pub async fn find_operator_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<OperatorSessionRow>> {
    let Some(token) = operator_token(headers) else {
        return Ok(None);
    };
    let row = sqlx::query_as::<_, OperatorSessionRow>(
        "SELECT * FROM operator_sessions WHERE token_hash = $1",
    )
    .bind(orbitid_core::crypto::sha256(&token))
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.revoked_at.is_some() || row.expires_at <= now() {
        return Ok(None);
    }
    if row.key_fingerprint != key_fingerprint(&state.env.secret_key) {
        return Ok(None);
    }
    if !console_user_still_allowed(state, &row.user_id, &row.session_id).await? {
        return Ok(None);
    }
    Ok(Some(row))
}

/// True when `user_id` holds an instance role that grants [`DASHBOARD_ACCESS`].
pub async fn has_console_access(state: &AppState, user_id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(&format!(
        "SELECT EXISTS ({CONSOLE_GRANT} WHERE ur.user_id = $1)"
    ))
    .bind(user_id)
    .bind(DASHBOARD_ACCESS)
    .fetch_one(&state.pool)
    .await?)
}

/// `user_roles ur` rows whose instance role carries the permission bound as `$2`.
const CONSOLE_GRANT: &str = "SELECT 1 FROM user_roles ur \
     JOIN roles r ON r.key = ur.role_key AND r.key LIKE 'app:%' \
     JOIN role_permissions rp ON rp.role_id = r.id \
     JOIN permissions p ON p.id = rp.permission_id AND p.key = $2";

/// A console session stays valid only while the user's own session
/// is active, the user is not banned and still holds console access. One query
/// per Backend API request, so revoking any of the three takes effect at once.
async fn console_user_still_allowed(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<bool> {
    let session = sqlx::query_as::<_, SessionRow>(&format!(
        "SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id \
         WHERE s.id = $3 AND s.user_id = $1 AND s.status = 'active' AND NOT u.banned \
         AND EXISTS ({CONSOLE_GRANT} WHERE ur.user_id = u.id)"
    ))
    .bind(user_id)
    .bind(DASHBOARD_ACCESS)
    .bind(session_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(session.is_some_and(|row| !is_session_expired(state, &row)))
}

/// Revokes the session behind this request, if any. Idempotent.
pub async fn revoke_operator_session(state: &AppState, headers: &HeaderMap) -> Result<bool> {
    let Some(token) = operator_token(headers) else {
        return Ok(false);
    };
    let now_ms = now();
    let revoked = sqlx::query_scalar::<_, String>(
        "UPDATE operator_sessions SET revoked_at = $1, updated_at = $1 \
         WHERE token_hash = $2 AND revoked_at IS NULL RETURNING id",
    )
    .bind(now_ms)
    .bind(orbitid_core::crypto::sha256(&token))
    .fetch_optional(&state.pool)
    .await?;
    Ok(revoked.is_some())
}

/// Revokes every console session for the current secret key.
pub async fn revoke_all_operator_sessions(state: &AppState) -> Result<()> {
    let now_ms = now();
    sqlx::query(
        "UPDATE operator_sessions SET revoked_at = $1, updated_at = $1 \
         WHERE key_fingerprint = $2 AND revoked_at IS NULL",
    )
    .bind(now_ms)
    .bind(key_fingerprint(&state.env.secret_key))
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Removes rows that can no longer authenticate anyone. Best effort.
pub async fn sweep_operator_sessions(state: &AppState) -> Result<()> {
    let now_ms = now();
    sqlx::query("DELETE FROM operator_sessions WHERE expires_at <= $1 OR revoked_at IS NOT NULL")
        .bind(now_ms)
        .execute(&state.pool)
        .await?;
    Ok(())
}

fn origin_of(value: &str) -> Option<String> {
    url::Url::parse(value)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// A cookie is an ambient credential, so a request that uses one must provably
/// come from this instance's own origin.
pub fn operator_cookie_origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    if let Some(fetch_site) = header(headers, "sec-fetch-site") {
        let fetch_site = fetch_site.to_lowercase();
        if fetch_site != "same-origin" && fetch_site != "none" {
            return false;
        }
    }
    let Some(own) = origin_of(&state.env.base_url) else {
        return false;
    };
    if let Some(origin) = header(headers, "origin") {
        return origin_of(&origin).as_deref() == Some(own.as_str());
    }
    if let Some(referer) = header(headers, "referer") {
        return origin_of(&referer).as_deref() == Some(own.as_str());
    }
    true
}

/// The hook core's `require_secret_key` calls for operator-cookie requests.
#[derive(Debug, Default)]
pub struct OperatorSessionHook;

#[async_trait::async_trait]
impl OperatorSessionChecker for OperatorSessionHook {
    fn cookie_origin_allowed(&self, state: &AppState, headers: &HeaderMap) -> bool {
        operator_cookie_origin_allowed(state, headers)
    }

    async fn find(&self, state: &AppState, headers: &HeaderMap) -> Result<bool> {
        Ok(find_operator_session(state, headers).await?.is_some())
    }
}

/// Installs the operator-session hook (called by [`crate::install`]).
pub fn install_operator_session_checker(state: &AppState) {
    state.set_operator_session_checker(Arc::new(OperatorSessionHook));
}
