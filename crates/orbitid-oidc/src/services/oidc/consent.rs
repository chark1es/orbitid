//! OAuth consent storage. Ported from `services/oidc/tokens.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::state::AppState;

use super::shared::parse_scopes;

pub async fn stored_consent(
    state: &AppState,
    application_id: &str,
    user_id: &str,
) -> Result<Option<Vec<String>>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT scopes FROM oauth_consents WHERE application_id = $1 AND user_id = $2",
    )
    .bind(application_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|(scopes,)| parse_scopes(&scopes)))
}

pub async fn has_consent(
    state: &AppState,
    application_id: &str,
    user_id: &str,
    scopes: &[String],
) -> Result<bool> {
    let granted = stored_consent(state, application_id, user_id).await?;
    Ok(match granted {
        Some(granted) => scopes.iter().all(|scope| granted.contains(scope)),
        None => false,
    })
}

pub async fn record_consent(
    state: &AppState,
    application_id: &str,
    user_id: &str,
    scopes: &[String],
) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    record_consent_on(&mut conn, application_id, user_id, scopes).await
}

/// [`record_consent`] on a caller-owned connection. The row is read under
/// `FOR UPDATE` so two concurrent approvals cannot drop each other's scopes.
///
/// `oauth_consents.user_id` references `users` (rank 3), so the user key-share
/// is taken **first** (lock-order rule: an INSERT/UPDATE of a foreign-key column
/// counts as a lock at the parent's rank). User deletion holds the user row and
/// then cascades into the consent rows; taking the consent row before the user
/// would close a cycle with it. A user that no longer exists is the usual
/// not-found error.
pub async fn record_consent_on(
    conn: &mut sqlx::PgConnection,
    application_id: &str,
    user_id: &str,
    scopes: &[String],
) -> Result<()> {
    // Re-checked under the key-share: the caller was authenticated earlier and a
    // ban may have committed since (the code issued next must not outlive it).
    match orbitid_identity::locks::key_share_active_user_on(conn, user_id).await? {
        None => {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "User not found",
            ))
        }
        Some(state) if state.banned => {
            return Err(OrbitError::forbidden(
                error_codes::USER_BANNED,
                "This user has been banned",
            ))
        }
        Some(_) => {}
    }
    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT scopes FROM oauth_consents WHERE application_id = $1 AND user_id = $2 \
         FOR UPDATE",
    )
    .bind(application_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let mut merged = existing
        .map(|(scopes,)| parse_scopes(&scopes))
        .unwrap_or_default();
    for scope in scopes {
        if !merged.contains(scope) {
            merged.push(scope.clone());
        }
    }
    sqlx::query(
        "INSERT INTO oauth_consents (application_id, user_id, scopes, created_at) \
         VALUES ($1,$2,$3,$4) ON CONFLICT (application_id, user_id) DO UPDATE SET scopes = $3",
    )
    .bind(application_id)
    .bind(user_id)
    .bind(merged.join(" "))
    .bind(now())
    .execute(&mut *conn)
    .await?;
    Ok(())
}
