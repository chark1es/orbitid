//! Custom role and permission CRUD, transaction-safe (`_on` variants).

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{PermissionRow, RoleRow};
use orbitid_core::state::AppState;

use super::roles::{
    assert_creator_eligible, assert_custom_key, assert_permission_scopes, assert_role_deletable_on,
    resolve_permissions_on, serialize_permission, serialize_role_on, set_role_permissions_on,
};

/// Input for [`create_role_on`].
#[derive(Debug, Clone, Default)]
pub struct CreateRoleInput {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub is_creator_eligible: bool,
    pub permission_keys: Vec<String>,
}

/// Creates a custom role, its permission links and the `role.created` event in
/// the caller's transaction.
pub async fn create_role_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    input: &CreateRoleInput,
) -> Result<RoleRow> {
    assert_custom_key(&input.key, "role")?;
    assert_creator_eligible(&input.key, input.is_creator_eligible)?;
    if crate::rbac::role_by_key_on(conn, &input.key)
        .await?
        .is_some()
    {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Role {} already exists", input.key),
        ));
    }
    let requested = resolve_permissions_on(conn, &input.permission_keys).await?;
    assert_permission_scopes(&input.key, &requested)?;
    let now_ms = orbitid_core::http::now();
    let id = new_id(id_prefix::ROLE);
    let row = sqlx::query_as::<_, RoleRow>(
        "INSERT INTO roles (id, key, name, description, is_creator_eligible, is_system, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,false,$6,$6) RETURNING *",
    )
    .bind(&id)
    .bind(&input.key)
    .bind(&input.name)
    .bind(input.description.clone().unwrap_or_default())
    .bind(input.is_creator_eligible)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?;
    let ids: Vec<String> = requested.iter().map(|row| row.id.clone()).collect();
    crate::authorization::replace_role_permissions(conn, &row.id, &ids).await?;
    let fresh = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
        .bind(&row.id)
        .fetch_one(&mut *conn)
        .await?;
    let payload = serde_json::to_value(serialize_role_on(conn, &fresh).await?).unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(conn, "role.created", payload).await?;
    Ok(fresh)
}

/// Updates a role's fields and/or permissions and emits `role.updated` in the
/// caller's transaction. System roles cannot be modified.
pub async fn update_role_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    role: &RoleRow,
    name: Option<&str>,
    description: Option<&str>,
    is_creator_eligible: Option<bool>,
    permission_keys: Option<&[String]>,
) -> Result<RoleRow> {
    if role.is_system {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "System roles cannot be modified",
        ));
    }
    if is_creator_eligible == Some(true) {
        assert_creator_eligible(&role.key, true)?;
    }
    if let Some(permissions) = permission_keys {
        let resolved = resolve_permissions_on(conn, permissions).await?;
        assert_permission_scopes(&role.key, &resolved)?;
    }
    sqlx::query(
        "UPDATE roles SET name = $1, description = $2, is_creator_eligible = $3, updated_at = $4 \
         WHERE id = $5",
    )
    .bind(name.unwrap_or(&role.name))
    .bind(description.unwrap_or(&role.description))
    .bind(is_creator_eligible.unwrap_or(role.is_creator_eligible))
    .bind(orbitid_core::http::now())
    .bind(&role.id)
    .execute(&mut *conn)
    .await?;
    if let Some(permissions) = permission_keys {
        set_role_permissions_on(conn, state, role, permissions).await?;
    }
    let updated = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
        .bind(&role.id)
        .fetch_one(&mut *conn)
        .await?;
    let payload =
        serde_json::to_value(serialize_role_on(conn, &updated).await?).unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(conn, "role.updated", payload).await?;
    Ok(updated)
}

/// Deletes a custom role after locking it and re-checking every reference; the
/// `role.deleted` event commits with the delete.
pub async fn delete_role_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    role: &RoleRow,
) -> Result<RoleRow> {
    let locked = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1 FOR UPDATE")
        .bind(&role.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Role not found"))?;
    assert_role_deletable_on(conn, state, &locked).await?;
    let payload = serde_json::to_value(serialize_role_on(conn, &locked).await?).unwrap_or_default();
    sqlx::query("DELETE FROM roles WHERE id = $1")
        .bind(&locked.id)
        .execute(&mut *conn)
        .await?;
    orbitid_platform::webhooks::emit_event_on(conn, "role.deleted", payload).await?;
    Ok(locked)
}

/// Input for [`create_permission_on`].
#[derive(Debug, Clone, Default)]
pub struct CreatePermissionInput {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
}

/// Creates a custom permission and its event in the caller's transaction.
pub async fn create_permission_on(
    conn: &mut sqlx::PgConnection,
    input: &CreatePermissionInput,
) -> Result<PermissionRow> {
    assert_custom_key(&input.key, "permission")?;
    if sqlx::query_scalar::<_, String>("SELECT id FROM permissions WHERE key = $1")
        .bind(&input.key)
        .fetch_optional(&mut *conn)
        .await?
        .is_some()
    {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Permission {} already exists", input.key),
        ));
    }
    let row = sqlx::query_as::<_, PermissionRow>(
        "INSERT INTO permissions (id, key, name, description, type, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,'user',$5,$5) RETURNING *",
    )
    .bind(new_id(id_prefix::PERMISSION))
    .bind(&input.key)
    .bind(&input.name)
    .bind(input.description.clone().unwrap_or_default())
    .bind(orbitid_core::http::now())
    .fetch_one(&mut *conn)
    .await?;
    let payload = serde_json::to_value(serialize_permission(&row)).unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(conn, "permission.created", payload).await?;
    Ok(row)
}

/// Updates a custom permission and emits `permission.updated`.
pub async fn update_permission_on(
    conn: &mut sqlx::PgConnection,
    permission: &PermissionRow,
    name: Option<&str>,
    description: Option<&str>,
) -> Result<PermissionRow> {
    if permission.permission_type == "system" {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "System permissions cannot be modified",
        ));
    }
    let updated = sqlx::query_as::<_, PermissionRow>(
        "UPDATE permissions SET name = $1, description = $2, updated_at = $3 \
         WHERE id = $4 RETURNING *",
    )
    .bind(name.unwrap_or(&permission.name))
    .bind(description.unwrap_or(&permission.description))
    .bind(orbitid_core::http::now())
    .bind(&permission.id)
    .fetch_one(&mut *conn)
    .await?;
    let payload = serde_json::to_value(serialize_permission(&updated)).unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(conn, "permission.updated", payload).await?;
    Ok(updated)
}

/// Deletes a custom permission and emits `permission.deleted`.
pub async fn delete_permission_on(
    conn: &mut sqlx::PgConnection,
    permission: &PermissionRow,
) -> Result<PermissionRow> {
    if permission.permission_type == "system" {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "System permissions cannot be deleted",
        ));
    }
    let locked =
        sqlx::query_as::<_, PermissionRow>("SELECT * FROM permissions WHERE id = $1 FOR UPDATE")
            .bind(&permission.id)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Permission not found")
            })?;
    let payload = serde_json::to_value(serialize_permission(&locked)).unwrap_or_default();
    // Parent first, then its `role_permissions` rows in ascending role id; the
    // cascade below would otherwise take them in table order.
    sqlx::query(
        "SELECT role_id FROM role_permissions WHERE permission_id = $1 ORDER BY role_id FOR UPDATE",
    )
    .bind(&locked.id)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM permissions WHERE id = $1")
        .bind(&locked.id)
        .execute(&mut *conn)
        .await?;
    orbitid_platform::webhooks::emit_event_on(conn, "permission.deleted", payload).await?;
    Ok(locked)
}
