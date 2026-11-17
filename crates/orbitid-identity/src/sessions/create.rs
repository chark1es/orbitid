//! Session creation, MFA-enrollment completion and the new-sign-in email.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::SessionRow;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa_enrollment_required_on;
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};

use super::{emit_session_event_on, session_expire_at};
use crate::grants::revoke_grants_for_session_on;
use crate::users::{primary_email, touch_user_on, TouchUserPatch};

/// Input for [`create_session`].
#[derive(Debug, Clone, Default)]
pub struct CreateSessionInput {
    pub client_id: String,
    pub user_id: String,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub max_lifetime_seconds: Option<i64>,
    /// `false` stores a null first-factor timestamp.
    pub first_factor: bool,
    pub second_factor: bool,
    pub method: Option<String>,
    /// Rotates the browser's opaque client token as the session is created
    /// (session-fixation defence). The new token is returned in
    /// [`CreatedSession::client_token`] so the caller can set the cookie.
    pub rotate_client_token: bool,
}

impl CreateSessionInput {
    pub fn new(client_id: impl Into<String>, user_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            user_id: user_id.into(),
            first_factor: true,
            ..Default::default()
        }
    }
}

/// Result of [`create_session`].
#[derive(Clone)]
pub struct CreatedSession {
    pub id: String,
    /// New `__client` value when `rotate_client_token` was requested.
    pub client_token: Option<String>,
    /// Sessions ended by single-session mode. Their `session.ended` events are
    /// written by [`emit_created_session_events_on`] in the same transaction as
    /// the new session.
    pub ended_sessions: Vec<SessionRow>,
}

impl std::fmt::Debug for CreatedSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedSession")
            .field("id", &self.id)
            .field("client_token", &"<redacted>")
            .field("ended_sessions", &self.ended_sessions)
            .finish()
    }
}

/// Creates an active session (single-session mode ends the client's other
/// sessions), updates user timestamps and writes `session.created` plus the
/// single-session `session.ended` events in one transaction.
pub async fn create_session(state: &AppState, input: CreateSessionInput) -> Result<CreatedSession> {
    let mut tx = state.pool.begin().await?;
    let created = create_session_on(state, &mut tx, input).await?;
    emit_created_session_events_on(&mut tx, state, &created).await?;
    tx.commit().await?;
    Ok(created)
}

/// Same as [`create_session`] but joins the caller's transaction. Used by
/// sign-in/sign-up completion so claiming the attempt and creating its session
/// commit atomically.
pub async fn create_session_in_tx(
    state: &AppState,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    input: CreateSessionInput,
) -> Result<CreatedSession> {
    create_session_on(state, &mut *tx, input).await
}

/// [`create_session_in_tx`] for a caller that drives a raw connection instead of
/// a `sqlx::Transaction` value (the Frontend API composes several `_on` helpers
/// around one connection). Never acquires a pool connection.
pub async fn create_session_conn(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    input: CreateSessionInput,
) -> Result<CreatedSession> {
    create_session_on(state, conn, input).await
}

/// Writes `session.ended` for every session ended by single-session mode and
/// `session.created` for the new session, on the caller's connection. Call it
/// before committing the transaction that created the session, so an event can
/// never describe a rolled-back change and a committed session is never left
/// without its event.
pub async fn emit_created_session_events_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    created: &CreatedSession,
) -> Result<()> {
    for row in &created.ended_sessions {
        emit_session_event_on(conn, state, "session.ended", row).await?;
    }
    let row = get_session_on(conn, &created.id)
        .await?
        .ok_or_else(|| OrbitError::internal("session disappeared after insert"))?;
    emit_session_event_on(conn, state, "session.created", &row).await
}

async fn get_session_on(
    conn: &mut sqlx::PgConnection,
    session_id: &str,
) -> Result<Option<SessionRow>> {
    Ok(
        sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

async fn create_session_on(
    state: &AppState,
    conn: &mut sqlx::PgConnection,
    input: CreateSessionInput,
) -> Result<CreatedSession> {
    let settings = state.settings.get();
    let now_ms = now();
    // Global lock order (rank 2 → 3 → 7): client, then user, then sessions.
    // Taking the client row first serializes single-session mode across
    // replicas; the user row is taken before any session so a concurrent ban or
    // deletion (which also locks the user before touching sessions) can never
    // form a cycle. See `crate::locks`.
    crate::locks::lock_client_then_user_on(&mut *conn, &input.client_id, &input.user_id).await?;
    let mut ended_sessions = Vec::new();
    if !settings.session.multi_session {
        let others: Vec<SessionRow> = sqlx::query_as(
            "SELECT * FROM sessions WHERE client_id = $1 AND status IN ('active', 'pending') \
             ORDER BY id FOR UPDATE",
        )
        .bind(&input.client_id)
        .fetch_all(&mut *conn)
        .await?;
        let ids: Vec<String> = others.iter().map(|row| row.id.clone()).collect();
        if !ids.is_empty() {
            sqlx::query("UPDATE sessions SET status = 'ended', updated_at = $1 WHERE id = ANY($2)")
                .bind(now_ms)
                .bind(&ids)
                .execute(&mut *conn)
                .await?;
        }
        for other in others {
            revoke_grants_for_session_on(conn, &other.id).await?;
            let mut updated = other.clone();
            updated.status = "ended".into();
            updated.updated_at = now_ms;
            ended_sessions.push(updated);
        }
    }
    let expire_at = session_expire_at(
        now_ms,
        settings.session.lifetime_seconds,
        input.max_lifetime_seconds,
    );
    let id = new_id(id_prefix::SESSION);
    let owner =
        sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(&input.user_id)
            .fetch_optional(&mut *conn)
            .await?;
    // The caller checked ban/lock on an unlocked read; re-check on the row read
    // under the user lock so a ban that committed in between cannot get a
    // session (the ban already ended every session that existed).
    if let Some(owner) = owner.as_ref() {
        if owner.banned {
            return Err(OrbitError::forbidden(
                error_codes::USER_BANNED,
                "This user has been banned",
            ));
        }
        if owner.locked
            && owner
                .lockout_expires_at
                .map(|at| at > now_ms)
                .unwrap_or(true)
        {
            return Err(OrbitError::forbidden(
                error_codes::USER_LOCKED,
                "This account is locked due to too many failed attempts",
            ));
        }
    }
    let pending = match owner.as_ref() {
        Some(owner) => mfa_enrollment_required_on(state, conn, owner).await?,
        None => false,
    };
    sqlx::query(
        "INSERT INTO sessions (id, client_id, user_id, status, auth_method, last_active_at, \
         expire_at, abandon_at, actor, first_factor_verified_at, second_factor_verified_at, ip, \
         user_agent, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,NULL,$8,$9,$10,$11,$6,$6)",
    )
    .bind(&id)
    .bind(&input.client_id)
    .bind(&input.user_id)
    .bind(if pending { "pending" } else { "active" })
    .bind(&input.method)
    .bind(now_ms)
    .bind(expire_at)
    .bind(input.first_factor.then_some(now_ms))
    .bind(input.second_factor.then_some(now_ms))
    .bind(&input.ip)
    .bind(&input.user_agent)
    .execute(&mut *conn)
    .await?;
    sqlx::query("UPDATE clients SET last_active_session_id = $1, updated_at = $2 WHERE id = $3")
        .bind(&id)
        .bind(now_ms)
        .bind(&input.client_id)
        .execute(&mut *conn)
        .await?;
    let client_token = if input.rotate_client_token {
        let token = orbitid_core::crypto::random_token(32);
        sqlx::query(
            "UPDATE clients SET token_hash = $1, token_issued_at = $2, updated_at = $2 \
             WHERE id = $3",
        )
        .bind(orbitid_core::crypto::sha256(&token))
        .bind(now_ms)
        .bind(&input.client_id)
        .execute(&mut *conn)
        .await?;
        Some(token)
    } else {
        None
    };
    touch_user_on(
        conn,
        &input.user_id,
        TouchUserPatch {
            last_active_at: Some(now_ms),
            last_sign_in_at: Some(now_ms),
        },
    )
    .await?;
    Ok(CreatedSession {
        id,
        client_token,
        ended_sessions,
    })
}

/// The session that just enrolled a second factor becomes active; other pending
/// sessions of the user are revoked instead of inheriting it.
pub async fn complete_mfa_enrollment(
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    complete_mfa_enrollment_on(&mut tx, state, user_id, session_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`complete_mfa_enrollment`] on a caller-owned connection. Lock order:
/// the session's client (rank 2), the user (rank 3), then the user's pending
/// sessions in ascending `id` (rank 7); every pending sibling is revoked from
/// that stable snapshot instead of while scanning an unordered result.
pub async fn complete_mfa_enrollment_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    session_id: &str,
) -> Result<()> {
    let now_ms = now();
    let client_id: Option<String> =
        sqlx::query_scalar("SELECT client_id FROM sessions WHERE id = $1 AND user_id = $2")
            .bind(session_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(client_id) = client_id {
        crate::locks::lock_client_then_user_on(conn, &client_id, user_id).await?;
    } else {
        crate::locks::lock_user_on(conn, user_id).await?;
    }
    sqlx::query(
        "UPDATE sessions SET status = 'active', second_factor_verified_at = $1, updated_at = $1 \
         WHERE id = $2 AND user_id = $3 AND status = 'pending'",
    )
    .bind(now_ms)
    .bind(session_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    let others = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE user_id = $1 AND status = 'pending' ORDER BY id FOR UPDATE",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let ids: Vec<String> = others.iter().map(|row| row.id.clone()).collect();
    if !ids.is_empty() {
        sqlx::query("UPDATE sessions SET status = 'revoked', updated_at = $1 WHERE id = ANY($2)")
            .bind(now_ms)
            .bind(&ids)
            .execute(&mut *conn)
            .await?;
    }
    for row in others {
        revoke_grants_for_session_on(conn, &row.id).await?;
        let mut updated = row;
        updated.status = "revoked".into();
        updated.updated_at = now_ms;
        emit_session_event_on(conn, state, "session.revoked", &updated).await?;
    }
    Ok(())
}

/// Email notification for a new device/sign-in. Only genuinely new devices
/// (same ip + user agent never seen for this user) are notified.
pub async fn send_new_sign_in_email(
    state: &AppState,
    user: &orbitid_core::models::UserRow,
    session: &SessionRow,
    when: i64,
) -> Result<()> {
    let Some(email) = primary_email(state, user).await? else {
        return Ok(());
    };
    let known: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id = $1 AND id <> $2 \
         AND ip IS NOT DISTINCT FROM $3 AND user_agent IS NOT DISTINCT FROM $4)",
    )
    .bind(&user.id)
    .bind(&session.id)
    .bind(&session.ip)
    .bind(&session.user_agent)
    .fetch_one(&state.pool)
    .await?;
    if known {
        return Ok(());
    }
    let name = [user.first_name.as_deref(), user.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let name = if name.is_empty() {
        user.username.clone().unwrap_or_else(|| email.email.clone())
    } else {
        name
    };
    let mut input = SendEmailInput::new(email.email.clone(), EmailTemplate::NewSignIn);
    input.vars.insert("user_name".into(), name.into());
    input.vars.insert(
        "ip_address".into(),
        session
            .ip
            .clone()
            .unwrap_or_else(|| "unknown".into())
            .into(),
    );
    input.vars.insert(
        "user_agent".into(),
        session
            .user_agent
            .clone()
            .unwrap_or_else(|| "unknown".into())
            .into(),
    );
    input
        .vars
        .insert("date".into(), chrono_like_utc(when).into());
    let _ = send_email(state, input).await;
    Ok(())
}

/// `new Date(ms).toUTCString()` without pulling a date-time dependency into
/// the identity layer; the exact format is only used in an email body.
fn chrono_like_utc(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil date from days since the Unix epoch (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let weekday = WEEKDAYS[days.rem_euclid(7) as usize];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{weekday}, {:02} {} {year:04} {hour:02}:{minute:02}:{second:02} GMT",
        d,
        MONTHS[(m - 1) as usize]
    )
}
