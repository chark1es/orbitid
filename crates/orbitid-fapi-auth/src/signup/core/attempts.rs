//! Sign-up attempt reads, version-checked patches and reloads.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::SignUpRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;

use crate::state::{SignUpFields, SignUpVerifications};

#[derive(Debug, Clone, Default)]
pub struct SignUpPatch {
    pub fields: Option<SignUpFields>,
    pub verifications: Option<SignUpVerifications>,
    pub status: Option<String>,
    pub unsafe_metadata: Option<Metadata>,
    pub invitation_id: Option<Option<String>>,
    pub org_invitation_id: Option<Option<String>>,
}

pub async fn save_sign_up(
    state: &AppState,
    row: &SignUpRow,
    patch: SignUpPatch,
) -> Result<SignUpRow> {
    // Patch semantics: the caller's row is both the data base and the CAS
    // token. Never reload here: the caller derived whole-replacement `fields` /
    // `verifications` objects from exactly this snapshot, so merging them into a
    // *newer* stored row would silently overwrite whatever another request wrote
    // in between (the lost-update bug this function used to have).
    let mut fields = row.fields.0.clone();
    let mut verifications = row.verifications.0.clone();
    let mut metadata = row.unsafe_metadata.0.clone();
    let status = patch.status.clone().unwrap_or_else(|| row.status.clone());
    let invitation_id = match &patch.invitation_id {
        Some(value) => value.clone(),
        None => row.invitation_id.clone(),
    };
    let org_invitation_id = match &patch.org_invitation_id {
        Some(value) => value.clone(),
        None => row.org_invitation_id.clone(),
    };
    if let Some(next) = &patch.fields {
        fields = serde_json::to_value(next).unwrap_or_default();
    }
    if let Some(next) = &patch.verifications {
        verifications = serde_json::to_value(next).unwrap_or_default();
    }
    if let Some(next) = &patch.unsafe_metadata {
        metadata = serde_json::Value::Object(next.clone());
    }
    // Compare-and-swap on the caller's version; terminal attempts are
    // immutable, so a concurrent completion can never be reopened by a stale
    // patch, and two concurrent patches cannot silently drop one another's
    // field. The loser gets `client_state_invalid` and may reload and retry.
    let updated = sqlx::query_as::<_, SignUpRow>(
        "UPDATE sign_ups SET fields = $1, verifications = $2, status = $3, unsafe_metadata = $4, \
         invitation_id = $5, org_invitation_id = $6, version = version + 1, updated_at = $7 \
         WHERE id = $8 AND version = $9 AND status NOT IN ('complete','abandoned') \
         RETURNING *",
    )
    .bind(sqlx::types::Json(&fields))
    .bind(sqlx::types::Json(&verifications))
    .bind(&status)
    .bind(sqlx::types::Json(&metadata))
    .bind(&invitation_id)
    .bind(&org_invitation_id)
    .bind(now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&state.pool)
    .await?;
    match updated {
        Some(row) => Ok(row),
        None => Err(stale_sign_up(state, &row.id).await),
    }
}

pub(super) fn is_terminal_sign_up_status(status: &str) -> bool {
    matches!(status, "complete" | "abandoned")
}

pub(crate) async fn stale_sign_up(state: &AppState, id: &str) -> OrbitError {
    match reload_sign_up(state, id).await {
        Ok(row) if row.status == "complete" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ),
        Ok(row) if row.status == "abandoned" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up has expired. Start a new sign-up.",
        ),
        Ok(_) => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up was updated by another request. Reload and try again.",
        ),
        Err(error) => error,
    }
}

pub async fn reload_sign_up(state: &AppState, id: &str) -> Result<SignUpRow> {
    sqlx::query_as::<_, SignUpRow>("SELECT * FROM sign_ups WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-up not found"))
}

/// [`save_sign_up`] on a caller-owned connection (link consumption and the
/// state transition it advances must commit together).
pub async fn save_sign_up_on(
    conn: &mut sqlx::PgConnection,
    row: &SignUpRow,
    patch: SignUpPatch,
) -> Result<SignUpRow> {
    // Enforced lock order: every write to `sign_ups` takes the client row first
    // (rank 2 before rank 4), so a caller cannot forget it. Re-locking a row the
    // transaction already holds is free.
    orbitid_identity::locks::lock_client_on(conn, &row.client_id).await?;
    let mut fields = row.fields.0.clone();
    let mut verifications = row.verifications.0.clone();
    let mut metadata = row.unsafe_metadata.0.clone();
    let status = patch.status.clone().unwrap_or_else(|| row.status.clone());
    let invitation_id = match &patch.invitation_id {
        Some(value) => value.clone(),
        None => row.invitation_id.clone(),
    };
    let org_invitation_id = match &patch.org_invitation_id {
        Some(value) => value.clone(),
        None => row.org_invitation_id.clone(),
    };
    if let Some(next) = &patch.fields {
        fields = serde_json::to_value(next).unwrap_or_default();
    }
    if let Some(next) = &patch.verifications {
        verifications = serde_json::to_value(next).unwrap_or_default();
    }
    if let Some(next) = &patch.unsafe_metadata {
        metadata = serde_json::Value::Object(next.clone());
    }
    let updated = sqlx::query_as::<_, SignUpRow>(
        "UPDATE sign_ups SET fields = $1, verifications = $2, status = $3, unsafe_metadata = $4, \
         invitation_id = $5, org_invitation_id = $6, version = version + 1, updated_at = $7 \
         WHERE id = $8 AND version = $9 AND status NOT IN ('complete','abandoned') \
         RETURNING *",
    )
    .bind(sqlx::types::Json(&fields))
    .bind(sqlx::types::Json(&verifications))
    .bind(&status)
    .bind(sqlx::types::Json(&metadata))
    .bind(&invitation_id)
    .bind(&org_invitation_id)
    .bind(now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&mut *conn)
    .await?;
    match updated {
        Some(row) => Ok(row),
        None => Err(stale_sign_up_on(conn, &row.id).await),
    }
}

/// [`stale_sign_up`] on a caller-owned connection, so a CAS loser can be
/// classified without acquiring a second pool connection.
pub(crate) async fn stale_sign_up_on(conn: &mut sqlx::PgConnection, id: &str) -> OrbitError {
    let current = sqlx::query_as::<_, SignUpRow>("SELECT * FROM sign_ups WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await;
    match current {
        Ok(Some(row)) if row.status == "complete" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ),
        Ok(Some(row)) if row.status == "abandoned" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up has expired. Start a new sign-up.",
        ),
        Ok(Some(_)) => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up was updated by another request. Reload and try again.",
        ),
        Ok(None) => OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-up not found"),
        Err(error) => error.into(),
    }
}
