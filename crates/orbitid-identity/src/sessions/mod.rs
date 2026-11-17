//! Session lifecycle, ported from `services/sessions.ts`.
//!
//! Creation and second-factor enrollment live in [`create`]; expiry,
//! evaluation, ending and activity bookkeeping are here. Public names are
//! re-exported unchanged.

pub mod create;

pub use create::{
    complete_mfa_enrollment, create_session, create_session_conn, create_session_in_tx,
    emit_created_session_events_on, send_new_sign_in_email, CreateSessionInput, CreatedSession,
};

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::keys::SESSION_NEVER_EXPIRES_AT;
use orbitid_core::models::SessionRow;
use orbitid_core::resources::AuthMethod;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use crate::grants::revoke_grants_for_session_on;
use crate::serializers::SessionSerializeOptions;

/// Absolute `expire_at` for a session created at `now`. `lifetime_seconds: 0`
/// and an absent `max_lifetime_seconds` mean no maximum: the row stores the
/// far-future sentinel.
pub fn session_expire_at(
    now_ms: i64,
    lifetime_seconds: i64,
    max_lifetime_seconds: Option<i64>,
) -> i64 {
    let mut caps: Vec<i64> = Vec::new();
    if lifetime_seconds > 0 {
        caps.push(lifetime_seconds);
    }
    if let Some(max) = max_lifetime_seconds.filter(|value| *value > 0) {
        caps.push(max);
    }
    match caps.into_iter().min() {
        Some(seconds) => now_ms + seconds * 1000,
        None => SESSION_NEVER_EXPIRES_AT,
    }
}

/// The stored `expire_at` read through the policy in force now. Unlimited is
/// represented as `i64::MAX` (the TS returns `Infinity`).
pub fn session_expires_at(state: &AppState, row: &SessionRow) -> i64 {
    let lifetime = state.settings.get().session.lifetime_seconds;
    let policy_deadline = if lifetime > 0 {
        row.created_at + lifetime * 1000
    } else {
        i64::MAX
    };
    if row.expire_at == SESSION_NEVER_EXPIRES_AT {
        policy_deadline
    } else {
        row.expire_at.min(policy_deadline)
    }
}

/// [`emit_session_event_on`] on a caller-owned connection: the event row commits
/// in the same transaction as the session change it describes.
pub(crate) async fn emit_session_event_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    event: &str,
    row: &SessionRow,
) -> Result<()> {
    let json = crate::serializers::serialize_session_on(
        conn,
        state,
        row,
        SessionSerializeOptions {
            with_user: true,
            last_token: None,
        },
    )
    .await?;
    emit_event_on(conn, event, serde_json::to_value(json).unwrap_or_default()).await
}

/// Ends every open session for a user and revokes the OIDC grants minted from
/// each. The status changes, grant revocations and `session.ended`/`revoked`
/// event rows commit in one transaction: a failure in between can never leave a
/// revoked session with live grants or a missing (never retried) event.
pub async fn end_sessions_for_user(
    state: &AppState,
    user_id: &str,
    status: &str,
    except_session_id: Option<&str>,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    end_sessions_for_user_on(&mut tx, state, user_id, status, except_session_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`end_sessions_for_user`] on a caller-owned transaction (password change,
/// ban, account deletion), so the sign-out commits with the change that caused
/// it.
pub async fn end_sessions_for_user_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    status: &str,
    except_session_id: Option<&str>,
) -> Result<()> {
    let now_ms = now();
    // Rank 3 → 7: the user row, then every session in ascending id. Locking the
    // batch in id order before updating it means two sign-outs of the same user
    // (or a sign-out racing a session creation, which holds the user lock) can
    // never acquire session row locks in opposite orders.
    crate::locks::lock_user_on(conn, user_id).await?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE user_id = $1 AND status IN ('active', 'pending') \
         AND ($2::text IS NULL OR id <> $2) ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
    .bind(except_session_id)
    .fetch_all(&mut *conn)
    .await?;
    if ids.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query_as::<_, SessionRow>(
        "UPDATE sessions SET status = $1, updated_at = $2 WHERE id = ANY($3) RETURNING *",
    )
    .bind(status)
    .bind(now_ms)
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    // One bulk revoke for the whole batch, then one event per session; both use
    // the transaction's connection only (`_on` variants).
    crate::grants::revoke_grants_for_sessions_on(conn, &ids).await?;
    let event = match status {
        "revoked" => "session.revoked",
        "removed" => "session.removed",
        _ => "session.ended",
    };
    for row in &rows {
        emit_session_event_on(conn, state, event, row).await?;
    }
    Ok(())
}

/// Revokes every other open session of a user on a caller-owned transaction
/// (the `sign_out_of_other_sessions` / "end all other sessions" action). The
/// kept session is never touched; each revoked session writes its own
/// `session.revoked` event and grant revocations.
pub async fn end_other_sessions_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    keep_session_id: &str,
) -> Result<()> {
    end_sessions_for_user_on(conn, state, user_id, "revoked", Some(keep_session_id)).await
}

pub async fn get_session(state: &AppState, id: &str) -> Result<Option<SessionRow>> {
    Ok(
        sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub fn is_session_expired(state: &AppState, row: &SessionRow) -> bool {
    if row.status != "active" && row.status != "pending" {
        return false;
    }
    let now_ms = now();
    if session_expires_at(state, row) <= now_ms {
        return true;
    }
    let inactivity_ms = state.settings.get().session.inactivity_timeout_seconds * 1000;
    inactivity_ms > 0 && now_ms - row.last_active_at > inactivity_ms
}

/// Applies expiry/inactivity to the DB row and returns the effective status.
pub async fn evaluate_session_status(state: &AppState, row: &SessionRow) -> Result<String> {
    if is_session_expired(state, row) {
        if row.status != "expired" {
            // The row read may be stale; never let an expiry heuristic overwrite
            // a revocation, ban or sign-out. Revocation commits with the status
            // change so a failure cannot leave an expired session with live
            // grants. The client lock (rank 2) is taken before the session
            // update (rank 7) so this lazy expiry cannot invert the order
            // against a concurrent session creation.
            let mut tx = state.pool.begin().await?;
            crate::locks::lock_client_on(&mut tx, &row.client_id).await?;
            let expired = sqlx::query_scalar::<_, String>(
                "UPDATE sessions SET status = 'expired', updated_at = $1 \
                 WHERE id = $2 AND status IN ('active', 'pending') RETURNING id",
            )
            .bind(now())
            .bind(&row.id)
            .fetch_optional(&mut *tx)
            .await?;
            if expired.is_some() {
                revoke_grants_for_session_on(&mut tx, &row.id).await?;
            }
            tx.commit().await?;
        }
        return Ok("expired".into());
    }
    Ok(row.status.clone())
}

/// Loads a session that belongs to `client_id` and is usable; throws otherwise.
pub async fn require_session(
    state: &AppState,
    client_id: &str,
    session_id: &str,
) -> Result<SessionRow> {
    let row = get_session(state, session_id).await?.ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found")
    })?;
    if row.client_id != client_id {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Session not found",
        ));
    }
    let status = evaluate_session_status(state, &row).await?;
    if status != "active" && status != "pending" {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            format!("This session is {status}"),
        )
        .with_meta(serde_json::json!({ "session_id": row.id })));
    }
    let mut row = row;
    row.status = status;
    Ok(row)
}

pub async fn end_session(state: &AppState, row: &SessionRow, status: &str) -> Result<SessionRow> {
    let now_ms = now();
    let event = match status {
        "revoked" => "session.revoked",
        "removed" => "session.removed",
        _ => "session.ended",
    };
    let mut tx = state.pool.begin().await?;
    // Rank 2 → 7: the client row before the session it points at. The pointer
    // repair below updates `clients`, so taking the session lock first would
    // invert the order against `create_session`.
    crate::locks::lock_client_on(&mut tx, &row.client_id).await?;
    // Status change, grant revocation, client pointer repair and the event row
    // are one transaction. If anything fails, the whole sign-out rolls back and
    // a retry can still repair it.
    let ended = sqlx::query_as::<_, SessionRow>(
        "UPDATE sessions SET status = $1, updated_at = $2 \
         WHERE id = $3 AND status IN ('active', 'pending') RETURNING *",
    )
    .bind(status)
    .bind(now_ms)
    .bind(&row.id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(updated) = ended else {
        tx.rollback().await?;
        return get_session(state, &row.id).await?.ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found")
        });
    };
    revoke_grants_for_session_on(&mut tx, &row.id).await?;
    let client =
        sqlx::query_as::<_, orbitid_core::models::ClientRow>("SELECT * FROM clients WHERE id = $1")
            .bind(&row.client_id)
            .fetch_optional(&mut *tx)
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
        .fetch_optional(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE clients SET last_active_session_id = $1, updated_at = $2 WHERE id = $3",
        )
        .bind(next.map(|row| row.id))
        .bind(now_ms)
        .bind(&row.client_id)
        .execute(&mut *tx)
        .await?;
    }
    emit_session_event_on(&mut tx, state, event, &updated).await?;
    tx.commit().await?;
    Ok(updated)
}

/// Minimum gap between session activity writes caused by token refreshes.
pub const ACTIVITY_SLIDE_INTERVAL_MS: i64 = 30_000;
/// User-level activity is coarser: a conditional write at most once per five
/// minutes.
pub const USER_ACTIVITY_SLIDE_INTERVAL_MS: i64 = 5 * 60_000;

/// Activity bookkeeping for a token mint or handshake.
pub async fn slide_session_activity(
    state: &AppState,
    row: &SessionRow,
    at: Option<i64>,
) -> Result<SessionRow> {
    let now_ms = at.unwrap_or_else(now);
    let mut next = row.clone();
    let inactivity_ms = state.settings.get().session.inactivity_timeout_seconds * 1000;
    if inactivity_ms > 0 && now_ms - row.last_active_at >= ACTIVITY_SLIDE_INTERVAL_MS {
        sqlx::query("UPDATE sessions SET last_active_at = $1, updated_at = $1 WHERE id = $2")
            .bind(now_ms)
            .bind(&row.id)
            .execute(&state.pool)
            .await?;
        next.last_active_at = now_ms;
        next.updated_at = now_ms;
    }
    // The conditional UPDATE keeps the stored value correct across processes;
    // it is a no-op unless the value is at least five minutes old.
    sqlx::query(
        "UPDATE users SET last_active_at = $1, updated_at = $1 \
         WHERE id = $2 AND last_active_at < $3",
    )
    .bind(now_ms)
    .bind(&row.user_id)
    .bind(now_ms - USER_ACTIVITY_SLIDE_INTERVAL_MS)
    .execute(&state.pool)
    .await?;
    Ok(next)
}

/// Options for [`touch_session`]. `organization_id`: `None` leaves the active
/// organization unchanged; `Some(None)` clears it; `Some(Some(id))` selects it.
#[derive(Debug, Clone, Default)]
pub struct TouchSessionOptions {
    pub organization_id: Option<Option<String>>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

/// Updates activity, and the active organization when the user is a member.
///
/// The session write runs in a short transaction; the throttled user-activity
/// write runs after it commits as a single autocommit statement, so it never
/// holds a session lock while waiting for the user row (see
/// [`slide_session_activity`] for the same rule).
pub async fn touch_session(
    state: &AppState,
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
                .fetch_optional(&state.pool)
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
    .execute(&state.pool)
    .await?;
    let _ =
        crate::sessions_fapi::touch_user_activity_after_commit(state, &row.user_id, now_ms).await;
    get_session(state, &row.id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found"))
}

/// Marks a reverification as done on the session. Level `first_factor` also
/// refreshes the second-factor age.
pub async fn mark_session_reverified(
    state: &AppState,
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
    .execute(&state.pool)
    .await?;
    get_session(state, session_id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found"))
}

/// Re-exported so upper crates can talk about the stored status without
/// re-parsing the wire enum.
pub type SessionMethod = AuthMethod;
