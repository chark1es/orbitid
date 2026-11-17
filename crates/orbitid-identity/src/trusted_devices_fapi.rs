//! Transactional trusted-device variants used by the Frontend API crates.
//!
//! [`crate::trusted_devices`] has the canonical helpers; these join a caller's
//! transaction so a rotating redemption or a fresh issue commits with the
//! session/attempt change that caused it.

use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::TrustedDeviceRow;
use orbitid_core::state::AppState;

use crate::trusted_devices::trusted_device_label;

/// Redeems a rotating trusted-device token on a caller-owned connection.
pub async fn redeem_trusted_device_on(
    conn: &mut sqlx::PgConnection,
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
    .fetch_optional(&mut *conn)
    .await?;
    let _ = state;
    Ok(row.map(|row| (row, rotated)))
}

/// Issues a remembered browser on a caller-owned connection, so the device row
/// commits with the second-factor verification that justified it.
pub async fn issue_trusted_device_on(
    conn: &mut sqlx::PgConnection,
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
    .execute(&mut *conn)
    .await?;
    let row = sqlx::query_as::<_, TrustedDeviceRow>("SELECT * FROM trusted_devices WHERE id = $1")
        .bind(&id)
        .fetch_one(&mut *conn)
        .await?;
    Ok((row, token))
}
