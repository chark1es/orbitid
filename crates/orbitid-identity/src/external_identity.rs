//! External identity primitives shared by social OAuth and enterprise
//! SAML/OIDC, ported from `services/external-identity.ts`.
//!
//! `handleExternalIdentity` itself is the sign-in/sign-up state machine and
//! lives in `orbitid-fapi-auth`. This module owns the reusable, transport-free
//! pieces: the profile shape, the email-link policy, blocklist screening at
//! sign-in, and link/refresh of the `external_accounts` row.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::ExternalAccountRow;
use orbitid_core::state::AppState;

use crate::enterprise_access::assert_additional_identifications_allowed_on;
use crate::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};

/// A provider profile, whatever the protocol.
#[derive(Clone, Default)]
pub struct ExternalProfile {
    /// `google`, `github`, `saml_<connId>`, `oidc_<connId>`, `enterprise_saml_…`.
    pub provider: String,
    pub provider_user_id: String,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub image_url: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub scopes: Option<String>,
}

impl std::fmt::Debug for ExternalProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalProfile")
            .field("provider", &self.provider)
            .field("provider_user_id", &self.provider_user_id)
            .field("email", &self.email)
            .field("email_verified", &self.email_verified)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("username", &self.username)
            .field("image_url", &self.image_url)
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .finish()
    }
}

/// True only when the provider explicitly verified the address. An unverified
/// (or `email_verified: false`) claim must never be linked to an existing local
/// account, whatever `trust_email_verified` says.
pub fn profile_email_may_link(profile: &ExternalProfile) -> bool {
    profile.email_verified == Some(true) && profile.email.is_some()
}

/// Sign-in must honour the instance blocklist (OAuth flows have no identifier
/// at create time).
pub async fn assert_sign_in_identity_allowed(state: &AppState, email: Option<&str>) -> Result<()> {
    let Some(email) = email else {
        return Ok(());
    };
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: vec![email.to_string()],
            phones: Vec::new(),
            invitation_ticket: None,
        },
        true,
    )
    .await?;
    Ok(())
}

/// Creates or refreshes the external_account row and links it to `user_id`.
pub async fn link_external_account(
    state: &AppState,
    user_id: &str,
    profile: &ExternalProfile,
) -> Result<ExternalAccountRow> {
    let mut tx = state.pool.begin().await?;
    let row = link_external_account_on(&mut tx, state, user_id, profile).await?;
    tx.commit().await?;
    Ok(row)
}

/// [`link_external_account`] on a caller-owned transaction.
///
/// Find-or-create races on `(provider, provider_user_id)` are resolved by the
/// unique index: an insert that loses the race returns no row, and the winner's
/// row is then locked (`FOR UPDATE`) and refreshed. Both sides therefore finish
/// with the same single row instead of one failing with a duplicate-key error.
pub async fn link_external_account_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    profile: &ExternalProfile,
) -> Result<ExternalAccountRow> {
    let now_ms = now();
    // Global lock order: user before rows it owns. The FK key-share a later
    // insert takes on this user would otherwise invert against user deletion.
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let access_token_enc = encrypt_optional(state, profile.access_token.as_deref())?;
    let refresh_token_enc = encrypt_optional(state, profile.refresh_token.as_deref())?;
    let existing = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE provider = $1 AND provider_user_id = $2 \
         FOR UPDATE",
    )
    .bind(&profile.provider)
    .bind(&profile.provider_user_id)
    .fetch_optional(&mut *conn)
    .await?;
    // Refreshing a link that already belongs to this user is fine; creating one
    // is an additional identification, so the enterprise policy applies.
    if existing
        .as_ref()
        .map(|row| row.user_id.as_deref() != Some(user_id))
        .unwrap_or(true)
    {
        assert_additional_identifications_allowed_on(conn, state, user_id).await?;
    }
    if let Some(existing) = existing {
        return refresh_external_account_on(
            conn,
            user_id,
            profile,
            &existing,
            access_token_enc,
            refresh_token_enc,
            now_ms,
        )
        .await;
    }
    let id = new_id(id_prefix::EXTERNAL);
    let inserted = sqlx::query_as::<_, ExternalAccountRow>(
        "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, email_address, \
         first_name, last_name, username, image_url, approved_scopes, access_token_enc, \
         refresh_token_enc, token_expires_at, public_metadata, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$14,$14) \
         ON CONFLICT (provider, provider_user_id) DO NOTHING RETURNING *",
    )
    .bind(&id)
    .bind(user_id)
    .bind(&profile.provider)
    .bind(&profile.provider_user_id)
    .bind(profile.email.clone().unwrap_or_default())
    .bind(profile.first_name.clone().unwrap_or_default())
    .bind(profile.last_name.clone().unwrap_or_default())
    .bind(&profile.username)
    .bind(&profile.image_url)
    .bind(profile.scopes.clone().unwrap_or_default())
    .bind(&access_token_enc)
    .bind(&refresh_token_enc)
    .bind(profile.expires_at)
    .bind(now_ms)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(row) = inserted {
        return Ok(row);
    }
    // Another transaction inserted the row between our SELECT and INSERT. It
    // has committed by now (the conflict waited for it), so lock and merge it.
    let existing = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE provider = $1 AND provider_user_id = $2 \
         FOR UPDATE",
    )
    .bind(&profile.provider)
    .bind(&profile.provider_user_id)
    .fetch_one(&mut *conn)
    .await?;
    refresh_external_account_on(
        conn,
        user_id,
        profile,
        &existing,
        access_token_enc,
        refresh_token_enc,
        now_ms,
    )
    .await
}

fn encrypt_optional(state: &AppState, token: Option<&str>) -> Result<Option<String>> {
    token
        .map(|token| {
            orbitid_core::crypto::encrypt(&state.env.encryption_key, token)
                .map_err(|error| OrbitError::internal(error.to_string()))
        })
        .transpose()
}

async fn refresh_external_account_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    profile: &ExternalProfile,
    existing: &ExternalAccountRow,
    access_token_enc: Option<String>,
    refresh_token_enc: Option<String>,
    now_ms: i64,
) -> Result<ExternalAccountRow> {
    if let Some(owner) = &existing.user_id {
        if owner != user_id {
            return Err(OrbitError::conflict(
                error_codes::EXTERNAL_ACCOUNT_EXISTS,
                "This external account is already linked to another user",
            ));
        }
    }
    Ok(sqlx::query_as::<_, ExternalAccountRow>(
        "UPDATE external_accounts SET user_id = $1, email_address = $2, first_name = $3, \
         last_name = $4, username = $5, image_url = $6, approved_scopes = $7, \
         access_token_enc = $8, refresh_token_enc = $9, token_expires_at = $10, \
         updated_at = $11 WHERE id = $12 RETURNING *",
    )
    .bind(user_id)
    .bind(
        profile
            .email
            .clone()
            .unwrap_or_else(|| existing.email_address.clone()),
    )
    .bind(
        profile
            .first_name
            .clone()
            .unwrap_or_else(|| existing.first_name.clone()),
    )
    .bind(
        profile
            .last_name
            .clone()
            .unwrap_or_else(|| existing.last_name.clone()),
    )
    .bind(
        profile
            .username
            .clone()
            .or_else(|| existing.username.clone()),
    )
    .bind(
        profile
            .image_url
            .clone()
            .or_else(|| existing.image_url.clone()),
    )
    .bind(
        profile
            .scopes
            .clone()
            .unwrap_or_else(|| existing.approved_scopes.clone()),
    )
    .bind(
        access_token_enc
            .clone()
            .or_else(|| existing.access_token_enc.clone()),
    )
    .bind(
        refresh_token_enc
            .clone()
            .or_else(|| existing.refresh_token_enc.clone()),
    )
    .bind(profile.expires_at.or(existing.token_expires_at))
    .bind(now_ms)
    .bind(&existing.id)
    .fetch_one(&mut *conn)
    .await?)
}

/// Removes one external account from `user_id`. The user row is locked before
/// the "not last identification" check, so it cannot race the deletion of an
/// email, phone or another external account.
pub async fn delete_external_account_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    id: &str,
) -> Result<ExternalAccountRow> {
    crate::users::guards::lock_user_identifications(conn, user_id).await?;
    let row = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::EXTERNAL_ACCOUNT_NOT_FOUND,
            "External account not found",
        )
    })?;
    if crate::users::guards::count_identifications_on(conn, user_id).await? <= 1 {
        return Err(OrbitError::unprocessable(
            error_codes::LAST_IDENTIFICATION_CANNOT_BE_REMOVED,
            "You cannot remove your last identification",
        ));
    }
    sqlx::query("DELETE FROM external_accounts WHERE id = $1")
        .bind(&row.id)
        .execute(&mut *conn)
        .await?;
    Ok(row)
}

/// [`delete_external_account_on`] in its own transaction.
pub async fn delete_external_account(
    state: &AppState,
    user_id: &str,
    id: &str,
) -> Result<ExternalAccountRow> {
    let mut tx = state.pool.begin().await?;
    let row = delete_external_account_on(&mut tx, user_id, id).await?;
    tx.commit().await?;
    Ok(row)
}

/// Re-export so auth flows can look up a link once without a second import.
pub async fn find_external_account(
    state: &AppState,
    provider: &str,
    provider_user_id: &str,
) -> Result<Option<ExternalAccountRow>> {
    let mut conn = state.pool.acquire().await?;
    find_external_account_on(&mut conn, provider, provider_user_id).await
}

/// [`find_external_account`] on a caller-owned connection.
pub async fn find_external_account_on(
    conn: &mut sqlx::PgConnection,
    provider: &str,
    provider_user_id: &str,
) -> Result<Option<ExternalAccountRow>> {
    Ok(sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE provider = $1 AND provider_user_id = $2",
    )
    .bind(provider)
    .bind(provider_user_id)
    .fetch_optional(&mut *conn)
    .await?)
}
