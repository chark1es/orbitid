//! Role/permission definition, serialization and mutation.
//!
//! Resolution lives in the parent module; this module owns custom-key
//! validation and the serialized role resources.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{PermissionRow, RoleRow};
use orbitid_core::resources::{PermissionJson, RoleJson};
use orbitid_core::state::AppState;

use super::{
    role_scope, valid_segment, INSTANCE_KEY_PREFIX, ORG_KEY_PREFIX, RESERVED_INSTANCE_KEY_PREFIX,
    RESERVED_KEY_PREFIX,
};

/// Custom key syntax for a role or permission. `org:<feature>[:<action>]` is an
/// organization role; the same shape under `app:` is instance-wide.
pub fn assert_custom_key(key: &str, kind: &str) -> Result<()> {
    let scope_prefix = if key.starts_with(INSTANCE_KEY_PREFIX) {
        INSTANCE_KEY_PREFIX
    } else if key.starts_with(ORG_KEY_PREFIX) {
        ORG_KEY_PREFIX
    } else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{kind} key must start with \"org:\" or \"app:\""),
        )
        .with_meta(serde_json::json!({ "param_name": "key" })));
    };
    let lowered = key.to_lowercase();
    if lowered.starts_with(RESERVED_KEY_PREFIX) || lowered.starts_with(RESERVED_INSTANCE_KEY_PREFIX)
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!(
                "Keys starting with \"org:sys_\" or \"app:sys_\" are reserved for system {kind}s"
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "key" })));
    }
    let rest = &key[scope_prefix.len()..];
    if rest.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{kind} key needs a name after \"{scope_prefix}\""),
        )
        .with_meta(serde_json::json!({ "param_name": "key" })));
    }
    if !rest.split(':').all(valid_segment) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!(
                "{kind} key segments must be lowercase letters, digits, \"_\" or \"-\", starting with a letter or digit"
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "key" })));
    }
    Ok(())
}

pub fn assert_permission_scopes(role_key: &str, permissions: &[PermissionRow]) -> Result<()> {
    let role_kind = role_scope(role_key);
    for permission in permissions {
        if role_scope(&permission.key) != role_kind {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                format!(
                    "{} is an {} permission; {role_key} is an {} role",
                    permission.key,
                    role_scope(&permission.key),
                    role_kind
                ),
            )
            .with_meta(serde_json::json!({ "param_name": "permissions" })));
        }
    }
    Ok(())
}

/// `is_creator_eligible` only means something for organization roles.
pub fn assert_creator_eligible(role_key: &str, eligible: bool) -> Result<()> {
    if eligible && role_scope(role_key) != "organization" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!(
                "{role_key} is an instance role and cannot be creator eligible; creatorRole must be an organization role"
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "is_creator_eligible" })));
    }
    Ok(())
}

/// Resolve permission keys or ids to rows, rejecting unknown ones.
pub async fn resolve_permissions(
    state: &AppState,
    keys_or_ids: &[String],
) -> Result<Vec<PermissionRow>> {
    let mut conn = state.pool.acquire().await?;
    resolve_permissions_on(&mut conn, keys_or_ids).await
}

/// [`resolve_permissions`] on a caller-owned connection.
pub async fn resolve_permissions_on(
    conn: &mut sqlx::PgConnection,
    keys_or_ids: &[String],
) -> Result<Vec<PermissionRow>> {
    let mut out: Vec<PermissionRow> = Vec::new();
    for key in keys_or_ids {
        let row = sqlx::query_as::<_, PermissionRow>(
            "SELECT * FROM permissions WHERE key = $1 OR id = $1 LIMIT 1",
        )
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?;
        let Some(row) = row else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                format!("Permission {key} does not exist"),
            )
            .with_meta(serde_json::json!({ "param_name": "permissions" })));
        };
        if !out.iter().any(|existing| existing.id == row.id) {
            out.push(row);
        }
    }
    Ok(out)
}

pub fn serialize_permission(row: &PermissionRow) -> PermissionJson {
    PermissionJson {
        object: "permission".into(),
        id: row.id.clone(),
        key: row.key.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        permission_type: if row.permission_type == "system" {
            "system".into()
        } else {
            "user".into()
        },
        scope: role_scope(&row.key).into(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub async fn serialize_role(state: &AppState, row: &RoleRow) -> Result<RoleJson> {
    let mut conn = state.pool.acquire().await?;
    serialize_role_on(&mut conn, row).await
}

/// [`serialize_role`] on a caller-owned connection.
pub async fn serialize_role_on(conn: &mut sqlx::PgConnection, row: &RoleRow) -> Result<RoleJson> {
    let mut permissions: Vec<PermissionJson> = sqlx::query_as::<_, PermissionRow>(
        "SELECT p.* FROM role_permissions rp \
         JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1",
    )
    .bind(&row.id)
    .fetch_all(&mut *conn)
    .await?
    .iter()
    .map(serialize_permission)
    .collect();
    permissions.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(RoleJson {
        object: "role".into(),
        id: row.id.clone(),
        key: row.key.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        scope: role_scope(&row.key).into(),
        is_system: row.is_system,
        is_creator_eligible: row.is_creator_eligible,
        permissions,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn membership_count(state: &AppState, org_id: &str) -> Result<i64> {
    let mut conn = state.pool.acquire().await?;
    membership_count_on(&mut conn, org_id).await
}

/// [`membership_count`] on a caller-owned connection.
pub async fn membership_count_on(conn: &mut sqlx::PgConnection, org_id: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&mut *conn)
    .await?)
}

/// Number of memberships that use a role (role deletion guard).
pub async fn role_usage_count(state: &AppState, role_key: &str) -> Result<i64> {
    let mut conn = state.pool.acquire().await?;
    role_usage_count_on(&mut conn, role_key).await
}

/// [`role_usage_count`] on a caller-owned connection.
pub async fn role_usage_count_on(conn: &mut sqlx::PgConnection, role_key: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_memberships WHERE role_key = $1")
            .bind(role_key)
            .fetch_one(&mut *conn)
            .await?,
    )
}

/// Ensure a role is not referenced by memberships, user assignments or settings
/// before deletion.
pub async fn assert_role_deletable(state: &AppState, role: &RoleRow) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    assert_role_deletable_on(&mut conn, state, role).await
}

/// [`assert_role_deletable`] on a caller-owned connection. The caller should
/// hold the role row lock (as [`delete_role_on`] does) so a concurrent
/// assignment cannot slip in between the checks and the delete.
pub async fn assert_role_deletable_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    role: &RoleRow,
) -> Result<()> {
    if role.is_system {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "System roles cannot be deleted",
        ));
    }
    let assignments: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_key = $1")
            .bind(&role.key)
            .fetch_one(&mut *conn)
            .await?;
    if assignments > 0 {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            format!(
                "Role is assigned to {assignments} user{} and cannot be deleted",
                if assignments == 1 { "" } else { "s" }
            ),
        ));
    }
    if role_scope(&role.key) == "organization" {
        let assigned = role_usage_count_on(conn, &role.key).await?;
        if assigned > 0 {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                format!(
                    "Role is assigned to {assigned} organization member{} and cannot be deleted",
                    if assigned == 1 { "" } else { "s" }
                ),
            ));
        }
        let organizations = state.settings.get().organizations.clone();
        if role.key == organizations.creator_role || role.key == organizations.default_role {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "Role is the configured creator or default role and cannot be deleted",
            ));
        }
        let invited: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM organization_invitations \
             WHERE role_key = $1 AND status = 'pending'",
        )
        .bind(&role.key)
        .fetch_one(&mut *conn)
        .await?;
        if invited > 0 {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                format!(
                    "Role is used by {invited} pending invitation{} and cannot be deleted",
                    if invited == 1 { "" } else { "s" }
                ),
            ));
        }
    }
    Ok(())
}

/// Replaces the permission set of a role atomically.
pub async fn set_role_permissions(
    state: &AppState,
    role: &RoleRow,
    permission_keys: &[String],
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    set_role_permissions_on(&mut tx, state, role, permission_keys).await?;
    tx.commit().await?;
    Ok(())
}

/// [`set_role_permissions`] on a caller-owned transaction. Locks the role row
/// (`LockParent::Role`) so two replacements cannot merge their sets.
pub async fn set_role_permissions_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    role: &RoleRow,
    permission_keys: &[String],
) -> Result<()> {
    let permissions = resolve_permissions_on(conn, permission_keys).await?;
    assert_permission_scopes(&role.key, &permissions)?;
    let ids: Vec<String> = permissions.iter().map(|row| row.id.clone()).collect();
    sqlx::query("UPDATE roles SET updated_at = updated_at WHERE id = $1")
        .bind(&role.id)
        .execute(&mut *conn)
        .await?;
    crate::authorization::replace_role_permissions(conn, &role.id, &ids).await
}

pub async fn add_role_permission(
    state: &AppState,
    role: &RoleRow,
    permission: &PermissionRow,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    add_role_permission_on(&mut tx, role, permission).await?;
    tx.commit().await?;
    Ok(())
}

/// [`add_role_permission`] on a caller-owned transaction.
pub async fn add_role_permission_on(
    conn: &mut sqlx::PgConnection,
    role: &RoleRow,
    permission: &PermissionRow,
) -> Result<()> {
    sqlx::query("UPDATE roles SET updated_at = updated_at WHERE id = $1")
        .bind(&role.id)
        .execute(&mut *conn)
        .await?;
    crate::authorization::key_share_permissions_on(conn, std::slice::from_ref(&permission.id))
        .await?;
    sqlx::query(
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&role.id)
    .bind(&permission.id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub async fn remove_role_permission(
    state: &AppState,
    role: &RoleRow,
    permission_id: &str,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    remove_role_permission_on(&mut tx, role, permission_id).await?;
    tx.commit().await?;
    Ok(())
}

/// [`remove_role_permission`] on a caller-owned transaction.
pub async fn remove_role_permission_on(
    conn: &mut sqlx::PgConnection,
    role: &RoleRow,
    permission_id: &str,
) -> Result<()> {
    sqlx::query("UPDATE roles SET updated_at = updated_at WHERE id = $1")
        .bind(&role.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2")
        .bind(&role.id)
        .bind(permission_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
