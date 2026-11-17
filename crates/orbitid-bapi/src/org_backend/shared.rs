//! Shared helpers for the organization Backend API routes.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::OrganizationInvitationRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::deleted_object;

use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde_json::Value;

pub use orbitid_identity::org_shared::{merge_metadata, require_organization, resolve_slug};

/// `{ data, total_count }`.
pub fn list_response(data: Value, total: i64) -> Value {
    crate::shared::paginated(data, total)
}

pub async fn find_invitation(
    state: &AppState,
    org_id: &str,
    id: &str,
) -> Result<OrganizationInvitationRow> {
    sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization invitation not found",
        )
    })
}

/// Resolves a permission by id or key.
pub async fn resolve_permission(
    state: &AppState,
    id_or_key: &str,
) -> Result<Option<orbitid_core::models::PermissionRow>> {
    let by_id = sqlx::query_as::<_, orbitid_core::models::PermissionRow>(
        "SELECT * FROM permissions WHERE id = $1",
    )
    .bind(id_or_key)
    .fetch_optional(&state.pool)
    .await?;
    if by_id.is_some() {
        return Ok(by_id);
    }
    Ok(sqlx::query_as::<_, orbitid_core::models::PermissionRow>(
        "SELECT * FROM permissions WHERE key = $1",
    )
    .bind(id_or_key)
    .fetch_optional(&state.pool)
    .await?)
}

/// Sends an organization invitation email.
pub async fn notify_invitation(
    state: &AppState,
    org: &orbitid_core::models::OrganizationRow,
    email: &str,
    ticket: &str,
    role_key: &str,
) {
    let mut vars = serde_json::Map::new();
    vars.insert("organization_name".into(), serde_json::json!(org.name));
    vars.insert(
        "organization_slug".into(),
        serde_json::json!(org.slug.clone().unwrap_or_default()),
    );
    vars.insert("email_address".into(), serde_json::json!(email));
    vars.insert("role".into(), serde_json::json!(role_key));
    vars.insert(
        "invitation_url".into(),
        serde_json::json!(orbitid_identity::org_shared::invitation_url(state, ticket)),
    );
    send_email(
        state,
        SendEmailInput {
            to: email.to_string(),
            template: EmailTemplate::OrganizationInvitation,
            vars,
        },
    )
    .await;
}

/// Re-exported `{ object, id, deleted: true }`.
pub fn deleted(object: &str, id: &str) -> Value {
    deleted_object(object, id)
}
