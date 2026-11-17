//! Transactional verification lookups for the Frontend API crates.
//!
//! The canonical lookup lives in [`crate::verifications`]; this `_on` variant
//! reads the most recent row on a caller's connection so a handler can claim a
//! code and advance its own state machine in one transaction.

use orbitid_core::error::Result;
use orbitid_core::models::VerificationRow;

/// Most recent verification for a purpose/owner (optionally one identifier).
pub async fn get_verification_on(
    conn: &mut sqlx::PgConnection,
    purpose: &str,
    owner_id: &str,
    identifier: Option<&str>,
) -> Result<Option<VerificationRow>> {
    let row = match identifier {
        Some(identifier) => {
            sqlx::query_as::<_, VerificationRow>(
                "SELECT * FROM verifications \
                 WHERE purpose = $1 AND owner_id = $2 AND identifier = $3 \
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(purpose)
            .bind(owner_id)
            .bind(identifier)
            .fetch_optional(&mut *conn)
            .await?
        }
        None => {
            sqlx::query_as::<_, VerificationRow>(
                "SELECT * FROM verifications WHERE purpose = $1 AND owner_id = $2 \
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(purpose)
            .bind(owner_id)
            .fetch_optional(&mut *conn)
            .await?
        }
    };
    Ok(row)
}
