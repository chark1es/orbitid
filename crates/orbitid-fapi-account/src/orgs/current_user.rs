//! The signed-in user's memberships, invitations and suggestions
//! (`modules/org-client/current-user.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::{OrganizationInvitationRow, SessionRow};
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::{
    has_suggestion_for_organization, suggested_organizations, user_verified_emails,
};
use orbitid_identity::org_serializers::{
    org_id_from_suggestion_id, serialize_organization_invitations, serialize_suggestion,
};
use orbitid_identity::org_shared::{
    page, require_membership, require_organization, require_organizations_enabled,
};
use orbitid_identity::orgs::{
    accept_invitation as accept_org_invitation, add_membership_on, default_role_key_on,
    leave_organization as leave_org,
};
use orbitid_identity::serializers::{serialize_membership, serialize_memberships};
use serde::Deserialize;
use serde_json::json;

use crate::reply::json_reply;
use crate::util::deleted_object;

use super::{caller_for, list_params};

#[derive(Debug, Deserialize)]
pub struct JoinOrganizationBody {
    pub organization_id: String,
}

pub async fn list_memberships(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let session = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
        .bind(&caller.session_id)
        .fetch_optional(&state.pool)
        .await?;
    let active_org_id = session
        .as_ref()
        .and_then(|session| session.last_active_organization_id.clone());
    let rows = sqlx::query_as::<_, orbitid_core::models::OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE user_id = $1",
    )
    .bind(&caller.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut serialized = serialize_memberships(&state, &rows, false).await?;
    serialized.sort_by(|a, b| {
        match &active_org_id {
            Some(active) if &a.organization.id == active => return std::cmp::Ordering::Less,
            Some(active) if &b.organization.id == active => return std::cmp::Ordering::Greater,
            _ => {}
        }
        b.created_at.cmp(&a.created_at)
    });
    let params = list_params(&uri);
    if params.page.paginated {
        let (items, total) = page(&serialized, params.page);
        return Ok(json_reply(
            json!({ "data": items, "total_count": total }),
            Vec::new(),
        ));
    }
    Ok(json_reply(json!({ "response": serialized }), Vec::new()))
}

pub async fn join_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    OrbitJson(body): OrbitJson<JoinOrganizationBody>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    if body.organization_id.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "organization_id: must be at least 1 character",
        )
        .with_meta(json!({ "param_name": "organization_id" })));
    }
    let org = require_organization(&state, &body.organization_id).await?;
    // A cheap pre-check preserves the TS error code for a duplicate join (the
    // suggestion disappears once you are a member). The transaction below
    // re-checks under the organization lock, so the race stays safe.
    let already: Option<String> = sqlx::query_scalar(
        "SELECT id FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&caller.user_id)
    .fetch_optional(&state.pool)
    .await?;
    if already.is_some() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            "You are already a member of this organization",
        ));
    }
    if !has_suggestion_for_organization(&state, &caller.user_id, &org.id).await? {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "This organization cannot be joined directly",
        ));
    }
    // Lock the user (rank 3) then the organization row (rank 8) so two
    // concurrent joins cannot both pass the duplicate check; the membership and
    // its event commit together.
    let mut tx = state.pool.begin().await?;
    let lock = orbitid_identity::locks::lock_membership_write_on(
        &mut tx,
        std::slice::from_ref(&caller.user_id),
        std::slice::from_ref(&org.id),
    )
    .await?;
    let existing = sqlx::query_as::<_, orbitid_core::models::OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&caller.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if existing.is_some() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            "You are already a member of this organization",
        ));
    }
    let role_key = default_role_key_on(&mut tx, &state).await?;
    let membership = add_membership_on(
        &mut tx,
        &state,
        &lock,
        &org.id,
        &caller.user_id,
        &role_key,
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    let payload = serialize_membership(&state, &membership, false).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn leave_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(org_id): Path<String>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let org = require_organization(&state, &org_id).await?;
    require_membership(&state, &org, &caller.user_id, "").await?;
    // The helper locks every membership of the organization, refuses the last
    // admin and writes the delete event in the same transaction, so two
    // concurrent "leave" calls by the last two admins yield exactly one success.
    let membership = leave_org(&state, &org.id, &caller.user_id).await?;
    Ok(json_reply(
        json!({ "response": deleted_object("organization_membership", &membership.id) }),
        Vec::new(),
    ))
}

pub async fn list_invitations(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let emails = user_verified_emails(&state, &caller.user_id).await?;
    if emails.is_empty() {
        let params = list_params(&uri);
        if params.page.paginated {
            return Ok(json_reply(
                json!({ "data": [], "total_count": 0 }),
                Vec::new(),
            ));
        }
        return Ok(json_reply(json!({ "response": [] }), Vec::new()));
    }
    let now_ms = now();
    let params = list_params(&uri);
    // The wire contract is `{ response }`, or `{ data, total_count }` with
    // `?paginated=true`; `limit`/`offset` apply in SQL so a signed-in user with
    // a long invitation history is never silently truncated at an arbitrary
    // row count.
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > $2) \
         AND lower(email) = ANY($1)",
    )
    .bind(&emails)
    .bind(now_ms)
    .fetch_one(&state.pool)
    .await?;
    let rows = if params.page.paginated {
        sqlx::query_as::<_, OrganizationInvitationRow>(
            "SELECT * FROM organization_invitations \
             WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > $2) \
             AND lower(email) = ANY($1) \
             ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        )
        .bind(&emails)
        .bind(now_ms)
        .bind(params.page.limit)
        .bind(params.page.offset)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as::<_, OrganizationInvitationRow>(
            "SELECT * FROM organization_invitations \
             WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > $2) \
             AND lower(email) = ANY($1) \
             ORDER BY created_at DESC",
        )
        .bind(&emails)
        .bind(now_ms)
        .fetch_all(&state.pool)
        .await?
    };
    let response = serialize_organization_invitations(&state, &rows).await?;
    if params.page.paginated {
        return Ok(json_reply(
            json!({ "data": response, "total_count": total }),
            Vec::new(),
        ));
    }
    Ok(json_reply(json!({ "response": response }), Vec::new()))
}

pub async fn accept_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let invitation = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE id = $1",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization invitation not found",
        )
    })?;
    if !user_verified_emails(&state, &caller.user_id)
        .await?
        .contains(&invitation.email.to_lowercase())
    {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "This invitation is addressed to a different email address",
        ));
    }
    if invitation.status != "pending" {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Invitation is {}", invitation.status),
        ));
    }
    if invitation.expires_at.map(|at| at <= now()).unwrap_or(false) {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_EXPIRED,
            "Organization invitation has expired",
        ));
    }
    let Some(membership) = accept_org_invitation(&state, &invitation, &caller.user_id).await?
    else {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            "Invitation is no longer pending",
        ));
    };
    let payload = serialize_membership(&state, &membership, false).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn list_suggestions(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let mut response = Vec::new();
    for (organization, domain) in suggested_organizations(&state, &caller.user_id).await? {
        response.push(serialize_suggestion(&state, &organization, &domain, "pending").await?);
    }
    Ok(json_reply(json!({ "response": response }), Vec::new()))
}

pub async fn accept_suggestion(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = caller_for(&state, &uri, &headers).await?;
    let Some(org_id) = org_id_from_suggestion_id(&id) else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization suggestion not found",
        ));
    };
    let org = require_organization(&state, &org_id).await?;
    if !has_suggestion_for_organization(&state, &caller.user_id, &org.id).await? {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization suggestion not found",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let lock = orbitid_identity::locks::lock_membership_write_on(
        &mut tx,
        std::slice::from_ref(&caller.user_id),
        std::slice::from_ref(&org.id),
    )
    .await?;
    let role_key = default_role_key_on(&mut tx, &state).await?;
    let membership = add_membership_on(
        &mut tx,
        &state,
        &lock,
        &org.id,
        &caller.user_id,
        &role_key,
        None,
        None,
    )
    .await?;
    tx.commit().await?;
    let payload = serialize_membership(&state, &membership, false).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}
