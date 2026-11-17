//! Membership-request and organization-role routes
//! (`modules/org-client/requests.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{OrganizationMembershipRequestRow, RoleRow};
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::has_suggestion_for_organization;
use orbitid_identity::org_serializers::{serialize_membership_request, serialize_role};
use orbitid_identity::org_shared::{
    find_membership, require_membership_requests_enabled, require_organization,
    require_organizations_enabled,
};
use orbitid_identity::orgs::requests::{
    accept_membership_request_on, create_membership_request_on, reject_membership_request_on,
};
use orbitid_identity::rbac::{MEMBERSHIPS_MANAGE, MEMBERSHIPS_READ};
use orbitid_identity::serializers::serialize_membership;
use serde_json::{json, Value};

use crate::reply::json_reply;

use super::serializers::find_membership_request;
use super::{fapi_list, org_access_for, query_map};

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    require_membership_requests_enabled(&state)?;
    let caller = super::caller_for(&state, &uri, &headers).await?;
    let org = require_organization(&state, &id).await?;
    if find_membership(&state, &org.id, &caller.user_id)
        .await?
        .is_some()
    {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            "You are already a member of this organization",
        ));
    }
    if !has_suggestion_for_organization(&state, &caller.user_id, &org.id).await? {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Your verified email domain does not allow joining this organization",
        ));
    }
    // The helper locks the organization row, returns the pending request when
    // one exists and otherwise inserts it — concurrent creates cannot race.
    let mut tx = state.pool.begin().await?;
    let row =
        create_membership_request_on(&mut tx, &state, &org, &caller.user_id, "pending").await?;
    tx.commit().await?;
    let payload = serialize_membership_request(&state, &row).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_READ)).await?;
    let status = query_map(&uri).get("status").cloned();
    let rows = sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests WHERE organization_id = $1 \
         ORDER BY created_at DESC",
    )
    .bind(&found.access.org.id)
    .fetch_all(&state.pool)
    .await?;
    let mut serialized: Vec<Value> = Vec::new();
    for row in &rows {
        if let Some(status) = &status {
            if &row.status != status {
                continue;
            }
        }
        serialized.push(
            serde_json::to_value(serialize_membership_request(&state, row).await?)
                .unwrap_or_default(),
        );
    }
    Ok(json_reply(fapi_list(&uri, serialized), Vec::new()))
}

pub async fn accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, rid)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    find_membership_request(&state, &found.access.org.id, &rid).await?;
    // The request lock, capacity check, membership insert (with its event) and
    // the status flip commit together; two concurrent accepts yield one member.
    let mut tx = state.pool.begin().await?;
    let membership = accept_membership_request_on(&mut tx, &state, &found.access.org, &rid).await?;
    tx.commit().await?;
    let payload = serialize_membership(&state, &membership, false).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn reject(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, rid)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    let request = find_membership_request(&state, &found.access.org.id, &rid).await?;
    let mut tx = state.pool.begin().await?;
    let updated = reject_membership_request_on(&mut tx, &found.access.org, &rid).await?;
    tx.commit().await?;
    let Some(updated) = updated else {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Membership request is {}", request.status),
        ));
    };
    let payload = serialize_membership_request(&state, &updated).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let _found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_READ)).await?;
    let mut rows = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles")
        .fetch_all(&state.pool)
        .await?;
    rows.sort_by(|a, b| {
        b.is_system
            .cmp(&a.is_system)
            .then_with(|| a.key.cmp(&b.key))
    });
    let mut serialized = Vec::with_capacity(rows.len());
    for row in &rows {
        serialized
            .push(serde_json::to_value(serialize_role(&state, row).await?).unwrap_or_default());
    }
    Ok(json_reply(json!({ "response": serialized }), Vec::new()))
}
