//! TOTP, backup codes and second-factor discovery, ported from
//! `services/mfa.ts`.
//!
//! Secrets are base32 (no padding) like `otplib`, codes are 6 digits with a
//! ±1 step window, and backup codes are 10 characters from the same 32-symbol
//! alphabet, stored as plain SHA-256 hashes. Everything the TypeScript server
//! wrote remains readable.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use orbitid_core::crypto::{decrypt, encrypt};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow, UserRow};
use orbitid_core::resources::SignInFactor;
use orbitid_core::AppState;

use crate::limits::run_cpu;

mod backup;
pub mod fapi;
mod totp;

/// A newly generated TOTP secret plus what the UI needs to display it.
#[derive(Clone, Serialize, Deserialize)]
pub struct TotpSetup {
    pub secret: String,
    pub uri: String,
    pub qr_code: String,
}

impl std::fmt::Debug for TotpSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpSetup")
            .field("secret", &"<redacted>")
            .field("uri", &self.uri)
            .field("qr_code", &self.qr_code)
            .finish()
    }
}

pub use backup::{
    consume_backup_code, generate_backup_codes, hash_backup_code, regenerate_backup_codes,
    BackupCodes,
};
pub use totp::{
    check_totp_against_secret, generate_totp_secret, qr_code_data_url, totp_code_at,
    totp_matching_step, totp_uri, verify_totp_code_at,
};

// ───────────── discovery ─────────────

/// `ada@example.com` → `a***@example.com`.
pub fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return email.to_string();
    };
    let first: String = local.chars().take(1).collect();
    format!(
        "{first}{}@{domain}",
        "*".repeat(3usize.max(local.chars().count().saturating_sub(1)))
    )
}

/// The channel a first-factor strategy belongs to.
pub fn first_factor_channel(strategy: Option<&str>) -> Option<&'static str> {
    match strategy {
        Some("email_code" | "email_link" | "reset_password_email_code") => Some("email"),
        Some("phone_code" | "reset_password_phone_code") => Some("phone"),
        _ => None,
    }
}

/// Options for [`supported_second_factors`].
#[derive(Debug, Clone, Default)]
pub struct SecondFactorOptions {
    pub first_factor_strategy: Option<String>,
    pub first_factor_email_id: Option<String>,
    pub first_factor_phone_id: Option<String>,
}

/// Verified phones usable as a second factor.
pub async fn verified_second_factor_phones(
    pool: &PgPool,
    user_id: &str,
    exclude_phone_id: Option<&str>,
) -> Result<Vec<PhoneNumberRow>> {
    let rows = sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|phone| {
            phone.verified
                && phone.reserved_for_second_factor
                && Some(phone.id.as_str()) != exclude_phone_id
        })
        .collect())
}

/// Verified email addresses usable as a second factor, when the instance
/// enables `attributes.emailAddress.usedForSecondFactor`.
pub async fn email_second_factors(
    state: &AppState,
    user_id: &str,
    exclude_email_id: Option<&str>,
) -> Result<Vec<EmailAddressRow>> {
    let settings = state.settings.get();
    if !settings.attributes.email_address.enabled
        || !settings.attributes.email_address.used_for_second_factor
    {
        return Ok(Vec::new());
    }
    let rows = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|email| email.verified && Some(email.id.as_str()) != exclude_email_id)
        .collect())
}

/// Second factors the user can actually perform, in priority order.
pub async fn supported_second_factors(
    state: &AppState,
    user: &UserRow,
    options: SecondFactorOptions,
) -> Result<Vec<SignInFactor>> {
    let mut factors = Vec::new();
    let channel = first_factor_channel(options.first_factor_strategy.as_deref());
    let exclude_all_phones = channel == Some("phone") && options.first_factor_phone_id.is_none();
    let exclude_all_emails = channel == Some("email") && options.first_factor_email_id.is_none();
    let exclude_phone = if channel == Some("phone") {
        options.first_factor_phone_id.as_deref()
    } else {
        None
    };
    let exclude_email = if channel == Some("email") {
        options.first_factor_email_id.as_deref()
    } else {
        None
    };
    if user.totp_verified {
        factors.push(SignInFactor {
            strategy: "totp".into(),
            email_address_id: None,
            safe_identifier: None,
            phone_number_id: None,
            primary: None,
            default: None,
        });
    }
    let phones = if exclude_all_phones {
        Vec::new()
    } else {
        verified_second_factor_phones(&state.pool, &user.id, exclude_phone).await?
    };
    for phone in phones {
        factors.push(SignInFactor {
            strategy: "phone_code".into(),
            email_address_id: None,
            safe_identifier: None,
            phone_number_id: Some(phone.id),
            primary: None,
            default: Some(phone.default_second_factor),
        });
    }
    let emails = if exclude_all_emails {
        Vec::new()
    } else {
        email_second_factors(state, &user.id, exclude_email).await?
    };
    for email in emails {
        factors.push(SignInFactor {
            strategy: "email_code".into(),
            email_address_id: Some(email.id.clone()),
            safe_identifier: Some(mask_email(&email.email)),
            phone_number_id: None,
            primary: Some(Some(&email.id) == user.primary_email_address_id.as_ref()),
            default: None,
        });
    }
    if user
        .backup_codes
        .as_ref()
        .is_some_and(|codes| !codes.0.is_empty())
    {
        factors.push(SignInFactor {
            strategy: "backup_code".into(),
            email_address_id: None,
            safe_identifier: None,
            phone_number_id: None,
            primary: None,
            default: None,
        });
    }
    Ok(factors)
}

/// Whether the user has any usable second factor.
pub async fn user_has_mfa(state: &AppState, user: &UserRow) -> Result<bool> {
    Ok(
        !supported_second_factors(state, user, SecondFactorOptions::default())
            .await?
            .is_empty(),
    )
}

/// `mfa.required` only bites when the instance offers a factor the user could
/// enrol.
pub async fn mfa_enrollment_required(state: &AppState, user: &UserRow) -> Result<bool> {
    let settings = state.settings.get();
    let can_enrol = settings.attributes.authenticator_app.enabled
        || settings.attributes.phone_number.used_for_second_factor;
    Ok(settings.mfa.required && can_enrol && !user_has_mfa(state, user).await?)
}

/// [`mfa_enrollment_required`] on a caller-supplied connection, so session
/// creation can run inside a transaction without taking another pool
/// connection.
pub async fn mfa_enrollment_required_on(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    user: &UserRow,
) -> Result<bool> {
    let settings = state.settings.get();
    let can_enrol = settings.attributes.authenticator_app.enabled
        || settings.attributes.phone_number.used_for_second_factor;
    if !(settings.mfa.required && can_enrol) {
        return Ok(false);
    }
    if user.totp_verified {
        return Ok(false);
    }
    if user
        .backup_codes
        .as_ref()
        .is_some_and(|codes| !codes.0.is_empty())
    {
        return Ok(false);
    }
    let phone: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM phone_numbers WHERE user_id = $1 \
         AND verified = true AND reserved_for_second_factor = true)",
    )
    .bind(&user.id)
    .fetch_one(&mut *conn)
    .await?;
    if phone {
        return Ok(false);
    }
    if settings.attributes.email_address.enabled
        && settings.attributes.email_address.used_for_second_factor
    {
        let email: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM email_addresses WHERE user_id = $1 AND verified = true)",
        )
        .bind(&user.id)
        .fetch_one(&mut *conn)
        .await?;
        if email {
            return Ok(false);
        }
    }
    Ok(true)
}

// ───────────── enrollment ─────────────

/// Verifies a TOTP code against the user's stored (verified) secret.
///
/// Pure check: callers that authenticate a user must use
/// [`verify_totp_once`], which records the matched time step so the same code
/// cannot be replayed inside its ±1 step window.
pub fn verify_totp(state: &AppState, user: &UserRow, code: &str) -> bool {
    matched_totp_step(state, user, code).is_some()
}

fn matched_totp_step(state: &AppState, user: &UserRow, code: &str) -> Option<i64> {
    if !user.totp_verified {
        return None;
    }
    let encrypted = user.totp_secret_enc.as_deref()?;
    let secret = decrypt(&state.env.encryption_key, encrypted).ok()?;
    totp_matching_step(&secret, code, now() / 1000)
}

/// Authenticates a TOTP code and consumes its time step atomically.
///
/// The conditional update is safe across replicas: a code whose step is not
/// strictly newer than `users.totp_last_used_step` is rejected exactly like a
/// wrong code (0 rows updated, `Ok(false)`). This applies to sign-in second
/// factors, reverification and enrollment confirmation.
pub async fn verify_totp_once(state: &AppState, user: &UserRow, code: &str) -> Result<bool> {
    let Some(step) = matched_totp_step(state, user, code) else {
        return Ok(false);
    };
    let updated = sqlx::query(
        "UPDATE users SET totp_last_used_step = $1, updated_at = $2 \
         WHERE id = $3 AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)",
    )
    .bind(step)
    .bind(now())
    .bind(&user.id)
    .execute(&state.pool)
    .await?
    .rows_affected();
    Ok(updated == 1)
}

/// Creates (but does not enable) a TOTP secret for a user.
pub async fn start_totp_setup(state: &AppState, user: &UserRow) -> Result<TotpSetup> {
    let settings = state.settings.get();
    let secret = generate_totp_secret();
    let account = match &user.username {
        Some(username) => username.clone(),
        None => {
            let email = match &user.primary_email_address_id {
                Some(id) => {
                    sqlx::query_as::<_, EmailAddressRow>(
                        "SELECT * FROM email_addresses WHERE id = $1",
                    )
                    .bind(id)
                    .fetch_optional(&state.pool)
                    .await?
                }
                None => None,
            };
            email
                .map(|email| email.email)
                .unwrap_or_else(|| user.id.clone())
        }
    };
    let uri = totp_uri(&secret, &account, &settings.application.name);
    let qr_code = qr_code_data_url(&uri)?;
    let encryption_key = state.env.encryption_key.clone();
    let secret_for_encryption = secret.clone();
    let encrypted = run_cpu(move || encrypt(&encryption_key, &secret_for_encryption))
        .await?
        .map_err(|error| OrbitError::internal(format!("Could not encrypt TOTP secret: {error}")))?;
    sqlx::query(
        "UPDATE users SET totp_secret_enc = $1, totp_verified = false, \
         totp_last_used_step = NULL, updated_at = $2 WHERE id = $3",
    )
    .bind(encrypted)
    .bind(now())
    .bind(&user.id)
    .execute(&state.pool)
    .await?;
    Ok(TotpSetup {
        secret,
        uri,
        qr_code,
    })
}

/// Verifies a pending setup, enables TOTP and returns fresh backup codes.
pub async fn finish_totp_setup(
    state: &AppState,
    user: &UserRow,
    code: &str,
) -> Result<Vec<String>> {
    // Reload the row: `start_totp_setup` wrote the pending secret after the
    // caller may have loaded its copy of the user.
    let current = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await?;
    let user = current.as_ref().unwrap_or(user);
    let Some(encrypted) = user.totp_secret_enc.as_deref() else {
        return Err(OrbitError::bad_request(
            error_codes::TOTP_NOT_ENABLED,
            "TOTP has not been set up for this user",
        ));
    };
    let secret = decrypt(&state.env.encryption_key, encrypted).map_err(|_| {
        OrbitError::bad_request(
            error_codes::TOTP_NOT_ENABLED,
            "TOTP secret is unreadable; set up TOTP again",
        )
    })?;
    let Some(step) = totp_matching_step(&secret, code, now() / 1000) else {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_CODE_INCORRECT,
            "That verification code is incorrect",
        )
        .with_meta(serde_json::json!({ "param_name": "code" })));
    };
    let codes = generate_backup_codes(10);
    // Enrollment confirmation also consumes the step: once TOTP is enabled the
    // same code cannot be replayed as a sign-in second factor.
    let updated = sqlx::query(
        "UPDATE users SET totp_verified = true, backup_codes = $1, \
         totp_last_used_step = $2, updated_at = $3 \
         WHERE id = $4 AND (totp_last_used_step IS NULL OR totp_last_used_step < $2)",
    )
    .bind(sqlx::types::Json(&codes.hashed))
    .bind(step)
    .bind(now())
    .bind(&user.id)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_CODE_INCORRECT,
            "That verification code is incorrect",
        )
        .with_meta(serde_json::json!({ "param_name": "code" })));
    }
    Ok(codes.plain)
}

/// Disables TOTP and clears backup codes.
pub async fn disable_totp(pool: &PgPool, user_id: &str) -> Result<()> {
    let mut conn = pool.acquire().await?;
    disable_totp_on(&mut conn, user_id).await
}

/// [`disable_totp`] on a caller-owned connection, for a transaction that also
/// revokes trusted devices and writes the `user.updated` event.
pub async fn disable_totp_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE users SET totp_secret_enc = NULL, totp_verified = false, \
         totp_last_used_step = NULL, backup_codes = NULL, updated_at = $1 WHERE id = $2",
    )
    .bind(now())
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_email_addresses() {
        assert_eq!(mask_email("ada@example.com"), "a***@example.com");
        assert_eq!(mask_email("ab@example.com"), "a***@example.com");
        assert_eq!(mask_email("not-an-email"), "not-an-email");
    }
}
