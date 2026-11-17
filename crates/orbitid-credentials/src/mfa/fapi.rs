//! Transactional MFA primitives for the Frontend API crates.
//!
//! The canonical helpers live in [`super`]; these `_on` variants join a caller's
//! transaction so a consumed TOTP step / backup code commits together with the
//! session reverification or completion it authorized.

use orbitid_core::crypto::decrypt;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;

/// Authenticates a TOTP code and consumes its time step on a caller-owned
/// connection. A step that is not strictly newer is rejected like a wrong code.
pub async fn verify_totp_once_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    code: &str,
) -> Result<bool> {
    let Some(step) = super::matched_totp_step(state, user, code) else {
        return Ok(false);
    };
    let updated = sqlx::query(
        "UPDATE users SET totp_last_used_step = $1, updated_at = $2 \
         WHERE id = $3 AND (totp_last_used_step IS NULL OR totp_last_used_step < $1)",
    )
    .bind(step)
    .bind(now())
    .bind(&user.id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(updated == 1)
}

/// Spends a backup code on a caller-owned connection with the same
/// compare-and-set on the serialized array as [`super::consume_backup_code`].
pub async fn consume_backup_code_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    code: &str,
) -> Result<bool> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(user) = user else {
        return Ok(false);
    };
    let Some(hashes) = user.backup_codes.as_ref().map(|codes| codes.0.clone()) else {
        return Ok(false);
    };
    let hash = super::hash_backup_code(code);
    if !hashes.contains(&hash) {
        return Ok(false);
    }
    let remaining: Vec<String> = hashes
        .iter()
        .filter(|value| **value != hash)
        .cloned()
        .collect();
    let result = sqlx::query(
        "UPDATE users SET backup_codes = $1, updated_at = $2 \
         WHERE id = $3 AND backup_codes = $4",
    )
    .bind(sqlx::types::Json(&remaining))
    .bind(now())
    .bind(user_id)
    .bind(sqlx::types::Json(&hashes))
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Confirms TOTP enrollment on a caller-owned connection: reloads the pending
/// secret under a row lock, checks the code, persists `totp_verified`, the
/// fresh backup codes and the consumed step, and returns the plaintext codes.
pub async fn finish_totp_setup_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    code: &str,
) -> Result<Vec<String>> {
    let current = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE")
        .bind(&user.id)
        .fetch_optional(&mut *conn)
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
    let Some(step) = super::totp_matching_step(&secret, code, now() / 1000) else {
        return Err(code_incorrect());
    };
    let codes = super::generate_backup_codes(10);
    let updated = sqlx::query(
        "UPDATE users SET totp_verified = true, backup_codes = $1, \
         totp_last_used_step = $2, updated_at = $3 \
         WHERE id = $4 AND (totp_last_used_step IS NULL OR totp_last_used_step < $2)",
    )
    .bind(sqlx::types::Json(&codes.hashed))
    .bind(step)
    .bind(now())
    .bind(&user.id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(code_incorrect());
    }
    Ok(codes.plain)
}

fn code_incorrect() -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        error_codes::FORM_CODE_INCORRECT,
        "That verification code is incorrect",
    )
    .with_meta(serde_json::json!({ "param_name": "code" }))
}

/// Verified phones usable as a second factor, read on a caller's connection.
pub async fn verified_second_factor_phones_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    exclude_phone_id: Option<&str>,
) -> Result<Vec<orbitid_core::models::PhoneNumberRow>> {
    let rows = sqlx::query_as::<_, orbitid_core::models::PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
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

/// [`super::user_has_mfa`] on a caller's connection: the same boolean decision,
/// read without acquiring a pool connection.
pub async fn user_has_mfa_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
) -> Result<bool> {
    if user.totp_verified {
        return Ok(true);
    }
    let phones: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM phone_numbers \
         WHERE user_id = $1 AND verified = true AND reserved_for_second_factor = true",
    )
    .bind(&user.id)
    .fetch_one(&mut *conn)
    .await?;
    if phones > 0 {
        return Ok(true);
    }
    let settings = state.settings.get();
    if settings.attributes.email_address.enabled
        && settings.attributes.email_address.used_for_second_factor
    {
        let emails: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM email_addresses WHERE user_id = $1 AND verified = true",
        )
        .bind(&user.id)
        .fetch_one(&mut *conn)
        .await?;
        if emails > 0 {
            return Ok(true);
        }
    }
    Ok(user
        .backup_codes
        .as_ref()
        .is_some_and(|codes| !codes.0.is_empty()))
}

/// [`super::supported_second_factors`] on a caller's connection: the same
/// discovery, read without acquiring a pool connection.
pub async fn supported_second_factors_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    options: super::SecondFactorOptions,
) -> Result<Vec<orbitid_core::resources::SignInFactor>> {
    use orbitid_core::resources::SignInFactor;
    let mut factors = Vec::new();
    let channel = super::first_factor_channel(options.first_factor_strategy.as_deref());
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
    if !exclude_all_phones {
        for phone in verified_second_factor_phones_on(conn, &user.id, exclude_phone).await? {
            factors.push(SignInFactor {
                strategy: "phone_code".into(),
                email_address_id: None,
                safe_identifier: None,
                phone_number_id: Some(phone.id),
                primary: None,
                default: Some(phone.default_second_factor),
            });
        }
    }
    let settings = state.settings.get();
    if !exclude_all_emails
        && settings.attributes.email_address.enabled
        && settings.attributes.email_address.used_for_second_factor
    {
        let rows = sqlx::query_as::<_, orbitid_core::models::EmailAddressRow>(
            "SELECT * FROM email_addresses WHERE user_id = $1 ORDER BY created_at ASC",
        )
        .bind(&user.id)
        .fetch_all(&mut *conn)
        .await?;
        for email in rows
            .into_iter()
            .filter(|email| email.verified && Some(email.id.as_str()) != exclude_email)
        {
            factors.push(SignInFactor {
                strategy: "email_code".into(),
                email_address_id: Some(email.id.clone()),
                safe_identifier: Some(super::mask_email(&email.email)),
                phone_number_id: None,
                primary: Some(Some(&email.id) == user.primary_email_address_id.as_ref()),
                default: None,
            });
        }
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
