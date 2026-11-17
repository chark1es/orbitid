//! User and identifier helpers, ported from `services/users.ts`.
//!
//! Split into cohesive submodules: lookup/normalisation here, creation and
//! deletion in `create`, and the "last/required identification"/lockout guards
//! in `guards`. Public names are re-exported unchanged.

pub mod create;
pub mod guards;
pub mod moderation;

pub use create::{
    after_user_created, create_user, create_user_claims_locked_on, create_user_on, delete_user,
    delete_user_on, emit_user_created_on, find_user_by_verified_email, has_verified_identifier,
    set_primary_email, set_primary_phone, upgrade_anonymous_user, upgrade_anonymous_user_on,
    CreateUserInput,
};
pub use guards::{
    assert_not_last_identification, assert_required_identifier_remains,
    assert_required_profile_field, count_identifications, count_identifications_on,
    delete_email_address, delete_email_address_on, delete_phone_number, delete_phone_number_on,
    lock_user_identifications, record_failed_attempt, record_failed_attempt_on,
    reset_failed_attempts, reset_failed_attempts_on, touch_user, touch_user_on, ProfileField,
    TouchUserPatch,
};
pub use moderation::{moderate_user, moderate_user_on, ModerationAction};

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow, UserRow};
use orbitid_core::state::AppState;

/// Lowercase + trim an email address.
pub fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Whether a value looks like an email address (same regex as the TS helper).
pub fn is_valid_email(value: &str) -> bool {
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !value.contains(char::is_whitespace)
        && domain.split('.').count() >= 2
        && domain
            .rsplit('.')
            .next()
            .map(|tld| !tld.is_empty())
            .unwrap_or(false)
}

/// Normalizes a phone number to E.164 (`+` + digits). Throws
/// `form_param_format_invalid` when it cannot be.
pub fn normalize_phone(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    let normalized = if trimmed.starts_with('+') {
        format!("+{digits}")
    } else if digits.len() == 10 {
        format!("+1{digits}")
    } else {
        format!("+{digits}")
    };
    let mut chars = normalized.chars();
    let valid = chars.next() == Some('+') && {
        let rest: String = chars.clone().collect();
        rest.len() >= 7
            && rest.len() <= 15
            && rest.chars().all(|ch| ch.is_ascii_digit())
            && !rest.starts_with('0')
    };
    if !valid {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "phone_number must be a valid E.164 number",
        )
        .with_meta(serde_json::json!({ "param_name": "phone_number" })));
    }
    Ok(normalized)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifierType {
    EmailAddress,
    PhoneNumber,
    Username,
}

impl IdentifierType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmailAddress => "email_address",
            Self::PhoneNumber => "phone_number",
            Self::Username => "username",
        }
    }
}

/// Best-effort detection of what a sign-in/sign-up `identifier` is.
pub fn detect_identifier_type(identifier: &str) -> IdentifierType {
    let value = identifier.trim();
    if value.contains('@') {
        return IdentifierType::EmailAddress;
    }
    let candidate: String = value
        .chars()
        .filter(|ch| !ch.is_whitespace() && !"().-".contains(*ch))
        .collect();
    if candidate.len() >= 6
        && candidate
            .chars()
            .next()
            .map(|ch| ch.is_ascii_digit() || ch == '+')
            == Some(true)
        && candidate.chars().all(|ch| ch.is_ascii_digit() || ch == '+')
    {
        return IdentifierType::PhoneNumber;
    }
    IdentifierType::Username
}

pub async fn get_user_by_id(state: &AppState, id: &str) -> Result<Option<UserRow>> {
    let mut conn = state.pool.acquire().await?;
    get_user_by_id_on(&mut conn, id).await
}

/// [`get_user_by_id`] on a caller-supplied connection (transaction-safe).
pub async fn get_user_by_id_on(conn: &mut sqlx::PgConnection, id: &str) -> Result<Option<UserRow>> {
    Ok(
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

pub async fn require_user(state: &AppState, id: &str) -> Result<UserRow> {
    let mut conn = state.pool.acquire().await?;
    require_user_on(&mut conn, id).await
}

pub async fn require_user_on(conn: &mut sqlx::PgConnection, id: &str) -> Result<UserRow> {
    get_user_by_id_on(conn, id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))
}

/// The row that owns an address. A verified row always wins; an unverified one
/// is returned only when nobody has verified the address.
pub async fn find_email(state: &AppState, email: &str) -> Result<Option<EmailAddressRow>> {
    let mut conn = state.pool.acquire().await?;
    find_email_on(&mut conn, email).await
}

pub async fn find_email_on(
    conn: &mut sqlx::PgConnection,
    email: &str,
) -> Result<Option<EmailAddressRow>> {
    let rows =
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE email = $1")
            .bind(normalize_email(email))
            .fetch_all(&mut *conn)
            .await?;
    Ok(rows
        .iter()
        .find(|row| row.verified)
        .cloned()
        .or_else(|| rows.into_iter().next()))
}

/// Removes other accounts' unverified claims on an address once it is verified.
///
/// Opens its own transaction and follows [`purge_unverified_claims_on`]'s lock
/// protocol: owners are determined with a plain read, locked in ascending id,
/// then purged under those locks.
pub async fn purge_unverified_claims(
    state: &AppState,
    email: &str,
    except_user_id: &str,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    let locked = lock_unverified_claim_owners_on(&mut tx, email, except_user_id, &[]).await?;
    purge_unverified_claims_on(&mut tx, email, except_user_id, &locked).await?;
    tx.commit().await?;
    Ok(())
}

/// Step 1 of a purge: a plain read of the other users that hold an unverified
/// claim on `email`, then `FOR UPDATE` on those users **and** `also_lock`
/// (normally the claimant), ascending id (rank 3). Call it before taking any
/// higher-rank lock (the verification row, rank 6). Returns the locked ids,
/// which [`purge_unverified_claims_on`] requires as its proof.
pub async fn lock_unverified_claim_owners_on(
    conn: &mut sqlx::PgConnection,
    email: &str,
    except_user_id: &str,
    also_lock: &[String],
) -> Result<Vec<String>> {
    let mut ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT user_id FROM email_addresses \
         WHERE email = $1 AND verified = false AND user_id IS NOT NULL AND user_id <> $2",
    )
    .bind(normalize_email(email))
    .bind(except_user_id)
    .fetch_all(&mut *conn)
    .await?;
    ids.extend(also_lock.iter().cloned());
    crate::locks::lock_users_on(conn, &ids).await
}

/// Step 2: deletes the other users' unverified claims whose owner is in
/// `locked_users` (the result of [`lock_unverified_claim_owners_on`]), clearing
/// the owner's primary pointer first. The rows are re-read under the locks, so
/// a claim that was verified or deleted meanwhile is left alone; a claim whose
/// owner appeared after the lock step is **not** touched (that user's row is not
/// locked, and writing it out of id order could deadlock) and simply stays an
/// unverified duplicate behind the now-verified address.
pub async fn purge_unverified_claims_on(
    conn: &mut sqlx::PgConnection,
    email: &str,
    except_user_id: &str,
    locked_users: &[String],
) -> Result<()> {
    let rows = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE email = $1 ORDER BY id",
    )
    .bind(normalize_email(email))
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        if row.verified || row.user_id.as_deref() == Some(except_user_id) {
            continue;
        }
        if let Some(user_id) = &row.user_id {
            if !locked_users.contains(user_id) {
                continue;
            }
            if let Some(owner) = get_user_by_id_on(conn, user_id).await? {
                if owner.primary_email_address_id.as_deref() == Some(row.id.as_str()) {
                    sqlx::query("UPDATE users SET primary_email_address_id = NULL WHERE id = $1")
                        .bind(user_id)
                        .execute(&mut *conn)
                        .await?;
                }
            }
        }
        sqlx::query("DELETE FROM email_addresses WHERE id = $1")
            .bind(&row.id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

pub async fn find_phone(state: &AppState, phone: &str) -> Result<Option<PhoneNumberRow>> {
    Ok(
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE phone = $1")
            .bind(normalize_phone(phone)?)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn list_emails(state: &AppState, user_id: &str) -> Result<Vec<EmailAddressRow>> {
    Ok(
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?,
    )
}

pub async fn list_phones(state: &AppState, user_id: &str) -> Result<Vec<PhoneNumberRow>> {
    Ok(
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?,
    )
}

pub async fn primary_email(state: &AppState, user: &UserRow) -> Result<Option<EmailAddressRow>> {
    if let Some(id) = &user.primary_email_address_id {
        if let Some(row) =
            sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?
        {
            return Ok(Some(row));
        }
    }
    Ok(list_emails(state, &user.id).await?.into_iter().next())
}

pub async fn primary_phone(state: &AppState, user: &UserRow) -> Result<Option<PhoneNumberRow>> {
    if let Some(id) = &user.primary_phone_number_id {
        if let Some(row) =
            sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?
        {
            return Ok(Some(row));
        }
    }
    Ok(list_phones(state, &user.id).await?.into_iter().next())
}

/// Finds a user by email address, phone number or username.
pub async fn get_user_by_identifier(
    state: &AppState,
    identifier: &str,
) -> Result<Option<(UserRow, IdentifierType)>> {
    let value = identifier.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let kind = detect_identifier_type(value);
    match kind {
        IdentifierType::EmailAddress => {
            let Some(email) = find_email(state, value).await? else {
                return Ok(None);
            };
            let Some(user_id) = email.user_id else {
                return Ok(None);
            };
            Ok(get_user_by_id(state, &user_id)
                .await?
                .map(|user| (user, kind)))
        }
        IdentifierType::PhoneNumber => {
            let Ok(phone) = normalize_phone(value) else {
                return Ok(None);
            };
            let row =
                sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE phone = $1")
                    .bind(phone)
                    .fetch_optional(&state.pool)
                    .await?;
            let Some(row) = row else {
                return Ok(None);
            };
            let Some(user_id) = row.user_id else {
                return Ok(None);
            };
            Ok(get_user_by_id(state, &user_id)
                .await?
                .map(|user| (user, kind)))
        }
        IdentifierType::Username => Ok(find_user_by_username(state, value)
            .await?
            .map(|user| (user, kind))),
    }
}

pub async fn find_user_by_username(state: &AppState, username: &str) -> Result<Option<UserRow>> {
    let mut conn = state.pool.acquire().await?;
    find_user_by_username_on(&mut conn, username).await
}

pub async fn find_user_by_username_on(
    conn: &mut sqlx::PgConnection,
    username: &str,
) -> Result<Option<UserRow>> {
    Ok(
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE username_lower = $1")
            .bind(username.to_lowercase())
            .fetch_optional(&mut *conn)
            .await?,
    )
}

fn valid_username_chars(username: &str) -> bool {
    !username.is_empty()
        && username
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
}

/// Username syntax + length + uniqueness. Throws `OrbitError`.
pub async fn assert_username_available(
    state: &AppState,
    username: &str,
    except_user_id: Option<&str>,
) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    assert_username_available_on(state, &mut conn, username, except_user_id).await
}

pub async fn assert_username_available_on(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    username: &str,
    except_user_id: Option<&str>,
) -> Result<()> {
    let settings = state.settings.get();
    let length = username.chars().count() as i64;
    if length < settings.username.min_length {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_USERNAME_INVALID_LENGTH,
            format!(
                "username must be at least {} characters",
                settings.username.min_length
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "username" })));
    }
    if length > settings.username.max_length {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_USERNAME_INVALID_LENGTH,
            format!(
                "username must be at most {} characters",
                settings.username.max_length
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "username" })));
    }
    if !valid_username_chars(username) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_USERNAME_INVALID_CHARACTER,
            "username may only contain letters, numbers, '_', '-' and '.'",
        )
        .with_meta(serde_json::json!({ "param_name": "username" })));
    }
    if let Some(existing) = find_user_by_username_on(conn, username).await? {
        if Some(existing.id.as_str()) != except_user_id {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "That username is taken",
            )
            .with_meta(serde_json::json!({ "param_name": "username" })));
        }
    }
    Ok(())
}
