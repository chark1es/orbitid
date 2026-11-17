//! Remembered browsers that may skip the second factor until their token
//! expires. Ported from `services/trusted-devices.ts`.
//!
//! Only the sha256 of the opaque token is stored; the plaintext lives in an
//! HttpOnly cookie. Redeeming rotates the token with a single compare-and-set,
//! so a replayed (stolen) token cannot be redeemed twice.

use axum::http::HeaderMap;
use orbitid_core::error::Result;
use orbitid_core::http::cookies::{clear_cookie, get_cookie, set_cookie, CookieOptions, SameSite};
use orbitid_core::http::{now, request_is_secure};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::keys::cookies;
use orbitid_core::models::TrustedDeviceRow;
use orbitid_core::state::AppState;

/// A short, human label such as "Safari on macOS", taken from the user agent.
/// The vocabulary is fixed, so a hostile agent cannot inject markup.
pub fn trusted_device_label(user_agent: Option<&str>) -> String {
    let Some(ua) = user_agent.filter(|value| !value.is_empty()) else {
        return "Trusted browser".into();
    };
    let lower = ua.to_lowercase();
    let os = if lower.contains("iphone") || lower.contains("ipod") {
        Some("iOS")
    } else if lower.contains("ipad") {
        Some("iPadOS")
    } else if lower.contains("android") {
        Some("Android")
    } else if lower.contains("windows") {
        Some("Windows")
    } else if lower.contains("mac os x") || lower.contains("macintosh") {
        Some("macOS")
    } else if lower.contains("cros") {
        Some("ChromeOS")
    } else if lower.contains("linux") || lower.contains("x11") {
        Some("Linux")
    } else {
        None
    };
    let browser = if lower.contains("edg/") || lower.contains("edge/") || lower.contains("edgios/")
    {
        Some("Edge")
    } else if lower.contains("opr/") || lower.contains("opera") {
        Some("Opera")
    } else if lower.contains("firefox") || lower.contains("fxios") {
        Some("Firefox")
    } else if lower.contains("chrome") || lower.contains("crios") || lower.contains("chromium") {
        Some("Chrome")
    } else if lower.contains("safari") {
        Some("Safari")
    } else {
        None
    };
    match (browser, os) {
        (Some(browser), Some(os)) => format!("{browser} on {os}"),
        (Some(browser), None) => browser.to_string(),
        (None, Some(os)) => format!("Browser on {os}"),
        (None, None) => "Trusted browser".to_string(),
    }
}

/// Not revoked and not past its expiry.
pub fn trusted_device_valid(row: &TrustedDeviceRow, at: i64) -> bool {
    row.revoked_at.is_none() && row.expires_at > at
}

/// Sets the trusted-device cookie (API host, HttpOnly, SameSite=Lax, Secure
/// over https).
pub fn set_trusted_device_cookie(
    headers: &mut HeaderMap,
    state: &AppState,
    token: &str,
    expires_at: i64,
) {
    let max_age = ((expires_at - now()) / 1000).max(1);
    let options = CookieOptions {
        path: "/".into(),
        http_only: true,
        secure: request_is_secure(headers, &state.env.base_url, state.env.trust_proxy),
        same_site: SameSite::Lax,
        max_age: Some(max_age),
        domain: None,
    };
    orbitid_core::http::cookies::append_cookie(
        headers,
        set_cookie(cookies::TRUSTED_DEVICE, token, &options),
    );
}

pub fn clear_trusted_device_cookie(headers: &mut HeaderMap, state: &AppState) {
    let secure = request_is_secure(headers, &state.env.base_url, state.env.trust_proxy);
    orbitid_core::http::cookies::append_cookie(
        headers,
        clear_cookie(cookies::TRUSTED_DEVICE, "/", secure),
    );
}

/// The device token presented by this request, if any.
pub fn read_trusted_device_token(headers: &HeaderMap) -> Option<String> {
    get_cookie(headers, cookies::TRUSTED_DEVICE)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Sets or clears the trusted-device cookie from a first-factor result.
#[derive(Clone, Default)]
pub struct TrustedDeviceCookie {
    pub token: Option<String>,
    pub expires_at: Option<i64>,
    pub clear: bool,
}

impl std::fmt::Debug for TrustedDeviceCookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedDeviceCookie")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("clear", &self.clear)
            .finish()
    }
}

pub fn apply_trusted_device_cookie(
    headers: &mut HeaderMap,
    state: &AppState,
    result: &TrustedDeviceCookie,
) {
    if let (Some(token), Some(expires_at)) = (&result.token, result.expires_at) {
        set_trusted_device_cookie(headers, state, token, expires_at);
    } else if result.clear {
        clear_trusted_device_cookie(headers, state);
    }
}

/// Creates a remembered browser for `user_id` (`now + trustedDeviceDays`).
pub async fn issue_trusted_device(
    state: &AppState,
    user_id: &str,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<(TrustedDeviceRow, String)> {
    let now_ms = now();
    let token = orbitid_core::crypto::random_token(32);
    let id = new_id(id_prefix::TRUSTED_DEVICE);
    let expires_at = now_ms + state.settings.get().session.trusted_device_days * 24 * 3600 * 1000;
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, user_agent, ip_address, \
         expires_at, last_used_at, revoked_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$8)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(orbitid_core::crypto::sha256(&token))
    .bind(trusted_device_label(user_agent))
    .bind(user_agent)
    .bind(ip)
    .bind(expires_at)
    .bind(now_ms)
    .execute(&state.pool)
    .await?;
    let row = sqlx::query_as::<_, TrustedDeviceRow>("SELECT * FROM trusted_devices WHERE id = $1")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    Ok((row, token))
}

/// Validates a device token for `user_id` and rotates its value (the expiry
/// never slides). The rotate is one compare-and-set.
pub async fn redeem_trusted_device(
    state: &AppState,
    token: &str,
    user_id: &str,
) -> Result<Option<(TrustedDeviceRow, String)>> {
    if token.is_empty() {
        return Ok(None);
    }
    let now_ms = now();
    let rotated = orbitid_core::crypto::random_token(32);
    let row = sqlx::query_as::<_, TrustedDeviceRow>(
        "UPDATE trusted_devices SET token_hash = $1, last_used_at = $2, updated_at = $2 \
         WHERE token_hash = $3 AND user_id = $4 AND revoked_at IS NULL AND expires_at > $2 \
         RETURNING *",
    )
    .bind(orbitid_core::crypto::sha256(&rotated))
    .bind(now_ms)
    .bind(orbitid_core::crypto::sha256(token))
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|row| (row, rotated)))
}

pub async fn list_trusted_devices(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<TrustedDeviceRow>> {
    let now_ms = now();
    Ok(sqlx::query_as::<_, TrustedDeviceRow>(
        "SELECT * FROM trusted_devices \
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2 \
         ORDER BY created_at DESC",
    )
    .bind(user_id)
    .bind(now_ms)
    .fetch_all(&state.pool)
    .await?)
}

/// Revokes one device, scoped to its owner so another user's device is never
/// touched.
pub async fn revoke_trusted_device(
    state: &AppState,
    user_id: &str,
    id: &str,
) -> Result<Option<TrustedDeviceRow>> {
    let now_ms = now();
    Ok(sqlx::query_as::<_, TrustedDeviceRow>(
        "UPDATE trusted_devices SET revoked_at = $1, updated_at = $1 \
         WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL RETURNING *",
    )
    .bind(now_ms)
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?)
}

/// Revokes every remembered browser of a user (password change, second-factor
/// reset, ban/lock).
pub async fn revoke_all_trusted_devices(state: &AppState, user_id: &str) -> Result<i64> {
    let mut conn = state.pool.acquire().await?;
    revoke_all_trusted_devices_on(&mut conn, user_id).await
}

/// [`revoke_all_trusted_devices`] on a caller-owned connection.
pub async fn revoke_all_trusted_devices_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<i64> {
    let now_ms = now();
    let rows: Vec<String> = sqlx::query_scalar(
        "UPDATE trusted_devices SET revoked_at = $1, updated_at = $1 \
         WHERE user_id = $2 AND revoked_at IS NULL RETURNING id",
    )
    .bind(now_ms)
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.len() as i64)
}
