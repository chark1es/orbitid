//! Lookups shared by the code exchange, refresh rotation, userinfo and
//! introspection paths, ported from `services/oidc/grants.ts`.

use orbitid_core::crypto::sha256;
use orbitid_core::error::Result;
use orbitid_core::models::{OauthGrantRow, SessionRow};
use orbitid_core::state::AppState;

use orbitid_identity::sessions::evaluate_session_status;

pub async fn find_grant_by_token(state: &AppState, token: &str) -> Result<Option<OauthGrantRow>> {
    Ok(
        sqlx::query_as::<_, OauthGrantRow>("SELECT * FROM oauth_grants WHERE token_hash = $1")
            .bind(sha256(token))
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn find_grant_by_id(state: &AppState, id: &str) -> Result<Option<OauthGrantRow>> {
    Ok(
        sqlx::query_as::<_, OauthGrantRow>("SELECT * FROM oauth_grants WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub fn is_grant_live(row: &OauthGrantRow, at: i64) -> bool {
    !row.revoked && row.expires_at > at
}

/// Whether the browser session that authorized a grant is still live. A grant
/// created without a session (device flow / client credentials) has its own
/// lifecycle and is not tied to a browser.
pub async fn authorizing_session_active(
    state: &AppState,
    session_id: Option<&str>,
) -> Result<bool> {
    let Some(session_id) = session_id.filter(|value| !value.is_empty()) else {
        return Ok(true);
    };
    let row = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let status = evaluate_session_status(state, &row).await?;
    Ok(status == "active" || status == "pending")
}
