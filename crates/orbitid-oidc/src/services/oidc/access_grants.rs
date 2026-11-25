//! Operator-managed access to organization-owned OAuth applications
//! (`oauth_application_access_grants`, migration 0019).
//!
//! A row lets one user use one organization-owned application without being a
//! member of the owning organization. The rule itself is
//! `orbitid_identity::app_access`; this module stores the rows and keeps the
//! issued grants consistent when a row is removed.

use serde::Serialize;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

/// One access grant row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AccessGrantRow {
    pub application_id: String,
    pub user_id: String,
    pub created_at: i64,
}

/// Wire shape of an access grant.
#[derive(Debug, Clone, Serialize)]
pub struct AccessGrantJson {
    pub object: &'static str,
    pub application_id: String,
    pub user_id: String,
    pub created_at: i64,
}

pub fn serialize_access_grant(row: &AccessGrantRow) -> AccessGrantJson {
    AccessGrantJson {
        object: "oauth_application_access_grant",
        application_id: row.application_id.clone(),
        user_id: row.user_id.clone(),
        created_at: row.created_at,
    }
}

/// The access grants of one application, newest first.
pub async fn list_application_access_grants(
    state: &AppState,
    application_id: &str,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AccessGrantRow>, i64)> {
    let rows = sqlx::query_as::<_, AccessGrantRow>(
        "SELECT application_id, user_id, created_at FROM oauth_application_access_grants \
         WHERE application_id = $1 ORDER BY created_at DESC, user_id LIMIT $2 OFFSET $3",
    )
    .bind(application_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM oauth_application_access_grants WHERE application_id = $1",
    )
    .bind(application_id)
    .fetch_one(&state.pool)
    .await?;
    Ok((rows, total))
}

/// The access grants one user holds, newest first.
pub async fn list_user_access_grants(
    state: &AppState,
    user_id: &str,
    limit: i64,
    offset: i64,
) -> Result<(Vec<AccessGrantRow>, i64)> {
    let rows = sqlx::query_as::<_, AccessGrantRow>(
        "SELECT application_id, user_id, created_at FROM oauth_application_access_grants \
         WHERE user_id = $1 ORDER BY created_at DESC, application_id LIMIT $2 OFFSET $3",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM oauth_application_access_grants WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok((rows, total))
}

/// Whether a user row exists.
pub async fn user_exists(state: &AppState, user_id: &str) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?,
    )
}

/// `FOR SHARE` on the application row (rank 10a); returns its owning
/// organization. Not found when it was deleted meanwhile.
async fn share_application_on(
    conn: &mut sqlx::PgConnection,
    application_id: &str,
) -> Result<Option<String>> {
    let found: Option<Option<String>> = sqlx::query_scalar(
        "SELECT organization_id FROM oauth_applications WHERE id = $1 FOR SHARE",
    )
    .bind(application_id)
    .fetch_optional(&mut *conn)
    .await?;
    found.ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "OAuth application not found",
        )
    })
}

/// The refusal for a grant on an application without an owner: every user may
/// already use it, and a grant stored now would silently take effect the day
/// the application gets an owner, without anyone re-approving it.
pub fn instance_wide_grant_refused() -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PARAM_VALUE_INVALID,
        "This application is instance-wide, so every user can already use it. \
         Give it an owning organization before granting access.",
    )
    .with_meta(serde_json::json!({ "param_name": "organization_id" }))
}

/// Grants `user_id` access to `application_id`. Idempotent: returns the row and
/// whether it was created by this call. Refused (422) while the application has
/// no owner.
///
/// Lock order: user key-share (rank 3, not found when missing), then the
/// application `FOR SHARE`; the insert's foreign keys reference both. Clearing
/// the owner updates the application row, so it cannot interleave between the
/// owner check and the insert.
pub async fn grant_application_access(
    state: &AppState,
    application_id: &str,
    user_id: &str,
) -> Result<(AccessGrantRow, bool)> {
    let mut tx = state.pool.begin().await?;
    let outcome = async {
        orbitid_identity::locks::key_share_user_on(&mut tx, user_id).await?;
        if share_application_on(&mut tx, application_id)
            .await?
            .is_none()
        {
            return Err(instance_wide_grant_refused());
        }
        let inserted = sqlx::query_as::<_, AccessGrantRow>(
            "INSERT INTO oauth_application_access_grants (application_id, user_id, created_at) \
             VALUES ($1, $2, $3) ON CONFLICT (application_id, user_id) DO NOTHING \
             RETURNING application_id, user_id, created_at",
        )
        .bind(application_id)
        .bind(user_id)
        .bind(orbitid_core::http::now())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = inserted {
            return Ok((row, true));
        }
        let existing = sqlx::query_as::<_, AccessGrantRow>(
            "SELECT application_id, user_id, created_at FROM oauth_application_access_grants \
             WHERE application_id = $1 AND user_id = $2",
        )
        .bind(application_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
        Ok((existing, false))
    }
    .await;
    orbitid_core::db::finish_transaction(tx, outcome).await
}

/// Removes `user_id`'s access grant for `application_id` and, in the same
/// transaction, revokes the OIDC grants (codes, access and refresh tokens) the
/// user holds for it unless they are still entitled (a member of the owning
/// organization, or the application is instance-wide). `None` when there was
/// no such grant.
///
/// Lock order: the user `FOR UPDATE` (rank 3, which every issuer's key-share
/// conflicts with, so the revocation sees every committed token), then the
/// application `FOR SHARE`, then the grant row and the token rows (rank 11).
pub async fn revoke_application_access(
    state: &AppState,
    application_id: &str,
    user_id: &str,
) -> Result<Option<(AccessGrantRow, u64)>> {
    let mut tx = state.pool.begin().await?;
    let outcome = async {
        orbitid_identity::locks::lock_user_on(&mut tx, user_id).await?;
        share_application_on(&mut tx, application_id).await?;
        let deleted = sqlx::query_as::<_, AccessGrantRow>(
            "DELETE FROM oauth_application_access_grants \
             WHERE application_id = $1 AND user_id = $2 \
             RETURNING application_id, user_id, created_at",
        )
        .bind(application_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(row) = deleted else {
            return Ok(None);
        };
        let revoked = orbitid_identity::app_access::revoke_unentitled_application_grants_on(
            &mut tx,
            &[user_id.to_string()],
            Some(application_id),
        )
        .await?;
        Ok(Some((row, revoked)))
    }
    .await;
    orbitid_core::db::finish_transaction(tx, outcome).await
}
