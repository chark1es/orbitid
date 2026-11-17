//! Transactional session variants used by the Frontend API crates.
//!
//! These are additive `_on` counterparts of [`crate::sessions`] helpers whose
//! original pool-based versions already open their own transaction. An HTTP
//! handler that must commit a session change together with another write (for
//! example "sign out of every session" also clearing the client pointer) takes
//! one transaction and calls these instead.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{ClientRow, SessionRow};
use orbitid_core::state::AppState;

use crate::grants::revoke_grants_for_session_on;
use crate::sessions::emit_session_event_on;
use crate::sessions::TouchSessionOptions;
use crate::users::{touch_user, TouchUserPatch};

pub use crate::sessions::create::complete_mfa_enrollment_on;

fn session_event(status: &str) -> &'static str {
    match status {
        "revoked" => "session.revoked",
        "removed" => "session.removed",
        _ => "session.ended",
    }
}

/// Ends one session on a caller-owned connection: status flip, grant
/// revocation, client pointer repair and the event row commit together.
/// Returns `None` when the row was no longer active/pending.
pub async fn end_session_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SessionRow,
    status: &str,
) -> Result<Option<SessionRow>> {
    let now_ms = now();
    // Rank order: the client row first (rank 2), then the session (rank 7).
    // Updating the session first and the client's pointer afterwards inverted
    // the order against `create_session` and could deadlock with a concurrent
    // token refresh.
    crate::locks::lock_client_on(conn, &row.client_id).await?;
    let ended = sqlx::query_as::<_, SessionRow>(
        "UPDATE sessions SET status = $1, updated_at = $2 \
         WHERE id = $3 AND status IN ('active', 'pending') RETURNING *",
    )
    .bind(status)
    .bind(now_ms)
    .bind(&row.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(updated) = ended else {
        return Ok(None);
    };
    revoke_grants_for_session_on(conn, &row.id).await?;
    let client = sqlx::query_as::<_, ClientRow>("SELECT * FROM clients WHERE id = $1")
        .bind(&row.client_id)
        .fetch_optional(&mut *conn)
        .await?;
    if client
        .as_ref()
        .and_then(|client| client.last_active_session_id.as_deref())
        == Some(row.id.as_str())
    {
        let next = sqlx::query_as::<_, SessionRow>(
            "SELECT * FROM sessions WHERE client_id = $1 AND status = 'active' AND id <> $2 \
             ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&row.client_id)
        .bind(&row.id)
        .fetch_optional(&mut *conn)
        .await?;
        sqlx::query(
            "UPDATE clients SET last_active_session_id = $1, updated_at = $2 WHERE id = $3",
        )
        .bind(next.map(|row| row.id))
        .bind(now_ms)
        .bind(&row.client_id)
        .execute(&mut *conn)
        .await?;
    }
    emit_session_event_on(conn, state, session_event(status), &updated).await?;
    Ok(Some(updated))
}

/// Updates activity and the active organization on a caller-owned connection.
///
/// The user-activity column is deliberately **not** written here: `touch` runs
/// on every token refresh for every browser, and taking the user row would put
/// a rank-3 lock after a rank-7 session write. The caller runs
/// [`touch_user_activity_after_commit`] once the transaction has committed, so
/// the write holds no session lock and cannot participate in a cycle.
pub async fn touch_session_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    row: &SessionRow,
    options: TouchSessionOptions,
) -> Result<SessionRow> {
    let now_ms = now();
    let mut organization_id = row.last_active_organization_id.clone();
    if let Some(requested) = &options.organization_id {
        match requested {
            None => organization_id = None,
            Some(id) => {
                let membership: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM organization_memberships \
                     WHERE organization_id = $1 AND user_id = $2",
                )
                .bind(id)
                .bind(&row.user_id)
                .fetch_optional(&mut *conn)
                .await?;
                if membership.is_none() {
                    return Err(OrbitError::forbidden(
                        error_codes::NOT_A_MEMBER_IN_ORGANIZATION,
                        "You are not a member of this organization",
                    ));
                }
                organization_id = Some(id.clone());
            }
        }
    }
    sqlx::query(
        "UPDATE sessions SET last_active_at = $1, updated_at = $1, \
         ip = COALESCE($2, ip), user_agent = COALESCE($3, user_agent), \
         last_active_organization_id = $4 WHERE id = $5",
    )
    .bind(now_ms)
    .bind(&options.ip)
    .bind(&options.user_agent)
    .bind(&organization_id)
    .bind(&row.id)
    .execute(&mut *conn)
    .await?;
    let mut updated = row.clone();
    updated.last_active_at = now_ms;
    updated.updated_at = now_ms;
    updated.ip = options.ip.or(updated.ip);
    updated.user_agent = options.user_agent.or(updated.user_agent);
    updated.last_active_organization_id = organization_id;
    Ok(updated)
}

/// Best-effort, throttled user-activity write that must run **after** the
/// session transaction committed.
///
/// It is a single-statement autocommit `UPDATE users`, so it holds at most one
/// row lock and waits for nothing else: a single-statement transaction cannot
/// be part of a deadlock cycle. The conditional predicate keeps it to at most
/// one write per [`crate::sessions::USER_ACTIVITY_SLIDE_INTERVAL_MS`].
pub async fn touch_user_activity_after_commit(
    state: &AppState,
    user_id: &str,
    at: i64,
) -> Result<()> {
    let now_ms = at;
    sqlx::query(
        "UPDATE users SET last_active_at = $1, updated_at = $1 \
         WHERE id = $2 AND last_active_at < $3",
    )
    .bind(now_ms)
    .bind(user_id)
    .bind(now_ms - crate::sessions::USER_ACTIVITY_SLIDE_INTERVAL_MS)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Alias kept for the pool-level API: `touch_user` already runs outside every
/// transaction, so it is the same safe single-statement write.
pub async fn touch_user_after_commit(
    state: &AppState,
    user_id: &str,
    patch: TouchUserPatch,
) -> Result<()> {
    touch_user(state, user_id, patch).await
}

/// Marks a reverification as done on the session, on a caller-owned connection.
pub async fn mark_session_reverified_on(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
    level: &str,
) -> Result<SessionRow> {
    let now_ms = now();
    let first = matches!(level, "first_factor" | "multi_factor").then_some(now_ms);
    let second = matches!(level, "second_factor" | "multi_factor").then_some(now_ms);
    sqlx::query(
        "UPDATE sessions SET updated_at = $1, \
         first_factor_verified_at = COALESCE($2, first_factor_verified_at), \
         second_factor_verified_at = COALESCE($3, second_factor_verified_at) WHERE id = $4",
    )
    .bind(now_ms)
    .bind(first)
    .bind(second)
    .bind(session_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found"))
}
