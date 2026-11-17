use axum::extract::{Path, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{PermissionRow, RoleRow};
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::{page, sort_rows, ListParams};
use orbitid_identity::rbac::roles::serialize_permission;
use serde::Deserialize;
use serde_json::json;

use crate::org_backend::shared::{deleted, list_response, resolve_permission};
use crate::shared::{json_response, to_value, QueryPairs};

#[derive(Debug, Deserialize)]
pub(super) struct PermissionsBody {
    permissions: Vec<String>,
}

pub(super) async fn set_permissions(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PermissionsBody>,
) -> Result<Response> {
    let value = {
        let mut tx = state.pool.begin().await?;
        let role = orbitid_identity::lookups_bapi::resolve_role_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Role not found")
            })?;
        if role.is_system {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "System roles cannot be modified",
            ));
        }
        orbitid_identity::rbac::set_role_permissions_on(&mut tx, &state, &role, &body.permissions)
            .await?;
        let updated = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
            .bind(&role.id)
            .fetch_one(&mut *tx)
            .await?;
        let value = to_value(orbitid_identity::rbac::serialize_role_on(&mut tx, &updated).await?)?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "role.updated", value.clone()).await?;
        tx.commit().await?;
        value
    };
    Ok(json_response(value))
}

pub(super) async fn remove_permission(
    State(state): State<AppState>,
    Path((id, permission_id)): Path<(String, String)>,
) -> Result<Response> {
    let value = {
        let mut tx = state.pool.begin().await?;
        let role = orbitid_identity::lookups_bapi::resolve_role_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Role not found")
            })?;
        if role.is_system {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "System roles cannot be modified",
            ));
        }
        let permission =
            orbitid_identity::lookups_bapi::resolve_permission_on(&mut tx, &permission_id)
                .await?
                .ok_or_else(|| {
                    OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Permission not found")
                })?;
        let linked: Option<(String, String)> = sqlx::query_as(
            "SELECT role_id, permission_id FROM role_permissions \
             WHERE role_id = $1 AND permission_id = $2",
        )
        .bind(&role.id)
        .bind(&permission.id)
        .fetch_optional(&mut *tx)
        .await?;
        if linked.is_none() {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Role does not have this permission",
            ));
        }
        orbitid_identity::rbac::remove_role_permission_on(&mut tx, &role, &permission.id).await?;
        let updated = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
            .bind(&role.id)
            .fetch_one(&mut *tx)
            .await?;
        let value = to_value(orbitid_identity::rbac::serialize_role_on(&mut tx, &updated).await?)?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "role.updated", value.clone()).await?;
        tx.commit().await?;
        value
    };
    Ok(json_response(value))
}

pub(super) async fn list_permissions(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let mut rows: Vec<PermissionRow> = sqlx::query_as("SELECT * FROM permissions")
        .fetch_all(&state.pool)
        .await?;
    if let Some(kind) = query.raw("type") {
        rows.retain(|permission| permission.permission_type == kind);
    }
    if let Some(search) = query.raw("query").filter(|q| !q.is_empty()) {
        let needle = search.to_lowercase();
        rows.retain(|permission| {
            permission.id.to_lowercase().contains(&needle)
                || permission.key.to_lowercase().contains(&needle)
                || permission.name.to_lowercase().contains(&needle)
        });
    }
    sort_rows(
        &mut rows,
        list.order_by.as_deref().or(Some("created_at")),
        |permission, field| match field {
            "created_at" => Some(json!(permission.created_at)),
            "updated_at" => Some(json!(permission.updated_at)),
            "key" => Some(json!(permission.key)),
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
    let data = items
        .iter()
        .map(serialize_permission)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(list_response(
        serde_json::Value::Array(data),
        total,
    )))
}

#[derive(Debug, Deserialize)]
pub(super) struct PermissionBody {
    key: String,
    name: String,
    description: Option<String>,
}

pub(super) async fn create_permission(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<PermissionBody>,
) -> Result<Response> {
    let name = validate_name(&body.name)?;
    validate_description(body.description.as_deref())?;
    let row = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::rbac::create_permission_on(
            &mut tx,
            &orbitid_identity::rbac::CreatePermissionInput {
                key: body.key.clone(),
                name,
                description: body.description.clone(),
            },
        )
        .await?;
        tx.commit().await?;
        row
    };
    let value = to_value(serialize_permission(&row))?;
    Ok(json_response(value))
}

pub(super) async fn read_permission(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row = resolve_permission(&state, &id).await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Permission not found",
        ));
    };
    Ok(json_response(to_value(serialize_permission(&row))?))
}

#[derive(Debug, Deserialize)]
pub(super) struct PermissionUpdateBody {
    name: Option<String>,
    description: Option<String>,
}

pub(super) async fn update_permission(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PermissionUpdateBody>,
) -> Result<Response> {
    let name = match &body.name {
        Some(name) => Some(validate_name(name)?),
        None => None,
    };
    validate_description(body.description.as_deref())?;
    let updated = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::lookups_bapi::resolve_permission_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Permission not found")
            })?;
        let updated = orbitid_identity::rbac::update_permission_on(
            &mut tx,
            &row,
            name.as_deref(),
            body.description.as_deref(),
        )
        .await?;
        tx.commit().await?;
        updated
    };
    let value = to_value(serialize_permission(&updated))?;
    Ok(json_response(value))
}

pub(super) async fn remove_permission_row(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let removed = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::lookups_bapi::resolve_permission_on(&mut tx, &id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Permission not found")
            })?;
        let removed = orbitid_identity::rbac::delete_permission_on(&mut tx, &row).await?;
        tx.commit().await?;
        removed
    };
    Ok(json_response(deleted("permission", &removed.id)))
}

pub(super) fn validate_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 256 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "name must be 1-256 characters",
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    Ok(name.to_string())
}

pub(super) fn validate_description(value: Option<&str>) -> Result<()> {
    if value
        .map(|text| text.chars().count() > 1024)
        .unwrap_or(false)
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "description must be at most 1024 characters",
        )
        .with_meta(json!({ "param_name": "description" })));
    }
    Ok(())
}
