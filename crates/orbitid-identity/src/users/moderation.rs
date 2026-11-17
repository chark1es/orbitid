//! Operator moderation building blocks: ban, unban, lock, unlock.
//!
//! Each action is a single transaction: the `users` write, the credential
//! revocation it implies (sessions, OIDC grants, API keys, trusted browsers)
//! and the `user.updated` outbox event either all commit or none do. The
//! Backend API calls [`moderate_user_on`] from its own transaction; the pool
//! wrapper is for callers that do not need to combine it with another write.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use crate::api_keys::revoke_api_keys_for_subject_on;
use crate::grants::revoke_grants_for_user_on;
use crate::sessions::end_sessions_for_user_on;
use crate::trusted_devices::revoke_all_trusted_devices_on;

use super::guards::reset_failed_attempts_on;
use crate::serializers::{serialize_user_on, UserSerializeOptions};

/// The moderation actions the Backend API exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationAction {
    Ban,
    Unban,
    Lock,
    Unlock,
}

impl ModerationAction {
    /// Audit action recorded by the HTTP layer.
    pub fn audit_action(self) -> &'static str {
        match self {
            Self::Ban => "user.banned",
            Self::Unban => "user.unbanned",
            Self::Lock => "user.locked",
            Self::Unlock => "user.unlocked",
        }
    }
}

/// Applies one moderation action in its own transaction.
pub async fn moderate_user(
    state: &AppState,
    user_id: &str,
    action: ModerationAction,
) -> Result<UserRow> {
    let mut tx = state.pool.begin().await?;
    let user = moderate_user_on(&mut tx, state, user_id, action).await?;
    tx.commit().await?;
    Ok(user)
}

/// [`moderate_user`] on a caller-owned transaction.
///
/// * `Ban` revokes every session (and its OIDC grants), every user grant, every
///   API key and every trusted browser, so a ban takes effect on all replicas.
/// * `Lock` revokes trusted browsers (a locked account must not keep a browser
///   that can skip the second factor).
/// * `Unban`/`Unlock` only clear the flag; they intentionally do not resurrect
///   credentials.
pub async fn moderate_user_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    action: ModerationAction,
) -> Result<UserRow> {
    // Rank 2 → 3: every client that currently has a session for this user
    // (ascending id), then the user row. Banning is a write to `sessions`, which
    // ranks below `users`; locking the user first and then the sessions
    // deadlocked against `touch`, which used to take the session and then the
    // user. A client created concurrently by a sign-in blocks on the user lock
    // taken here, so no session can slip past the ban.
    crate::locks::lock_user_clients_then_user_on(&mut *conn, user_id).await?;
    let Some(existing) =
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE")
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?
    else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "User not found",
        ));
    };
    let now_ms = now();
    match action {
        ModerationAction::Ban => {
            sqlx::query("UPDATE users SET banned = true, updated_at = $1 WHERE id = $2")
                .bind(now_ms)
                .bind(&existing.id)
                .execute(&mut *conn)
                .await?;
            end_sessions_for_user_on(conn, state, &existing.id, "revoked", None).await?;
            revoke_grants_for_user_on(conn, &existing.id).await?;
            revoke_all_trusted_devices_on(conn, &existing.id).await?;
            revoke_api_keys_for_subject_on(conn, &existing.id, "user banned").await?;
        }
        ModerationAction::Unban => {
            sqlx::query("UPDATE users SET banned = false, updated_at = $1 WHERE id = $2")
                .bind(now_ms)
                .bind(&existing.id)
                .execute(&mut *conn)
                .await?;
        }
        ModerationAction::Lock => {
            sqlx::query(
                "UPDATE users SET locked = true, lockout_expires_at = NULL, updated_at = $1 \
                 WHERE id = $2",
            )
            .bind(now_ms)
            .bind(&existing.id)
            .execute(&mut *conn)
            .await?;
            revoke_all_trusted_devices_on(conn, &existing.id).await?;
        }
        ModerationAction::Unlock => {
            reset_failed_attempts_on(conn, &existing.id).await?;
        }
    }
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&existing.id)
        .fetch_one(&mut *conn)
        .await?;
    let payload = serde_json::to_value(
        serialize_user_on(conn, state, &user, UserSerializeOptions { backend: true }).await?,
    )
    .unwrap_or_default();
    emit_event_on(conn, "user.updated", payload).await?;
    Ok(user)
}
