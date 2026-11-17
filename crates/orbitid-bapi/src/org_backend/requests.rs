//! Membership request and organization-scoped role routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{OrganizationMembershipRequestRow, RoleRow};
use orbitid_core::state::AppState;
use orbitid_identity::org_serializers::serialize_membership_request;
use orbitid_identity::org_shared::{page, sort_rows, ListParams};
use orbitid_identity::rbac::roles::serialize_role;
use serde::Deserialize;
use serde_json::json;

use super::shared::{list_response, require_organization};
use crate::shared::{json_response, to_value, QueryPairs};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/organizations/{id}/membership_requests",
            get(list).post(create),
        )
        .route(
            "/v1/organizations/{id}/membership_requests/{rid}/accept",
            post(accept),
        )
        .route(
            "/v1/organizations/{id}/membership_requests/{rid}/reject",
            post(reject),
        )
        .route("/v1/organizations/{id}/roles", get(org_roles))
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let list = query.list()?;
    let status = query.raw("status").map(str::to_string);
    let rows: Vec<OrganizationMembershipRequestRow> =
        sqlx::query_as("SELECT * FROM organization_membership_requests WHERE organization_id = $1")
            .bind(&org.id)
            .fetch_all(&state.pool)
            .await?;
    let mut serialized = Vec::with_capacity(rows.len());
    for row in rows.iter().filter(|row| {
        status
            .as_ref()
            .map(|status| &row.status == status)
            .unwrap_or(true)
    }) {
        serialized.push(serialize_membership_request(&state, row).await?);
    }
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
    status: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let status = body.status.unwrap_or_else(|| "pending".to_string());
    if !["pending", "accepted", "rejected"].contains(&status.as_str()) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "status must be pending, accepted or rejected",
        )
        .with_meta(json!({ "param_name": "status" })));
    }
    let row = {
        let mut tx = state.pool.begin().await?;
        let Some(user) =
            orbitid_identity::lookups_bapi::find_user_on(&mut tx, &body.user_id).await?
        else {
            return Err(
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found")
                    .with_meta(json!({ "param_name": "user_id" })),
            );
        };
        if orbitid_identity::lookups_bapi::find_membership_on(&mut tx, &org.id, &user.id)
            .await?
            .is_some()
        {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                "User is already a member of this organization",
            ));
        }
        let row = orbitid_identity::orgs::create_membership_request_on(
            &mut tx, &state, &org, &user.id, &status,
        )
        .await?;
        tx.commit().await?;
        row
    };
    Ok(json_response(to_value(
        serialize_membership_request(&state, &row).await?,
    )?))
}

async fn accept(
    State(state): State<AppState>,
    Path((id, rid)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let value = {
        let mut tx = state.pool.begin().await?;
        let membership =
            orbitid_identity::orgs::accept_membership_request_on(&mut tx, &state, &org, &rid)
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

async fn reject(
    State(state): State<AppState>,
    Path((id, rid)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let updated = {
        let mut tx = state.pool.begin().await?;
        let updated = orbitid_identity::orgs::reject_membership_request_on(&mut tx, &org, &rid)
            .await?
            .ok_or_else(|| {
                OrbitError::conflict(
                    error_codes::DUPLICATE_RECORD,
                    "Membership request was already resolved",
                )
            })?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(
        serialize_membership_request(&state, &updated).await?,
    )?))
}

async fn org_roles(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    require_organization(&state, &id).await?;
    let list = query.list()?;
    let mut rows: Vec<RoleRow> = sqlx::query_as("SELECT * FROM roles")
        .fetch_all(&state.pool)
        .await?;
    sort_rows(
        &mut rows,
        list.order_by.as_deref().or(Some("created_at")),
        |role, field| match field {
            "created_at" => Some(json!(role.created_at)),
            "updated_at" => Some(json!(role.updated_at)),
            "key" => Some(json!(role.key)),
            "name" => Some(json!(role.name)),
            _ => None,
        },
    );
    let (items, total) = page(
        &rows,
        ListParams {
            limit: list.limit,
            offset: list.offset,
            paginated: true,
        },
    );
    let mut data = Vec::with_capacity(items.len());
    for role in &items {
        data.push(to_value(serialize_role(&state, role).await?)?);
    }
    Ok(json_response(list_response(
        serde_json::Value::Array(data),
        total,
    )))
}
