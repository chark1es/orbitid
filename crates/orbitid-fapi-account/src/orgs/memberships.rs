//! Organization membership routes (`modules/org-client/memberships.ts`).

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::OrganizationMembershipRow;
use orbitid_core::resources::OrganizationMembershipJson;
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::{page, sort_rows};
use orbitid_identity::rbac::{
    assert_organization_role, role_by_key, MEMBERSHIPS_MANAGE, MEMBERSHIPS_READ,
};
use orbitid_identity::serializers::{serialize_membership, serialize_memberships};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::reply::json_reply;
use crate::util::deleted_object;

use super::{list_params, org_access_for, query_map, require_membership};

#[derive(Debug, Deserialize)]
pub struct MembershipRoleBody {
    pub role: String,
}

async fn role_names(
    state: &AppState,
    rows: &[OrganizationMembershipRow],
) -> Result<HashMap<String, String>> {
    let mut keys: Vec<String> = rows.iter().map(|row| row.role_key.clone()).collect();
    keys.sort();
    keys.dedup();
    let mut names = HashMap::new();
    for key in keys {
        if let Some(role) = role_by_key(state, &key).await? {
            names.insert(key, role.name);
        }
    }
    Ok(names)
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_READ)).await?;
    let params = list_params(&uri);
    let role_filter = query_map(&uri).get("role").cloned();
    let mut rows = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&found.access.org.id)
    .fetch_all(&state.pool)
    .await?;
    if let Some(role) = role_filter {
        let names = role_names(&state, &rows).await?;
        let lowered = role.to_lowercase();
        rows.retain(|row| {
            row.role_key == role
                || names
                    .get(&row.role_key)
                    .map(|name| name.to_lowercase() == lowered)
                    .unwrap_or(false)
        });
    }
    let mut serialized = serialize_memberships(&state, &rows, false).await?;
    if let Some(query) = &params.query {
        serialized.retain(|membership| {
            let user = &membership.public_user_data;
            [
                Some(user.identifier.as_str()),
                user.first_name.as_deref(),
                user.last_name.as_deref(),
                Some(user.user_id.as_str()),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(query))
        });
    }
    let order = params.order_by.as_deref().unwrap_or("-created_at");
    sort_rows(&mut serialized, Some(order), membership_column);
    if params.page.paginated {
        let (items, total) = page(&serialized, params.page);
        return Ok(json_reply(
            json!({ "data": items, "total_count": total }),
            Vec::new(),
        ));
    }
    Ok(json_reply(json!({ "response": serialized }), Vec::new()))
}

fn membership_column(row: &OrganizationMembershipJson, field: &str) -> Option<Value> {
    match field {
        "created_at" => Some(json!(row.created_at)),
        "updated_at" => Some(json!(row.updated_at)),
        "role" => Some(json!(row.role)),
        _ => None,
    }
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, user_id)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<MembershipRoleBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    if body.role.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "role: must be at least 1 character",
        )
        .with_meta(json!({ "param_name": "role" })));
    }
    let membership = require_membership(&state, &found.access.org, &user_id).await?;
    let role = assert_organization_role(&state, &body.role, "role").await?;
    if role.key == membership.role_key {
        let payload = serialize_membership(&state, &membership, false).await?;
        return Ok(json_reply(json!({ "response": payload }), Vec::new()));
    }
    let mut tx = state.pool.begin().await?;
    // Rank 3 before 8: removing or demoting a member revokes their grants, and
    // that must serialize with token issuance (which key-shares this user).
    orbitid_identity::locks::lock_user_on(&mut tx, &user_id).await?;
    // Rank 8 → 9: organization before memberships, matching organization
    // deletion (organization row first, then its cascade).
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&found.access.org.id)
        .execute(&mut *tx)
        .await?;
    // Lock every membership in a stable order before the last-admin decision,
    // so two concurrent demotions cannot both see another admin.
    let rows: Vec<OrganizationMembershipRow> = sqlx::query_as(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&found.access.org.id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(membership) = rows.into_iter().find(|row| row.id == membership.id) else {
        tx.rollback().await?;
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership not found",
        ));
    };
    if orbitid_identity::rbac::is_last_admin_on(&mut tx, &membership).await?
        && !orbitid_identity::rbac::is_admin_role_on(&mut tx, &role.key).await?
    {
        tx.rollback().await?;
        return Err(OrbitError::forbidden(
            error_codes::LAST_ADMIN_CANNOT_LEAVE,
            "The last admin of an organization cannot be demoted",
        )
        .with_meta(json!({ "role": membership.role_key })));
    }
    sqlx::query("UPDATE organization_memberships SET role_key = $1, updated_at = $2 WHERE id = $3")
        .bind(&role.key)
        .bind(now())
        .bind(&membership.id)
        .execute(&mut *tx)
        .await?;
    let updated = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE id = $1",
    )
    .bind(&membership.id)
    .fetch_one(&mut *tx)
    .await?;
    let event_payload =
        orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &updated, true)
            .await?;
    orbitid_platform::webhooks::emit_event_on(
        &mut tx,
        "organizationMembership.updated",
        serde_json::to_value(&event_payload).unwrap_or_default(),
    )
    .await?;
    let client_payload =
        orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &updated, false)
            .await?;
    // A role change can add or remove authority, so the member's
    // authority-bearing grants are revoked in the same transaction.
    orbitid_identity::grants::revoke_organization_authority_grants_on(&mut tx, &updated.user_id)
        .await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": client_payload }),
        Vec::new(),
    ))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    let mut tx = state.pool.begin().await?;
    // Rank 3 before 8: removing or demoting a member revokes their grants, and
    // that must serialize with token issuance (which key-shares this user).
    orbitid_identity::locks::lock_user_on(&mut tx, &user_id).await?;
    // Rank 8 → 9: organization before memberships (as in organization delete).
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&found.access.org.id)
        .execute(&mut *tx)
        .await?;
    let rows: Vec<OrganizationMembershipRow> = sqlx::query_as(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&found.access.org.id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(membership) = rows.into_iter().find(|row| row.user_id == user_id) else {
        tx.rollback().await?;
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership not found",
        ));
    };
    if orbitid_identity::rbac::is_last_admin_on(&mut tx, &membership).await? {
        tx.rollback().await?;
        return Err(OrbitError::forbidden(
            error_codes::LAST_ADMIN_CANNOT_LEAVE,
            "The last admin of an organization cannot leave or be removed.",
        )
        .with_meta(json!({ "role": membership.role_key })));
    }
    let payload =
        orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &membership, true)
            .await?;
    sqlx::query("DELETE FROM organization_memberships WHERE id = $1")
        .bind(&membership.id)
        .execute(&mut *tx)
        .await?;
    orbitid_platform::webhooks::emit_event_on(
        &mut tx,
        "organizationMembership.deleted",
        serde_json::to_value(&payload).unwrap_or_default(),
    )
    .await?;
    // The removed member's organization-authority grants are revoked in the
    // same transaction as the membership delete.
    orbitid_identity::grants::revoke_organization_authority_grants_on(&mut tx, &membership.user_id)
        .await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": deleted_object("organization_membership", &membership.id) }),
        Vec::new(),
    ))
}
