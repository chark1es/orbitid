//! Pure domain helpers shared by the Backend API modules, ported from
//! `modules/admin/shared.ts` and `modules/admin/users/shared.ts`.
//!
//! Query-string → SQL filter building (`userWhere`) stays in the Backend API
//! crate, which owns the request shape; the pieces here are transport-free.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;

use crate::sessions::end_sessions_for_user;

/// Audit actor recorded for secret-key (operator) actions.
pub const AUDIT_ACTOR: &str = "secret_key";
/// Profile images are capped at 512 KB.
pub const MAX_PROFILE_IMAGE_BYTES: i64 = 512 * 1024;

/// Lowercase + trim an email address.
pub fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Repeated (`?a=1&a=2`), comma separated (`?a=1,2`) and single query values.
/// `pairs` is the raw parsed query, preserving repetition order.
pub fn query_values(pairs: &[(String, String)], name: &str) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    for (key, value) in pairs {
        if key != name {
            continue;
        }
        for part in value.split(',') {
            let part = part.trim();
            if !part.is_empty() && !values.iter().any(|existing| existing == part) {
                values.push(part.to_string());
            }
        }
    }
    values
}

/// Accepts JSON booleans plus urlencoded `"true"`/`"false"`/`"1"`/`"0"`.
pub fn parse_bool_query(value: Option<&str>) -> Option<bool> {
    match value {
        Some("true") | Some("1") => Some(true),
        Some("false") | Some("0") => Some(false),
        _ => None,
    }
}

/// Refuses an operator-initiated mutation of an existing user's sign-in
/// material: a secret-key holder administers the instance, not a user's
/// account.
pub fn refuse_user_credential_mutation(what: &str, self_service: &str) -> OrbitError {
    OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        format!(
            "The Backend API cannot {what} for an existing user: an operator credential must not become a user's sign-in \
             credential or second factor. The user can do this from their own signed-in session ({self_service})."
        ),
    )
}

/// Loads a user or throws the Backend API's 404 shape.
pub async fn get_user_or_throw(state: &AppState, id: &str) -> Result<UserRow> {
    sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found.")
                .with_meta(serde_json::json!({ "param_name": "user_id" }))
        })
}

pub use crate::org_shared::merge_metadata;

/// Absolute link for tickets. The app origin comes from
/// `settings.application.homeUrl`.
pub fn ticket_url(state: &AppState, path: &str, ticket: &str) -> String {
    let base = state
        .settings
        .get()
        .application
        .home_url
        .trim_end_matches('/')
        .to_string();
    format!(
        "{base}{path}?__orbit_ticket={}",
        percent_encoding::utf8_percent_encode(ticket, percent_encoding::NON_ALPHANUMERIC)
    )
}

/// Revokes every open session of a user (ban / password change) and the OIDC
/// grants each authorized.
pub async fn revoke_sessions(
    state: &AppState,
    user_id: &str,
    except_session_id: Option<&str>,
) -> Result<()> {
    end_sessions_for_user(state, user_id, "revoked", except_session_id).await
}

/// Columns accepted by `?order_by` on the users list.
pub const USER_ORDER_COLUMNS: &[&str] = &[
    "created_at",
    "updated_at",
    "last_sign_in_at",
    "last_active_at",
    "id",
];
