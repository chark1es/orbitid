//! Sign-in attempt reads and version-checked state transitions.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::SignInRow;
use orbitid_core::state::AppState;

use crate::state::SignInState;

pub async fn require_sign_in(state: &AppState, id: &str) -> Result<SignInRow> {
    sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-in not found"))
}

pub async fn reload_sign_in(state: &AppState, id: &str) -> Result<SignInRow> {
    require_sign_in(state, id).await
}

/// Terminal attempts never change again.
pub fn is_terminal_sign_in_status(status: &str) -> bool {
    matches!(status, "complete" | "abandoned")
}

/// The error a stale writer (one whose `version` no longer matches) receives.
/// Reloading lets an already-completed attempt answer exactly like the
/// TypeScript server's `client_state_invalid`.
pub(crate) async fn stale_sign_in(state: &AppState, id: &str) -> OrbitError {
    match reload_sign_in(state, id).await {
        Ok(row) if row.status == "complete" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in is already complete",
        ),
        Ok(_) => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in was updated by another request. Reload and try again.",
        ),
        Err(error) => error,
    }
}

/// One guarded write to a sign-in row. Every field is optional; `None` keeps
/// the stored value. The update only applies when the caller's `version` is
/// still current and the row is not terminal, then bumps `version`. A write
/// that matches no row is a stale request.
#[derive(Debug, Clone, Default)]
pub struct SignInTransition<'a> {
    pub status: Option<&'a str>,
    pub state: Option<&'a SignInState>,
    pub user_id: Option<&'a str>,
    pub identifier: Option<&'a str>,
}

pub async fn transition_sign_in(
    state: &AppState,
    row: &SignInRow,
    next: SignInTransition<'_>,
) -> Result<SignInRow> {
    let json = next
        .state
        .map(|value| serde_json::to_value(value).unwrap_or_default());
    let updated = sqlx::query_as::<_, SignInRow>(
        "UPDATE sign_ins SET status = COALESCE($1, status), \
         state = COALESCE($2::jsonb, state), user_id = COALESCE($3, user_id), \
         identifier = COALESCE($4, identifier), version = version + 1, updated_at = $5 \
         WHERE id = $6 AND version = $7 AND status NOT IN ('complete','abandoned') \
         RETURNING *",
    )
    .bind(next.status)
    .bind(json.map(sqlx::types::Json))
    .bind(next.user_id)
    .bind(next.identifier)
    .bind(now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&state.pool)
    .await?;
    match updated {
        Some(row) => Ok(row),
        None => Err(stale_sign_in(state, &row.id).await),
    }
}

pub fn as_sign_in_state(row: &SignInRow) -> SignInState {
    SignInState::from_json(&row.state.0)
}

/// Persists the state JSON and returns the updated row clone.
pub async fn save_sign_in_state(
    state: &AppState,
    row: &SignInRow,
    next: &SignInState,
) -> Result<SignInRow> {
    transition_sign_in(
        state,
        row,
        SignInTransition {
            state: Some(next),
            ..Default::default()
        },
    )
    .await
}

/// Sets the row status (and optionally the user / created session).
pub async fn set_sign_in_status(
    state: &AppState,
    row: &SignInRow,
    status: &str,
    user_id: Option<&str>,
) -> Result<()> {
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some(status),
            user_id,
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}
