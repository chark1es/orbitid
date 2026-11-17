use axum::extract::{Path, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::RoleRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::{page, sort_rows, ListParams};
use orbitid_identity::rbac::resolve_role;
use orbitid_identity::rbac::roles::serialize_role;
use serde::Deserialize;
use serde_json::json;

use crate::org_backend::shared::{deleted, list_response};
use crate::shared::{deserialize_opt_bool, json_response, to_value, QueryPairs};

use super::permissions::{validate_description, validate_name};

pub(super) async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut rows: Vec<RoleRow> = sqlx::query_as("SELECT * FROM roles")
        .fetch_all(&state.pool)
        .await?;
    if let Some(search) = query.raw("query").filter(|q| !q.is_empty()) {
        let needle = search.to_lowercase();
        rows.retain(|role| {
            role.id.to_lowercase().contains(&needle)
                || role.key.to_lowercase().contains(&needle)
                || role.name.to_lowercase().contains(&needle)
        });
    }
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

#[derive(Debug, Deserialize)]
pub(super) struct CreateBody {
    key: String,
    name: String,
    description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    is_creator_eligible: Option<bool>,
    permissions: Option<Vec<String>>,
}

pub(super) async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let name = validate_name(&body.name)?;
    validate_description(body.description.as_deref())?;
    let created = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::rbac::create_role_on(
            &mut tx,
            &state,
            &orbitid_identity::rbac::CreateRoleInput {
                key: body.key.clone(),
                name,
                description: body.description.clone(),
                is_creator_eligible: body.is_creator_eligible.unwrap_or(false),
                permission_keys: body.permissions.clone().unwrap_or_default(),
            },
        )
        .await?;
        tx.commit().await?;
        row
    };
    let value = to_value(serialize_role(&state, &created).await?)?;
    Ok(json_response(value))
}

pub(super) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let role = resolve_role(&state, &id).await?;
    let Some(role) = role else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Role not found",
        ));
    };
    Ok(json_response(to_value(
        serialize_role(&state, &role).await?,
    )?))
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateBody {
    name: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    is_creator_eligible: Option<bool>,
    permissions: Option<Vec<String>>,
}

pub(super) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let name = match &body.name {
        Some(name) => Some(validate_name(name)?),
        None => None,
    };
    validate_description(body.description.as_deref())?;
    let updated = {
        let mut tx = state.pool.begin().await?;
        let role = orbitid_identity::lookups_bapi::resolve_role_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Role not found")
            })?;
        let updated = orbitid_identity::rbac::update_role_on(
            &mut tx,
            &state,
            &role,
            name.as_deref(),
            body.description.as_deref(),
            body.is_creator_eligible,
            body.permissions.as_deref(),
        )
        .await?;
        tx.commit().await?;
        updated
    };
    let value = to_value(serialize_role(&state, &updated).await?)?;
    Ok(json_response(value))
}

pub(super) async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let removed = {
        let mut tx = state.pool.begin().await?;
        let role = orbitid_identity::lookups_bapi::resolve_role_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Role not found")
            })?;
        let removed = orbitid_identity::rbac::delete_role_on(&mut tx, &state, &role).await?;
        tx.commit().await?;
        removed
    };
    Ok(json_response(deleted("role", &removed.id)))
}
