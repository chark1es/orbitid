//! Passkey challenge rows (`verifications`) and their compare-and-set claim.

use serde_json::Value;
use sqlx::PgPool;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::VerificationRow;

use super::RelyingParty;

pub(crate) const CHALLENGE_TTL_MS: i64 = 5 * 60_000;
pub(crate) const REGISTRATION_PURPOSE: &str = "passkey_registration";
pub(crate) const AUTHENTICATION_PURPOSE: &str = "passkey_authentication";

pub(crate) async fn store_challenge(
    pool: &PgPool,
    purpose: &str,
    owner_id: &str,
    challenge: &str,
    data: Value,
) -> Result<()> {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO verifications \
         (id, purpose, strategy, identifier, owner_id, data, attempts, max_attempts, expires_at, created_at) \
         VALUES ($1, $2, 'passkey', $3, $4, $5, 0, 5, $6, $7)",
    )
    .bind(new_id(id_prefix::VERIFICATION))
    .bind(purpose)
    .bind(challenge)
    .bind(owner_id)
    .bind(sqlx::types::Json(&data))
    .bind(timestamp + CHALLENGE_TTL_MS)
    .bind(timestamp)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn load_challenge(
    pool: &PgPool,
    purpose: &str,
    owner_id: &str,
) -> Result<Option<VerificationRow>> {
    Ok(sqlx::query_as::<_, VerificationRow>(
        "SELECT * FROM verifications \
         WHERE purpose = $1 AND owner_id = $2 \
           AND verified_at IS NULL AND consumed_at IS NULL AND expires_at > $3 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(purpose)
    .bind(owner_id)
    .bind(now())
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn claim_challenge(pool: &PgPool, id: &str) -> Result<Option<VerificationRow>> {
    let timestamp = now();
    Ok(sqlx::query_as::<_, VerificationRow>(
        "UPDATE verifications SET consumed_at = $1, attempts = attempts + 1 \
         WHERE id = $2 AND verified_at IS NULL AND consumed_at IS NULL \
           AND attempts < max_attempts AND expires_at > $1 \
         RETURNING *",
    )
    .bind(timestamp)
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

pub(crate) async fn release_challenge(pool: &PgPool, id: &str) -> Result<()> {
    sqlx::query("UPDATE verifications SET consumed_at = NULL WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) async fn mark_verified(pool: &PgPool, id: &str) -> Result<()> {
    sqlx::query("UPDATE verifications SET verified_at = $1 WHERE id = $2")
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub(crate) fn ceremony_relying_party(row: &VerificationRow) -> Result<RelyingParty> {
    let data = row.data.as_ref().map(|data| &data.0);
    let rp_id = data
        .and_then(|data| data.get("rpID"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let origin = data
        .and_then(|data| data.get("origin"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if rp_id.is_empty() || origin.is_empty() {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_EXPIRED,
            "Passkey ceremony expired. Please try again.",
        ));
    }
    Ok(RelyingParty {
        rp_id: rp_id.to_string(),
        origin: origin.to_string(),
    })
}

pub(crate) fn stored_name(row: &VerificationRow) -> Option<String> {
    row.data
        .as_ref()
        .and_then(|data| data.0.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|name| !name.is_empty())
}

pub(crate) fn customer_id(row: &VerificationRow) -> Option<String> {
    row.data
        .as_ref()
        .and_then(|data| data.0.get("userId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}
