//! Transactional passkey registration used by the Frontend API account routes.
//!
//! [`crate::passkeys::finish_passkey_registration`] verifies the attestation and
//! inserts the credential using several pool statements. The `_on` variant runs
//! the same ceremony on a caller-owned connection so the challenge claim, the
//! credential insert and its `user.updated` event commit as one unit: a crash
//! can never burn a challenge without creating the passkey (or vice versa).

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{PasskeyRow, VerificationRow};
use orbitid_core::state::AppState;

use super::challenges::{ceremony_relying_party, customer_id, stored_name, REGISTRATION_PURPOSE};
use super::webauthn;
use super::{AddPasskeyInput, FinishRegistrationInput};

fn registration_failure() -> OrbitError {
    OrbitError::bad_request(
        error_codes::PASSKEY_REGISTRATION_FAILURE,
        "Passkey registration could not be verified",
    )
}

/// Outcome of [`finish_passkey_registration_on`].
#[derive(Debug)]
pub enum PasskeyRegistration {
    Created(PasskeyRow),
    /// An application refusal (expired challenge, bad attestation, duplicate
    /// authenticator). The attempt counter was written in the caller's
    /// transaction, so the caller commits it. A database failure is never a
    /// refusal: it is the `Err` of the surrounding `Result`, and the caller
    /// rolls back and propagates it.
    Refused(OrbitError),
}

/// Finishes a registration ceremony on a caller-owned connection. The caller
/// must already hold the user's key-share lock (rank 3): the challenge claim
/// below locks a verification row (rank 6) before the credential insert
/// references the user. On a failed
/// attestation the claimed challenge is released (attempts stay counted) and a
/// [`PasskeyRegistration::Refused`] is returned; the caller commits so the
/// attempt counter persists.
pub async fn finish_passkey_registration_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    input: &FinishRegistrationInput,
) -> Result<PasskeyRegistration> {
    let _ = state;
    let stored = sqlx::query_as::<_, VerificationRow>(
        "SELECT * FROM verifications \
         WHERE purpose = $1 AND owner_id = $2 \
           AND verified_at IS NULL AND consumed_at IS NULL AND expires_at > $3 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(REGISTRATION_PURPOSE)
    .bind(&input.passkey_id)
    .bind(now())
    .fetch_optional(&mut *conn)
    .await?;
    let stored = match stored {
        Some(stored) if customer_id(&stored).as_deref() == Some(input.user_id.as_str()) => stored,
        _ => {
            return Ok(PasskeyRegistration::Refused(OrbitError::bad_request(
                error_codes::VERIFICATION_EXPIRED,
                "Passkey registration expired. Please try again.",
            )))
        }
    };
    let timestamp = now();
    let claimed = sqlx::query_as::<_, VerificationRow>(
        "UPDATE verifications SET consumed_at = $1, attempts = attempts + 1 \
         WHERE id = $2 AND verified_at IS NULL AND consumed_at IS NULL \
           AND attempts < max_attempts AND expires_at > $1 \
         RETURNING *",
    )
    .bind(timestamp)
    .bind(&stored.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(claimed) = claimed else {
        return Ok(PasskeyRegistration::Refused(OrbitError::bad_request(
            error_codes::VERIFICATION_EXPIRED,
            "Passkey registration expired. Please try again.",
        )));
    };
    let rp = match ceremony_relying_party(&claimed) {
        Ok(rp) => rp,
        Err(error) => return Ok(PasskeyRegistration::Refused(error)),
    };
    let info = match webauthn::verify_registration(
        &input.credential,
        &claimed.identifier,
        &rp.origin,
        &rp.rp_id,
        true,
    ) {
        Ok(info) => info,
        Err(_) => {
            sqlx::query("UPDATE verifications SET consumed_at = NULL WHERE id = $1")
                .bind(&claimed.id)
                .execute(&mut *conn)
                .await?;
            return Ok(PasskeyRegistration::Refused(registration_failure()));
        }
    };
    sqlx::query("UPDATE verifications SET verified_at = $1 WHERE id = $2")
        .bind(now())
        .bind(&claimed.id)
        .execute(&mut *conn)
        .await?;
    let duplicate: Option<String> =
        sqlx::query_scalar("SELECT id FROM passkeys WHERE credential_id = $1")
            .bind(&info.credential_id)
            .fetch_optional(&mut *conn)
            .await?;
    if duplicate.is_some() {
        return Ok(PasskeyRegistration::Refused(OrbitError::conflict(
            error_codes::PASSKEY_REGISTRATION_FAILURE,
            "This authenticator is already registered",
        )));
    }
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| stored_name(&claimed))
        .unwrap_or_else(|| "Passkey".to_string());
    let created = super::add_passkey_on(
        conn,
        &AddPasskeyInput {
            id: input.passkey_id.clone(),
            user_id: input.user_id.clone(),
            name,
            credential_id: info.credential_id,
            public_key: webauthn::b64_encode(&info.public_key),
            counter: info.counter,
            transports: info.transports,
            device_type: Some(info.device_type),
            backed_up: info.backed_up,
        },
    )
    .await?;
    Ok(PasskeyRegistration::Created(created))
}

/// Purpose string stored for passkey authentication challenges.
pub const AUTHENTICATION_PURPOSE: &str = "passkey_authentication";

/// Stores one passkey challenge row on a caller-owned connection, so the
/// ceremony it starts and the attempt state transition commit together.
pub async fn store_passkey_challenge_on(
    conn: &mut sqlx::PgConnection,
    purpose: &str,
    owner_id: &str,
    challenge: &str,
    data: serde_json::Value,
) -> Result<()> {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO verifications \
         (id, purpose, strategy, identifier, owner_id, data, attempts, max_attempts, expires_at, created_at) \
         VALUES ($1, $2, 'passkey', $3, $4, $5, 0, 5, $6, $7)",
    )
    .bind(orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION))
    .bind(purpose)
    .bind(challenge)
    .bind(owner_id)
    .bind(sqlx::types::Json(&data))
    .bind(timestamp + 5 * 60_000)
    .bind(timestamp)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
