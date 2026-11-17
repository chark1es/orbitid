//! User creation, identification pointers and deletion.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow, UserRow};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;
use serde_json::json;

use super::{
    assert_username_available_on, find_email_on, get_user_by_id, get_user_by_id_on, is_valid_email,
    list_emails, list_phones, lock_unverified_claim_owners_on, normalize_email, normalize_phone,
    purge_unverified_claims_on, require_user_on,
};
use crate::orgs::on_user_email_verified;
use crate::serializers::{serialize_user_on, UserSerializeOptions};

/// Input for [`create_user`].
#[derive(Clone, Default)]
pub struct CreateUserInput {
    pub email: Option<String>,
    pub phone: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub password_hash: Option<String>,
    pub external_id: Option<String>,
    pub image_url: Option<String>,
    pub email_verified: bool,
    pub phone_verified: bool,
    /// Strategy recorded on a pre-verified email (e.g. `oauth_google`).
    pub email_verified_strategy: Option<String>,
    pub public_metadata: Option<Metadata>,
    pub unsafe_metadata: Option<Metadata>,
    pub private_metadata: Option<Metadata>,
    pub legal_accepted_at: Option<i64>,
    /// Guest account without any identifier (`strategy: "anonymous"`).
    pub is_anonymous: bool,
    /// Skip the `user.created` webhook (bulk imports).
    pub silent: bool,
}

impl std::fmt::Debug for CreateUserInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateUserInput")
            .field("email", &self.email)
            .field("phone", &self.phone)
            .field("username", &self.username)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("password_hash", &self.password_hash)
            .field("external_id", &self.external_id)
            .field("image_url", &self.image_url)
            .field("email_verified", &self.email_verified)
            .field("phone_verified", &self.phone_verified)
            .field("email_verified_strategy", &self.email_verified_strategy)
            .field("public_metadata", &self.public_metadata)
            .field("unsafe_metadata", &self.unsafe_metadata)
            .field("private_metadata", &self.private_metadata)
            .field("legal_accepted_at", &self.legal_accepted_at)
            .field("is_anonymous", &self.is_anonymous)
            .field("silent", &self.silent)
            .finish()
    }
}

/// Creates a user plus its email/phone identification rows and primary
/// pointers. The `user.created` event commits with the user.
pub async fn create_user(state: &AppState, input: &CreateUserInput) -> Result<UserRow> {
    let mut tx = state.pool.begin().await?;
    let user = create_user_on(state, &mut tx, input).await?;
    emit_user_created_on(&mut tx, state, &user, input).await?;
    tx.commit().await?;
    after_user_created(state, &user, input).await?;
    Ok(user)
}

/// [`create_user`] on a caller-supplied connection, without side effects
/// (webhook event, verified-email enrolment). Call [`emit_user_created_on`]
/// before committing the surrounding transaction and [`after_user_created`]
/// once it has committed.
pub async fn create_user_on(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    input: &CreateUserInput,
) -> Result<UserRow> {
    create_user_claims_locked_on(state, conn, input, None).await
}

/// [`create_user_on`] for a caller holding the claim-owner locks (`Some(ids)`,
/// from [`lock_unverified_claim_owners_on`]); `None` locks them here, only
/// correct before any rank 4+ lock. See [`purge_unverified_claims_on`].
pub async fn create_user_claims_locked_on(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    input: &CreateUserInput,
    prelocked_owners: Option<&[String]>,
) -> Result<UserRow> {
    let now_ms = now();
    let email = input.email.as_deref().map(normalize_email);
    let phone = match input.phone.as_deref() {
        Some(phone) => Some(normalize_phone(phone)?),
        None => None,
    };
    if email.is_none() && phone.is_none() && input.username.is_none() && !input.is_anonymous {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "At least one identifier is required",
        ));
    }
    if let Some(email) = &email {
        if !is_valid_email(email) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "email_address is not valid",
            )
            .with_meta(json!({ "param_name": "email_address" })));
        }
        if let Some(existing) = find_email_on(conn, email).await? {
            if existing.verified
                || (!input.email_verified && existing.user_id.is_some() && !input.silent)
            {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_IDENTIFIER_EXISTS,
                    "That email address is already in use",
                )
                .with_meta(json!({ "param_name": "email_address" })));
            }
        }
    }
    if let Some(phone) = &phone {
        let existing = sqlx::query_scalar::<_, Option<String>>(
            "SELECT user_id FROM phone_numbers WHERE phone = $1",
        )
        .bind(phone)
        .fetch_optional(&mut *conn)
        .await?
        .flatten();
        if existing.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "That phone number is already in use",
            )
            .with_meta(json!({ "param_name": "phone_number" })));
        }
    }
    if let Some(username) = &input.username {
        assert_username_available_on(state, conn, username, None).await?;
    }

    let id = new_id(id_prefix::USER);
    let verified = input.email_verified;
    sqlx::query(
        "INSERT INTO users (id, external_id, username, username_lower, first_name, last_name, \
         image_url, has_image, password_hash, password_updated_at, public_metadata, \
         private_metadata, unsafe_metadata, legal_accepted_at, is_anonymous, last_sign_in_at, \
         last_active_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$15,$15)",
    )
    .bind(&id)
    .bind(&input.external_id)
    .bind(&input.username)
    .bind(
        input
            .username
            .as_ref()
            .map(|username| username.to_lowercase()),
    )
    .bind(&input.first_name)
    .bind(&input.last_name)
    .bind(&input.image_url)
    .bind(&input.password_hash)
    .bind(input.password_hash.as_ref().map(|_| now_ms))
    .bind(sqlx::types::Json(
        input.public_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        input.private_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        input.unsafe_metadata.clone().unwrap_or_default(),
    ))
    .bind(input.legal_accepted_at)
    .bind(input.is_anonymous)
    .bind(now_ms)
    .execute(&mut *conn)
    .await?;

    if let Some(email) = &email {
        let email_id = new_id(id_prefix::EMAIL);
        sqlx::query(
            "INSERT INTO email_addresses (id, user_id, email, verified, verified_at, \
             verified_strategy, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
        )
        .bind(&email_id)
        .bind(&id)
        .bind(email)
        .bind(verified)
        .bind(verified.then_some(now_ms))
        .bind(if verified {
            Some(
                input
                    .email_verified_strategy
                    .clone()
                    .unwrap_or_else(|| "email_code".into()),
            )
        } else {
            None
        })
        .bind(now_ms)
        .execute(&mut *conn)
        .await?;
        sqlx::query("UPDATE users SET primary_email_address_id = $1 WHERE id = $2")
            .bind(&email_id)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
        if verified {
            // The new user's row is invisible to everyone else, so only the
            // other owners need locking (ascending id, rank 3).
            let locked = match prelocked_owners {
                Some(owners) => owners.to_vec(),
                None => lock_unverified_claim_owners_on(conn, email, &id, &[]).await?,
            };
            purge_unverified_claims_on(conn, email, &id, &locked).await?;
        }
    }
    if let Some(phone) = &phone {
        let phone_id = new_id(id_prefix::PHONE);
        sqlx::query(
            "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, created_at, \
             updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
        )
        .bind(&phone_id)
        .bind(&id)
        .bind(phone)
        .bind(input.phone_verified)
        .bind(input.phone_verified.then_some(now_ms))
        .bind(now_ms)
        .execute(&mut *conn)
        .await?;
        sqlx::query("UPDATE users SET primary_phone_number_id = $1 WHERE id = $2")
            .bind(&phone_id)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
    }

    let user = require_user_on(conn, &id).await?;
    Ok(user)
}

/// Writes `user.created` on the caller's connection, before the transaction
/// that created the user commits.
pub async fn emit_user_created_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    input: &CreateUserInput,
) -> Result<()> {
    if input.silent {
        return Ok(());
    }
    let json = serialize_user_on(conn, state, user, UserSerializeOptions { backend: true }).await?;
    emit_event_on(
        conn,
        "user.created",
        serde_json::to_value(json).unwrap_or_default(),
    )
    .await
}

/// Post-commit side effects of [`create_user_on`]: verified-email organisation
/// enrolment (its own transactions, emitted with the writes that create them).
pub async fn after_user_created(
    state: &AppState,
    user: &UserRow,
    input: &CreateUserInput,
) -> Result<()> {
    if let (Some(email), true) = (input.email.as_deref(), input.email_verified) {
        on_user_email_verified(state, &user.id, &normalize_email(email)).await?;
    }
    Ok(())
}

pub async fn set_primary_email(
    state: &AppState,
    user_id: &str,
    email_id: &str,
) -> Result<EmailAddressRow> {
    let mut tx = state.pool.begin().await?;
    // Rank 3 before the child row: `delete_email_address_on` locks the user and
    // then the address, so taking the address first here would invert the order.
    crate::locks::lock_user_on(&mut tx, user_id).await?;
    let row = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE id = $1 AND user_id = $2 FOR SHARE",
    )
    .bind(email_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Email address not found")
    })?;
    sqlx::query("UPDATE users SET primary_email_address_id = $1, updated_at = $2 WHERE id = $3")
        .bind(email_id)
        .bind(now())
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn set_primary_phone(
    state: &AppState,
    user_id: &str,
    phone_id: &str,
) -> Result<PhoneNumberRow> {
    let mut tx = state.pool.begin().await?;
    // Rank 3 before the child row (same rule as the email pointer).
    crate::locks::lock_user_on(&mut tx, user_id).await?;
    let row = sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2 FOR SHARE",
    )
    .bind(phone_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found")
    })?;
    sqlx::query("UPDATE users SET primary_phone_number_id = $1, updated_at = $2 WHERE id = $3")
        .bind(phone_id)
        .bind(now())
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row)
}

/// Deletes a user (cascading sessions/identifications), writes `user.deleted`
/// and handles memberships and admin-less organizations in one transaction.
pub async fn delete_user(state: &AppState, user_id: &str) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    delete_user_on(&mut tx, state, user_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`delete_user`] on a caller-owned transaction. Returns the deleted user, or
/// `None` when the user did not exist; avatar, organization logos and the
/// deletions commit together.
pub async fn delete_user_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
) -> Result<Option<UserRow>> {
    // Rank 2 → 3: the user's clients, then the user. Deletion ends sessions and
    // cascades through organizations; both rank below the user, so the user row
    // must be held before either is touched.
    // The members a last-admin promotion would pick are locked with the user,
    // ascending, before any organization (rank 8).
    let mut lock_ids = crate::orgs::promotion_candidates_on(conn, user_id).await?;
    lock_ids.push(user_id.to_string());
    crate::locks::lock_clients_for_user_on(&mut *conn, user_id).await?;
    let locked_users = crate::locks::lock_users_on(&mut *conn, &lock_ids).await?;
    let Some(user) = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    // Serialize while the rows still exist, for the event payload.
    let _ = serialize_user_on(conn, state, &user, UserSerializeOptions { backend: true }).await?;
    // Rank 7 before the rank-8 organization lifecycle: a sign-up completion
    // can hold a session (7) and then accept an invitation (8), so deleting
    // sessions after organizations would invert the order.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    let effects =
        crate::orgs::lifecycle::on_user_deleted_on(conn, state, user_id, &locked_users).await?;
    // Rank 10 (user_roles) before rank 11 (grants) and rank 12 (uploads). The
    // `DELETE FROM users` cascade would otherwise take these locks after the
    // upload rows.
    sqlx::query("DELETE FROM user_roles WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    // A promoted member's authority changed: their tokens are re-issued.
    for promoted in &effects.promoted_user_ids {
        crate::grants::revoke_organization_authority_grants_on(conn, promoted).await?;
    }
    crate::grants::revoke_grants_for_user_on(conn, user_id).await?;
    sqlx::query("DELETE FROM oauth_grants WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    // The pointer's own upload (an avatar imported from the legacy tree may
    // carry no `owner_id`) and every row this user owns leave in the same
    // transaction, before the user row that references them.
    crate::uploads::delete_upload_by_url_on(
        conn,
        crate::uploads::AVATAR_BUCKET,
        crate::uploads::AVATAR_MARKER,
        user.image_url.as_deref(),
    )
    .await?;
    crate::uploads::delete_uploads_for_owner_on(conn, crate::uploads::AVATAR_BUCKET, user_id)
        .await?;
    for (org_id, image_url) in effects.deleted_org_logos {
        crate::uploads::delete_logo_for_org_on(conn, &org_id, image_url.as_deref()).await?;
    }
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    emit_event_on(
        conn,
        "user.deleted",
        json!({ "object": "user", "id": user_id, "deleted": true }),
    )
    .await?;
    Ok(Some(user))
}

/// All users with the given verified email (used by OAuth linking).
pub async fn find_user_by_verified_email(state: &AppState, email: &str) -> Result<Option<UserRow>> {
    let row = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE email = $1 AND verified = true",
    )
    .bind(normalize_email(email))
    .fetch_optional(&state.pool)
    .await?;
    match row.and_then(|row| row.user_id) {
        Some(user_id) => get_user_by_id(state, &user_id).await,
        None => Ok(None),
    }
}

/// A guest account becomes a regular one as soon as it gains a verified way to
/// be found again: a verified email, a verified phone or an external account.
pub async fn has_verified_identifier(state: &AppState, user_id: &str) -> Result<bool> {
    if list_emails(state, user_id)
        .await?
        .iter()
        .any(|row| row.verified)
    {
        return Ok(true);
    }
    if list_phones(state, user_id)
        .await?
        .iter()
        .any(|row| row.verified)
    {
        return Ok(true);
    }
    let externals: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM external_accounts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    Ok(externals > 0)
}

pub async fn upgrade_anonymous_user(state: &AppState, user_id: &str) -> Result<Option<UserRow>> {
    let mut conn = state.pool.acquire().await?;
    upgrade_anonymous_user_on(&mut conn, user_id).await
}

/// [`upgrade_anonymous_user`] on a caller-owned connection. The "is anonymous
/// and now has a verified identifier" check and the flag flip are one
/// conditional statement, so two concurrent upgrades cannot disagree.
pub async fn upgrade_anonymous_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Option<UserRow>> {
    let updated = sqlx::query_as::<_, UserRow>(
        "UPDATE users SET is_anonymous = false, updated_at = $1 \
         WHERE id = $2 AND is_anonymous = true AND ( \
             EXISTS(SELECT 1 FROM email_addresses WHERE user_id = $2 AND verified = true) \
             OR EXISTS(SELECT 1 FROM phone_numbers WHERE user_id = $2 AND verified = true) \
             OR EXISTS(SELECT 1 FROM external_accounts WHERE user_id = $2) \
         ) RETURNING *",
    )
    .bind(now())
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    match updated {
        Some(user) => Ok(Some(user)),
        None => get_user_by_id_on(conn, user_id).await,
    }
}
