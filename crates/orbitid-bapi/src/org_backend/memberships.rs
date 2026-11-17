//! Organization membership routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::OrganizationMembershipRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::{merge_metadata, page, sort_rows, ListParams};
use orbitid_identity::serializers::serialize_memberships;
use serde::Deserialize;
use serde_json::json;

use super::shared::{deleted, list_response, require_organization};
use crate::shared::{json_response, to_value, validate_metadata, QueryPairs};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/organizations/{id}/memberships", get(list).post(create))
        .route(
            "/v1/organizations/{id}/memberships/{user_id}",
            axum::routing::patch(update).delete(remove),
        )
        .route(
            "/v1/organizations/{id}/memberships/{user_id}/metadata",
            axum::routing::patch(update_metadata),
        )
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let list = query.list()?;
    let role = query.raw("role").map(str::to_string);
    let mut user_ids = query.values("user_id");
    user_ids.extend(query.values("user_id[]"));
    let mut rows: Vec<OrganizationMembershipRow> =
        sqlx::query_as("SELECT * FROM organization_memberships WHERE organization_id = $1")
            .bind(&org.id)
            .fetch_all(&state.pool)
            .await?;
    if !user_ids.is_empty() {
        rows.retain(|row| user_ids.contains(&row.user_id));
    }
    if let Some(role) = &role {
        rows.retain(|row| &row.role_key == role);
    }
    let mut serialized = serialize_memberships(&state, &rows, true).await?;
    if let Some(search) = query.raw("query").map(str::trim).filter(|q| !q.is_empty()) {
        let needle = search.to_lowercase();
        serialized.retain(|membership| {
            [
                Some(membership.public_user_data.identifier.clone()),
                membership.public_user_data.first_name.clone(),
                membership.public_user_data.last_name.clone(),
                Some(membership.public_user_data.user_id.clone()),
                Some(membership.role.clone()),
                Some(membership.role_name.clone()),
            ]
            .into_iter()
            .flatten()
            .any(|value| value.to_lowercase().contains(&needle))
        });
    }
    sort_rows(
        &mut serialized,
        list.order_by.as_deref().or(Some("-created_at")),
        |membership, field| match field {
            "created_at" => Some(json!(membership.created_at)),
            "updated_at" => Some(json!(membership.updated_at)),
            "role" => Some(json!(membership.role)),
            _ => None,
        },
    );
    let (items, total) = page(
        &serialized,
        ListParams {
            limit: list.limit,
            offset: list.offset,
            paginated: true,
        },
    );
    Ok(json_response(list_response(to_value(items)?, total)))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    user_id: String,
    role: Option<String>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    let value = {
        // The user/membership checks, the role validation, the capacity check,
        // the membership insert and its event are one transaction. The user
        // key-share (rank 3) and the organization row (rank 8) are locked in
        // that order, so concurrent adds serialise on the organization and
        // never exceed its capacity.
        let mut tx = state.pool.begin().await?;
        let Some(user) =
            orbitid_identity::lookups_bapi::find_user_on(&mut tx, &body.user_id).await?
        else {
            return Err(
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found")
                    .with_meta(json!({ "param_name": "user_id" })),
            );
        };
        let lock = orbitid_identity::locks::lock_membership_write_on(
            &mut tx,
            std::slice::from_ref(&user.id),
            std::slice::from_ref(&org.id),
        )
        .await?;
        if orbitid_identity::lookups_bapi::find_membership_on(&mut tx, &org.id, &user.id)
            .await?
            .is_some()
        {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                "User is already a member of this organization",
            ));
        }
        let role_key = match body.role.clone() {
            Some(role) => role,
            None => orbitid_identity::orgs::default_role_key_on(&mut tx, &state).await?,
        };
        orbitid_identity::rbac::assert_organization_role_on(&mut tx, &role_key, "role").await?;
        let membership = orbitid_identity::orgs::add_membership_on(
            &mut tx,
            &state,
            &lock,
            &org.id,
            &user.id,
            &role_key,
            body.public_metadata.clone(),
            body.private_metadata.clone(),
        )
        .await?;
        let value = to_value(
            &orbitid_identity::serializers::serialize_membership_on(
                &mut tx,
                &state,
                &membership,
                true,
            )
            .await?,
        )?;
        tx.commit().await?;
        value
    };
    Ok(json_response(value))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    role: Option<String>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn update(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    let mut tx = state.pool.begin().await?;
    // Rank 3 before 8: removing or demoting a member revokes their grants, and
    // that must serialize with token issuance (which key-shares this user).
    orbitid_identity::locks::lock_user_on(&mut tx, &user_id).await?;
    // Rank 8 → 9: the organization row before its memberships, matching the
    // organization deletion order (organization first, then its cascade).
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&org.id)
        .execute(&mut *tx)
        .await?;
    // Lock every membership in a stable order before deciding anything: the
    // last-admin check and the write then see the same rows, and concurrent
    // role changes cannot deadlock or both demote the last two admins.
    let rows: Vec<OrganizationMembershipRow> = sqlx::query_as(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&org.id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(membership) = rows.into_iter().find(|row| row.user_id == user_id) else {
        tx.rollback().await?;
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership not found",
        ));
    };
    let mut role_key = membership.role_key.clone();
    if let Some(role) = &body.role {
        if role != &membership.role_key {
            let resolved =
                orbitid_identity::rbac::assert_organization_role_on(&mut tx, role, "role").await?;
            if orbitid_identity::rbac::is_last_admin_on(&mut tx, &membership).await?
                && !orbitid_identity::lookups_bapi::is_admin_role_on(&mut tx, &resolved.key).await?
            {
                tx.rollback().await?;
                return Err(OrbitError::forbidden(
                    error_codes::LAST_ADMIN_CANNOT_LEAVE,
                    "The last admin of an organization cannot be demoted",
                )
                .with_meta(json!({ "role": membership.role_key })));
            }
            role_key = resolved.key;
        }
    }
    let public = body
        .public_metadata
        .as_ref()
        .map(|patch| merge_metadata(Some(&membership.public_metadata.0), Some(patch)))
        .unwrap_or_else(|| membership.public_metadata.0.clone());
    let private = body
        .private_metadata
        .as_ref()
        .map(|patch| merge_metadata(Some(&membership.private_metadata.0), Some(patch)))
        .unwrap_or_else(|| membership.private_metadata.0.clone());
    let role_changed = role_key != membership.role_key;
    sqlx::query(
        "UPDATE organization_memberships SET role_key = $1, public_metadata = $2, \
         private_metadata = $3, updated_at = $4 WHERE id = $5",
    )
    .bind(&role_key)
    .bind(sqlx::types::Json(public))
    .bind(sqlx::types::Json(private))
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
    let value = to_value(
        &orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &updated, true)
            .await?,
    )?;
    orbitid_platform::webhooks::emit_event_on(
        &mut tx,
        "organizationMembership.updated",
        value.clone(),
    )
    .await?;
    if role_changed {
        // A role change can add or remove authority, so the member's
        // authority-bearing grants must be revoked in the same transaction.
        orbitid_identity::grants::revoke_organization_authority_grants_on(
            &mut tx,
            &membership.user_id,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(json_response(value))
}

#[derive(Debug, Deserialize)]
struct MetadataBody {
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn update_metadata(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<MetadataBody>,
) -> Result<Response> {
    let mut tx = state.pool.begin().await?;
    // Rank 8 → 9: organization before membership, consistent with deletion.
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let membership = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships \
         WHERE organization_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(&id)
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Membership not found")
    })?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    let public = merge_metadata(
        Some(&membership.public_metadata.0),
        body.public_metadata.as_ref(),
    );
    let private = merge_metadata(
        Some(&membership.private_metadata.0),
        body.private_metadata.as_ref(),
    );
    sqlx::query(
        "UPDATE organization_memberships SET public_metadata = $1, private_metadata = $2, \
         updated_at = $3 WHERE id = $4",
    )
    .bind(sqlx::types::Json(public))
    .bind(sqlx::types::Json(private))
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
    let value = to_value(
        &orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &updated, true)
            .await?,
    )?;
    orbitid_platform::webhooks::emit_event_on(
        &mut tx,
        "organizationMembership.updated",
        value.clone(),
    )
    .await?;
    tx.commit().await?;
    Ok(json_response(value))
}

async fn remove(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let mut tx = state.pool.begin().await?;
    // Rank 3 before 8: removing or demoting a member revokes their grants, and
    // that must serialize with token issuance (which key-shares this user).
    orbitid_identity::locks::lock_user_on(&mut tx, &user_id).await?;
    // Rank 8 → 9: organization before memberships (as in organization delete).
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&org.id)
        .execute(&mut *tx)
        .await?;
    // Lock every membership in a stable order before the last-admin decision.
    let rows: Vec<OrganizationMembershipRow> = sqlx::query_as(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&org.id)
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
            "The last admin of an organization cannot be removed",
        )
        .with_meta(json!({ "role": membership.role_key })));
    }
    let payload = to_value(
        &orbitid_identity::serializers::serialize_membership_on(&mut tx, &state, &membership, true)
            .await?,
    )?;
    sqlx::query("DELETE FROM organization_memberships WHERE id = $1")
        .bind(&membership.id)
        .execute(&mut *tx)
        .await?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organizationMembership.deleted", payload)
        .await?;
    // The removed member's organization-authority grants are revoked in the
    // same transaction as the membership delete.
    orbitid_identity::grants::revoke_organization_authority_grants_on(&mut tx, &membership.user_id)
        .await?;
    tx.commit().await?;
    Ok(json_response(deleted(
        "organization_membership",
        &membership.id,
    )))
}
