//! Small organization helpers shared by the Frontend API routes
//! (`modules/org-client/shared.ts`).

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{
    OrganizationInvitationRow, OrganizationMembershipRequestRow, OrganizationRow,
};
use orbitid_core::state::AppState;

/// Rejects addresses already members or already invited, so bulk sends stay
/// idempotent.
pub async fn dedupe_recipients(
    state: &AppState,
    org: &OrganizationRow,
    emails: &[String],
) -> Result<Vec<String>> {
    let member_rows: Vec<String> = sqlx::query_scalar(
        "SELECT e.email FROM organization_memberships m \
         JOIN users u ON u.id = m.user_id \
         JOIN email_addresses e ON e.user_id = u.id \
         WHERE m.organization_id = $1",
    )
    .bind(&org.id)
    .fetch_all(&state.pool)
    .await?;
    let members: std::collections::HashSet<String> = member_rows
        .into_iter()
        .map(|email| email.to_lowercase())
        .collect();
    let pending_rows: Vec<String> = sqlx::query_scalar(
        "SELECT email FROM organization_invitations \
         WHERE organization_id = $1 AND status = 'pending'",
    )
    .bind(&org.id)
    .fetch_all(&state.pool)
    .await?;
    let pending: std::collections::HashSet<String> = pending_rows
        .into_iter()
        .map(|email| email.to_lowercase())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for email in emails {
        let email = email.trim().to_lowercase();
        if members.contains(&email) || pending.contains(&email) || !seen.insert(email.clone()) {
            continue;
        }
        out.push(email);
    }
    Ok(out)
}

/// Finds a membership request belonging to an organization.
pub async fn find_membership_request(
    state: &AppState,
    org_id: &str,
    id: &str,
) -> Result<OrganizationMembershipRequestRow> {
    sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests \
         WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership request not found",
        )
    })
}

/// Finds an invitation of an organization.
pub async fn find_invitation(
    state: &AppState,
    org_id: &str,
    id: &str,
) -> Result<Option<OrganizationInvitationRow>> {
    Ok(sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?)
}
