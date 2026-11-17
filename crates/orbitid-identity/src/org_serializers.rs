//! Wire serializers for organization resources not covered by
//! `serializers.rs`, ported from `modules/orgs/serializers.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{
    OrganizationDomainRow, OrganizationInvitationRow, OrganizationMembershipRequestRow,
    OrganizationRow, UserRow,
};
use orbitid_core::resources::{
    EnrollmentMode, InvitationStatus, OrganizationDomainJson, OrganizationInvitationJson,
    OrganizationMembershipRequestJson, OrganizationSuggestionJson, SuggestionOrganization,
    VerificationJson, VerificationStatus,
};
use orbitid_core::state::AppState;

use crate::rbac::{role_by_key, role_by_key_on};
use crate::serializers::{serialize_organization, verified_verification};

pub use crate::rbac::{serialize_permission, serialize_role};

/// `pending` + past `expires_at` reads as `expired`.
pub fn effective_invitation_status(row: &OrganizationInvitationRow) -> InvitationStatus {
    if row.status == "pending" && row.expires_at.map(|at| at <= now()) == Some(true) {
        return InvitationStatus::Expired;
    }
    match row.status.as_str() {
        "accepted" => InvitationStatus::Accepted,
        "revoked" => InvitationStatus::Revoked,
        "expired" => InvitationStatus::Expired,
        _ => InvitationStatus::Pending,
    }
}

pub async fn serialize_organization_invitation(
    state: &AppState,
    row: &OrganizationInvitationRow,
    backend: bool,
    url: Option<&str>,
) -> Result<OrganizationInvitationJson> {
    let role_name = role_by_key(state, &row.role_key)
        .await?
        .map(|role| role.name)
        .unwrap_or_else(|| row.role_key.clone());
    let org: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, image_url FROM organizations WHERE id = $1")
            .bind(&row.organization_id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(OrganizationInvitationJson {
        object: "organization_invitation".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        organization_id: row.organization_id.clone(),
        organization_name: org.as_ref().map(|(name, _)| name.clone()),
        organization_image_url: org.and_then(|(_, image)| image),
        role: row.role_key.clone(),
        role_name,
        status: effective_invitation_status(row),
        public_metadata: row.public_metadata.0.clone(),
        private_metadata: backend.then(|| row.private_metadata.0.clone()),
        url: url.map(str::to_string),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// [`serialize_organization_invitation`] on a caller-owned connection, for
/// transactional webhook payloads (no pool access).
pub async fn serialize_organization_invitation_on(
    conn: &mut sqlx::PgConnection,
    row: &OrganizationInvitationRow,
    backend: bool,
    url: Option<&str>,
) -> Result<OrganizationInvitationJson> {
    let role_name = role_by_key_on(conn, &row.role_key)
        .await?
        .map(|role| role.name)
        .unwrap_or_else(|| row.role_key.clone());
    let org: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, image_url FROM organizations WHERE id = $1")
            .bind(&row.organization_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(OrganizationInvitationJson {
        object: "organization_invitation".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        organization_id: row.organization_id.clone(),
        organization_name: org.as_ref().map(|(name, _)| name.clone()),
        organization_image_url: org.and_then(|(_, image)| image),
        role: row.role_key.clone(),
        role_name,
        status: effective_invitation_status(row),
        public_metadata: row.public_metadata.0.clone(),
        private_metadata: backend.then(|| row.private_metadata.0.clone()),
        url: url.map(str::to_string),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// Batch form of [`serialize_organization_invitation`]: two queries for the
/// whole page instead of two per invitation (no N+1 on invitation lists).
pub async fn serialize_organization_invitations(
    state: &AppState,
    rows: &[OrganizationInvitationRow],
) -> Result<Vec<OrganizationInvitationJson>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let role_keys: Vec<String> = rows.iter().map(|row| row.role_key.clone()).collect();
    let role_names: std::collections::HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT key, name FROM roles WHERE key = ANY($1)")
            .bind(&role_keys)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .collect();
    let org_ids: Vec<String> = rows.iter().map(|row| row.organization_id.clone()).collect();
    let orgs: std::collections::HashMap<String, (String, Option<String>)> =
        sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT id, name, image_url FROM organizations WHERE id = ANY($1)",
        )
        .bind(&org_ids)
        .fetch_all(&state.pool)
        .await?
        .into_iter()
        .map(|(id, name, image)| (id, (name, image)))
        .collect();
    Ok(rows
        .iter()
        .map(|row| {
            let org = orgs.get(&row.organization_id);
            OrganizationInvitationJson {
                object: "organization_invitation".into(),
                id: row.id.clone(),
                email_address: row.email.clone(),
                organization_id: row.organization_id.clone(),
                organization_name: org.map(|(name, _)| name.clone()),
                organization_image_url: org.and_then(|(_, image)| image.clone()),
                role: row.role_key.clone(),
                role_name: role_names
                    .get(&row.role_key)
                    .cloned()
                    .unwrap_or_else(|| row.role_key.clone()),
                status: effective_invitation_status(row),
                public_metadata: row.public_metadata.0.clone(),
                private_metadata: None,
                url: None,
                created_at: row.created_at,
                updated_at: row.updated_at,
            }
        })
        .collect())
}

async fn domain_verification_on(
    conn: &mut sqlx::PgConnection,
    domain: &OrganizationDomainRow,
) -> Result<VerificationJson> {
    if domain.verified {
        return Ok(verified_verification("email_code", Some(domain.updated_at)));
    }
    let latest: Option<(i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT attempts, consumed_at, verified_at FROM verifications \
         WHERE owner_id = $1 AND purpose = 'org_domain' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&domain.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((attempts, consumed_at, verified_at)) = latest else {
        return Ok(unverified_zero());
    };
    if consumed_at.is_some() && verified_at.is_none() {
        return Ok(unverified_zero());
    }
    let expire_at: Option<i64> = sqlx::query_scalar(
        "SELECT expires_at FROM verifications WHERE owner_id = $1 AND purpose = 'org_domain' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&domain.id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(VerificationJson {
        status: VerificationStatus::Unverified,
        strategy: "email_code".into(),
        attempts: Some(attempts),
        expire_at,
        external_verification_redirect_url: None,
        error: None,
        nonce: None,
    })
}

fn unverified_zero() -> VerificationJson {
    VerificationJson {
        status: VerificationStatus::Unverified,
        strategy: "email_code".into(),
        attempts: Some(0),
        expire_at: None,
        external_verification_redirect_url: None,
        error: None,
        nonce: None,
    }
}

pub async fn serialize_organization_domain(
    state: &AppState,
    row: &OrganizationDomainRow,
) -> Result<OrganizationDomainJson> {
    let mut conn = state.pool.acquire().await?;
    serialize_organization_domain_on(&mut conn, row).await
}

/// [`serialize_organization_domain`] on a caller-owned connection, for domain
/// events written in the same transaction as the domain change.
pub async fn serialize_organization_domain_on(
    conn: &mut sqlx::PgConnection,
    row: &OrganizationDomainRow,
) -> Result<OrganizationDomainJson> {
    let enrollment_mode = match row.enrollment_mode.as_str() {
        "automatic_invitation" => EnrollmentMode::AutomaticInvitation,
        "automatic_suggestion" => EnrollmentMode::AutomaticSuggestion,
        _ => EnrollmentMode::ManualInvitation,
    };
    Ok(OrganizationDomainJson {
        object: "organization_domain".into(),
        id: row.id.clone(),
        organization_id: row.organization_id.clone(),
        name: row.name.clone(),
        enrollment_mode,
        verification: Some(domain_verification_on(conn, row).await?),
        affiliation_email_address: row.affiliation_email_address.clone(),
        total_pending_invitations: crate::org_domains::pending_invitations_for_domain_on(
            conn,
            &row.organization_id,
            &row.name,
        )
        .await?,
        total_pending_suggestions: crate::org_domains::pending_suggestions_for_domain_on(
            conn,
            &row.organization_id,
            &row.name,
        )
        .await?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn serialize_membership_request(
    state: &AppState,
    row: &OrganizationMembershipRequestRow,
) -> Result<OrganizationMembershipRequestJson> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&state.pool)
        .await?;
    let public = match user {
        Some(user) => crate::serializers::public_user_data(state, &user).await?,
        None => orbitid_core::resources::PublicUserData {
            user_id: row.user_id.clone(),
            first_name: None,
            last_name: None,
            image_url: String::new(),
            has_image: false,
            identifier: String::new(),
        },
    };
    let status = match row.status.as_str() {
        "accepted" => orbitid_core::resources::MembershipRequestStatus::Accepted,
        "rejected" => orbitid_core::resources::MembershipRequestStatus::Rejected,
        _ => orbitid_core::resources::MembershipRequestStatus::Pending,
    };
    Ok(OrganizationMembershipRequestJson {
        object: "organization_membership_request".into(),
        id: row.id.clone(),
        organization_id: row.organization_id.clone(),
        status,
        public_user_data: public,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

const SUGGESTION_PREFIX: &str = "orgsug_";

/// Suggestions are derived from verified domains, so the id is deterministic.
pub fn suggestion_id(org_id: &str) -> String {
    format!("{SUGGESTION_PREFIX}{org_id}")
}

pub fn org_id_from_suggestion_id(id: &str) -> Option<String> {
    id.strip_prefix(SUGGESTION_PREFIX).map(str::to_string)
}

pub async fn serialize_suggestion(
    state: &AppState,
    organization: &OrganizationRow,
    domain: &OrganizationDomainRow,
    status: &str,
) -> Result<OrganizationSuggestionJson> {
    let org = serialize_organization(state, organization, false, false).await?;
    let name = org.name.clone();
    Ok(OrganizationSuggestionJson {
        object: "organization_suggestion".into(),
        id: suggestion_id(&org.id),
        public_organization_data: SuggestionOrganization {
            id: org.id,
            name,
            slug: org.slug,
            image_url: org.image_url.clone(),
            has_image: org.has_image,
        },
        status: status.to_string(),
        created_at: domain.created_at,
        updated_at: domain.updated_at,
    })
}

/// Re-exported for callers that need the canonical "not found" shape.
pub fn organization_not_found() -> OrbitError {
    OrbitError::not_found(
        error_codes::ORGANIZATION_NOT_FOUND,
        "Organization not found",
    )
}
