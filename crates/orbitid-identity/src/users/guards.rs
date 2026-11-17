//! Identification and lockout guards: "last identification", required
//! attributes, removal of an address/phone and failed-attempt accounting.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow, UserRow};
use orbitid_core::state::AppState;
use serde_json::json;

use crate::trusted_devices::revoke_all_trusted_devices_on;

pub async fn count_identifications(state: &AppState, user_id: &str) -> Result<i64> {
    let row: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(*) FROM email_addresses WHERE user_id = $1), \
         (SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1), \
         (SELECT COUNT(*) FROM external_accounts WHERE user_id = $1), \
         (SELECT COUNT(*) FROM passkeys WHERE user_id = $1 \
            AND credential_id NOT LIKE 'pending_%')",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    let username: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1 AND username IS NOT NULL")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(row.0 + row.1 + row.2 + row.3 + username)
}

/// Rejects removing the only way a user can sign in.
pub async fn assert_not_last_identification(state: &AppState, user_id: &str) -> Result<()> {
    if count_identifications(state, user_id).await? <= 1 {
        return Err(OrbitError::unprocessable(
            error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED,
            "You cannot remove your last identification",
        ));
    }
    Ok(())
}

/// A required attribute is a prerequisite for the account and cannot be
/// removed, even by an operator editing somebody else.
pub async fn assert_required_identifier_remains(
    state: &AppState,
    user_id: &str,
    kind: &str,
) -> Result<()> {
    let attributes = state.settings.get().attributes.clone();
    let required = if kind == "email_address" {
        attributes.email_address
    } else {
        attributes.phone_number
    };
    if !required.enabled || !required.required {
        return Ok(());
    }
    let remaining: i64 = if kind == "email_address" {
        sqlx::query_scalar("SELECT COUNT(*) FROM email_addresses WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?
    };
    if remaining <= 1 {
        let label = if kind == "email_address" {
            "An email address"
        } else {
            "A phone number"
        };
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("{label} is required for every account and cannot be removed."),
        )
        .with_meta(json!({ "param_name": kind })));
    }
    Ok(())
}

/// Profile fields that can be required by settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileField {
    FirstName,
    LastName,
    Username,
}

/// A required name/username must stay filled in when the user edits the
/// profile. `value`: `None` = field not present in the patch (skip);
/// `Some(None)` = explicit `null`; `Some(Some(value))` = new value.
pub fn assert_required_profile_field(
    state: &AppState,
    field: ProfileField,
    value: Option<Option<&str>>,
) -> Result<()> {
    let attributes = state.settings.get().attributes.clone();
    let (attr, param) = match field {
        ProfileField::FirstName => (attributes.first_name, "first_name"),
        ProfileField::LastName => (attributes.last_name, "last_name"),
        ProfileField::Username => (attributes.username, "username"),
    };
    let Some(value) = value else {
        return Ok(());
    };
    if !attr.enabled || !attr.required {
        return Ok(());
    }
    let empty = value.map(|value| value.trim().is_empty()).unwrap_or(true);
    if empty {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            format!("{param} is required on this instance and cannot be cleared"),
        )
        .with_meta(json!({ "param_name": param })));
    }
    Ok(())
}

pub async fn delete_email_address(state: &AppState, user_id: &str, email_id: &str) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    delete_email_address_on(&mut tx, state, user_id, email_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`delete_email_address`] on a caller-owned transaction. The user row is
/// locked first, so deleting the last email and the last external account
/// concurrently cannot both pass the "last identification" check.
pub async fn delete_email_address_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    email_id: &str,
) -> Result<()> {
    lock_user_identifications(conn, user_id).await?;
    let row = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Email address not found")
    })?;
    if count_identifications_on(conn, user_id).await? <= 1 {
        return Err(OrbitError::unprocessable(
            error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED,
            "You cannot remove your last identification",
        ));
    }
    assert_required_identifier_remains_on(conn, state, user_id, "email_address").await?;
    sqlx::query("DELETE FROM email_addresses WHERE id = $1")
        .bind(email_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE users SET primary_email_address_id = CASE \
             WHEN primary_email_address_id = $1 THEN \
                 (SELECT id FROM email_addresses WHERE user_id = $2 ORDER BY created_at LIMIT 1) \
             ELSE primary_email_address_id END, updated_at = $3 WHERE id = $2",
    )
    .bind(&row.id)
    .bind(user_id)
    .bind(now())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn delete_phone_number(state: &AppState, user_id: &str, phone_id: &str) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    delete_phone_number_on(&mut tx, state, user_id, phone_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`delete_phone_number`] on a caller-owned transaction (user row locked).
pub async fn delete_phone_number_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    phone_id: &str,
) -> Result<()> {
    lock_user_identifications(conn, user_id).await?;
    let row = sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(phone_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found")
    })?;
    if count_identifications_on(conn, user_id).await? <= 1 {
        return Err(OrbitError::unprocessable(
            error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED,
            "You cannot remove your last identification",
        ));
    }
    assert_required_identifier_remains_on(conn, state, user_id, "phone_number").await?;
    sqlx::query("DELETE FROM phone_numbers WHERE id = $1")
        .bind(phone_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE users SET primary_phone_number_id = CASE \
             WHEN primary_phone_number_id = $1 THEN \
                 (SELECT id FROM phone_numbers WHERE user_id = $2 ORDER BY created_at LIMIT 1) \
             ELSE primary_phone_number_id END, updated_at = $3 WHERE id = $2",
    )
    .bind(&row.id)
    .bind(user_id)
    .bind(now())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Serializes every "last identification" decision for one user. Exposed so
/// the external-account delete path uses exactly the same lock.
pub async fn lock_user_identifications(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

pub async fn count_identifications_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<i64> {
    let row: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(*) FROM email_addresses WHERE user_id = $1), \
         (SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1), \
         (SELECT COUNT(*) FROM external_accounts WHERE user_id = $1), \
         (SELECT COUNT(*) FROM passkeys WHERE user_id = $1 \
            AND credential_id NOT LIKE 'pending_%')",
    )
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;
    let username: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1 AND username IS NOT NULL")
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?;
    Ok(row.0 + row.1 + row.2 + row.3 + username)
}

async fn assert_required_identifier_remains_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    kind: &str,
) -> Result<()> {
    let attributes = state.settings.get().attributes.clone();
    let required = if kind == "email_address" {
        attributes.email_address
    } else {
        attributes.phone_number
    };
    if !required.enabled || !required.required {
        return Ok(());
    }
    let remaining: i64 = if kind == "email_address" {
        sqlx::query_scalar("SELECT COUNT(*) FROM email_addresses WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?
    } else {
        sqlx::query_scalar("SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?
    };
    if remaining <= 1 {
        let label = if kind == "email_address" {
            "An email address"
        } else {
            "A phone number"
        };
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("{label} is required for every account and cannot be removed."),
        )
        .with_meta(json!({ "param_name": kind })));
    }
    Ok(())
}

/// Locks the account after too many failed attempts.
///
/// The whole decision runs in one transaction with the user row locked: the
/// increment, the threshold check, the lockout write and the trusted-browser
/// revocation either commit together or not at all. Parallel wrong passwords
/// therefore cannot lose an increment, lock the account below the configured
/// threshold, or leave a locked account with a live trusted browser.
pub async fn record_failed_attempt(state: &AppState, user_id: &str) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    record_failed_attempt_on(&mut tx, state, user_id).await?;
    tx.commit().await?;
    // Mark only after the commit: a replay skips this counter only when the
    // earlier attempt really made it durable.
    orbitid_core::http::replay::mark_failed_attempt_committed(user_id);
    Ok(())
}

/// [`record_failed_attempt`] on a caller-owned transaction (sign-in attempt
/// completion), so the counter and its side effects join the caller's work.
pub async fn record_failed_attempt_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
) -> Result<()> {
    // A whole-request replay must not count the same wrong password twice, but
    // only when the earlier attempt actually committed the counter. If it
    // deadlocked before this point (or rolled its transaction back), the replay
    // must record the failure or a wrong guess would go uncounted.
    if orbitid_core::http::replay::is_replay()
        && orbitid_core::http::replay::failed_attempt_committed(user_id)
    {
        return Ok(());
    }
    let settings = state.settings.get();
    let now_ms = now();
    // Row lock: concurrent failures serialize, so the threshold is crossed
    // exactly once and no increment is erased by the reset that follows it.
    let current = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(current) = current else {
        return Ok(());
    };
    sqlx::query(
        "UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = $1 WHERE id = $2",
    )
    .bind(now_ms)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    if current.failed_attempts + 1 < settings.mfa.max_attempts {
        return Ok(());
    }
    sqlx::query(
        "UPDATE users SET failed_attempts = 0, locked = true, lockout_expires_at = $1, \
         updated_at = $2 WHERE id = $3",
    )
    .bind(now_ms + settings.mfa.lockout_duration_seconds * 1000)
    .bind(now_ms)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    // A locked account must not keep a browser that can walk past the second factor.
    revoke_all_trusted_devices_on(conn, user_id).await?;
    Ok(())
}

pub async fn reset_failed_attempts(state: &AppState, user_id: &str) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    reset_failed_attempts_on(&mut conn, user_id).await
}

/// [`reset_failed_attempts`] on a caller-owned connection.
pub async fn reset_failed_attempts_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE users SET failed_attempts = 0, locked = false, lockout_expires_at = NULL, \
         updated_at = $1 WHERE id = $2",
    )
    .bind(now())
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Optional user timestamp patch. `None` leaves the column unchanged.
#[derive(Debug, Clone, Copy, Default)]
pub struct TouchUserPatch {
    pub last_active_at: Option<i64>,
    pub last_sign_in_at: Option<i64>,
}

pub async fn touch_user(state: &AppState, user_id: &str, patch: TouchUserPatch) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    touch_user_on(&mut conn, user_id, patch).await
}

pub async fn touch_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    patch: TouchUserPatch,
) -> Result<()> {
    sqlx::query(
        "UPDATE users SET last_active_at = COALESCE($1, last_active_at), \
         last_sign_in_at = COALESCE($2, last_sign_in_at), updated_at = $3 WHERE id = $4",
    )
    .bind(patch.last_active_at)
    .bind(patch.last_sign_in_at)
    .bind(now())
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
