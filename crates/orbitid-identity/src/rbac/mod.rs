//! Role/permission resolution used by both APIs, ported from
//! `services/rbac.ts`.
//!
//! Organization roles live on `organization_memberships.role_key`; instance
//! roles live in `user_roles`. The key prefix is the source of truth for the
//! scope, so no extra column can drift from it.

use std::collections::HashMap;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{OrganizationMembershipRow, RoleRow};
use orbitid_core::state::AppState;

pub const PROFILE_MANAGE: &str = "org:sys_profile:manage";
pub const PROFILE_DELETE: &str = "org:sys_profile:delete";
pub const MEMBERSHIPS_READ: &str = "org:sys_memberships:read";
pub const MEMBERSHIPS_MANAGE: &str = "org:sys_memberships:manage";
pub const DOMAINS_READ: &str = "org:sys_domains:read";
pub const DOMAINS_MANAGE: &str = "org:sys_domains:manage";
/// Instance permission that opens the admin console for a signed-in user.
/// Any instance role may carry it; the seeded Owner and Admin roles do.
pub const DASHBOARD_ACCESS: &str = "app:sys_dashboard:access";

/// The instance role the first account on a fresh instance receives.
pub const OWNER_ROLE_KEY: &str = "app:sys_owner";
/// Seeded instance role for anyone else who should run the admin console.
pub const INSTANCE_ADMIN_ROLE_KEY: &str = "app:sys_admin";

/// The system permission keys under the TypeScript `PERMISSIONS` object shape.
pub mod permissions {
    pub const PROFILE_MANAGE: &str = super::PROFILE_MANAGE;
    pub const PROFILE_DELETE: &str = super::PROFILE_DELETE;
    pub const MEMBERSHIPS_READ: &str = super::MEMBERSHIPS_READ;
    pub const MEMBERSHIPS_MANAGE: &str = super::MEMBERSHIPS_MANAGE;
    pub const DOMAINS_READ: &str = super::DOMAINS_READ;
    pub const DOMAINS_MANAGE: &str = super::DOMAINS_MANAGE;
}

pub const ADMIN_ROLE_KEY: &str = "org:admin";
pub const MEMBER_ROLE_KEY: &str = "org:member";

pub const ORG_KEY_PREFIX: &str = "org:";
pub const INSTANCE_KEY_PREFIX: &str = "app:";
pub const RESERVED_KEY_PREFIX: &str = "org:sys_";
pub const RESERVED_INSTANCE_KEY_PREFIX: &str = "app:sys_";

/// One seeded system permission.
#[derive(Debug, Clone, Copy)]
pub struct SystemPermission {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

/// One seeded system role.
#[derive(Debug, Clone, Copy)]
pub struct SystemRole {
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub is_creator_eligible: bool,
    pub permissions: &'static [&'static str],
}

pub const SYSTEM_PERMISSIONS: &[SystemPermission] = &[
    SystemPermission {
        key: PROFILE_MANAGE,
        name: "Manage organization profile",
        description: "Update the organization name, slug, logo and metadata.",
    },
    SystemPermission {
        key: PROFILE_DELETE,
        name: "Delete organization",
        description: "Delete the organization.",
    },
    SystemPermission {
        key: MEMBERSHIPS_READ,
        name: "Read organization memberships",
        description: "View members, invitations, membership requests and roles.",
    },
    SystemPermission {
        key: MEMBERSHIPS_MANAGE,
        name: "Manage organization memberships",
        description: "Add, remove and change the role of members, and manage invitations and membership requests.",
    },
    SystemPermission {
        key: DOMAINS_READ,
        name: "Read organization domains",
        description: "View organization domains.",
    },
    SystemPermission {
        key: DOMAINS_MANAGE,
        name: "Manage organization domains",
        description: "Add, verify, update and remove organization domains.",
    },
    SystemPermission {
        key: DASHBOARD_ACCESS,
        name: "Open the admin console",
        description: "Sign in to this instance's dashboard and manage it with full access.",
    },
];

const ADMIN_PERMISSIONS: &[&str] = &[
    PROFILE_MANAGE,
    PROFILE_DELETE,
    MEMBERSHIPS_READ,
    MEMBERSHIPS_MANAGE,
    DOMAINS_READ,
    DOMAINS_MANAGE,
];
const MEMBER_PERMISSIONS: &[&str] = &[MEMBERSHIPS_READ, DOMAINS_READ];
const CONSOLE_PERMISSIONS: &[&str] = &[DASHBOARD_ACCESS];

pub const SYSTEM_ROLES: &[SystemRole] = &[
    SystemRole {
        key: ADMIN_ROLE_KEY,
        name: "Admin",
        description: "Full administrative access to the organization.",
        is_creator_eligible: true,
        permissions: ADMIN_PERMISSIONS,
    },
    SystemRole {
        key: MEMBER_ROLE_KEY,
        name: "Member",
        description: "Basic access to the organization.",
        is_creator_eligible: false,
        permissions: MEMBER_PERMISSIONS,
    },
    SystemRole {
        key: OWNER_ROLE_KEY,
        name: "Owner",
        description: "Set up this instance. Full access to the admin console.",
        is_creator_eligible: false,
        permissions: CONSOLE_PERMISSIONS,
    },
    SystemRole {
        key: INSTANCE_ADMIN_ROLE_KEY,
        name: "Administrator",
        description: "Full access to the admin console.",
        is_creator_eligible: false,
        permissions: CONSOLE_PERMISSIONS,
    },
];

/// `app:` keys are instance roles; everything else (`org:` keys) is an
/// organization role. Mirrors `roleScope`.
pub fn role_scope(key: &str) -> &'static str {
    if key.starts_with(INSTANCE_KEY_PREFIX) {
        "instance"
    } else {
        "organization"
    }
}

/// The two seeded organization roles, which can neither be edited nor assigned
/// as instance roles.
pub fn system_role_key(key: &str) -> bool {
    key == ADMIN_ROLE_KEY || key == MEMBER_ROLE_KEY
}

pub async fn permissions_for_role_id(state: &AppState, role_id: &str) -> Result<Vec<String>> {
    let mut rows: Vec<String> = sqlx::query_scalar(
        "SELECT p.key FROM role_permissions rp \
         JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1",
    )
    .bind(role_id)
    .fetch_all(&state.pool)
    .await?;
    rows.sort();
    Ok(rows)
}

/// Permissions for several roles in one query (token minting).
pub async fn permissions_for_role_ids(
    state: &AppState,
    role_ids: &[String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> =
        role_ids.iter().map(|id| (id.clone(), Vec::new())).collect();
    if role_ids.is_empty() {
        return Ok(map);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT rp.role_id, p.key FROM role_permissions rp \
         JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ANY($1)",
    )
    .bind(role_ids)
    .fetch_all(&state.pool)
    .await?;
    for (role_id, key) in rows {
        if let Some(keys) = map.get_mut(&role_id) {
            keys.push(key);
        }
    }
    for keys in map.values_mut() {
        keys.sort();
    }
    Ok(map)
}

/// [`permissions_for_role_ids`] on a caller-owned connection, for payloads
/// serialized inside a transaction.
pub async fn permissions_for_role_ids_on(
    conn: &mut sqlx::PgConnection,
    role_ids: &[String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> =
        role_ids.iter().map(|id| (id.clone(), Vec::new())).collect();
    if role_ids.is_empty() {
        return Ok(map);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT rp.role_id, p.key FROM role_permissions rp \
         JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ANY($1)",
    )
    .bind(role_ids)
    .fetch_all(&mut *conn)
    .await?;
    for (role_id, key) in rows {
        if let Some(keys) = map.get_mut(&role_id) {
            keys.push(key);
        }
    }
    for keys in map.values_mut() {
        keys.sort();
    }
    Ok(map)
}

/// Permissions for several role keys in one query (role-claims batching).
pub async fn permissions_for_role_keys(
    state: &AppState,
    role_keys: &[String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut conn = state.pool.acquire().await?;
    permissions_for_role_keys_on(&mut conn, role_keys).await
}

/// [`permissions_for_role_keys`] on a caller-owned connection.
pub async fn permissions_for_role_keys_on(
    conn: &mut sqlx::PgConnection,
    role_keys: &[String],
) -> Result<HashMap<String, Vec<String>>> {
    let mut map: HashMap<String, Vec<String>> = role_keys
        .iter()
        .map(|key| (key.clone(), Vec::new()))
        .collect();
    if role_keys.is_empty() {
        return Ok(map);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.key, p.key FROM role_permissions rp \
         JOIN roles r ON r.id = rp.role_id \
         JOIN permissions p ON p.id = rp.permission_id WHERE r.key = ANY($1)",
    )
    .bind(role_keys)
    .fetch_all(&mut *conn)
    .await?;
    for (role_key, permission) in rows {
        if let Some(keys) = map.get_mut(&role_key) {
            keys.push(permission);
        }
    }
    for keys in map.values_mut() {
        keys.sort();
    }
    Ok(map)
}

/// Permissions granted by a role key (`org:admin` → all system permissions).
pub async fn permissions_for_role(state: &AppState, role_key: &str) -> Result<Vec<String>> {
    match role_by_key(state, role_key).await? {
        Some(role) => permissions_for_role_id(state, &role.id).await,
        None => Ok(Vec::new()),
    }
}

pub async fn role_by_key(state: &AppState, key: &str) -> Result<Option<RoleRow>> {
    Ok(
        sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = $1")
            .bind(key)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// [`role_by_key`] on a caller-owned connection, for payloads serialized inside
/// a transaction.
pub async fn role_by_key_on(conn: &mut sqlx::PgConnection, key: &str) -> Result<Option<RoleRow>> {
    Ok(
        sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = $1")
            .bind(key)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

pub async fn role_by_id(state: &AppState, id: &str) -> Result<Option<RoleRow>> {
    Ok(
        sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// Look up a role by id or key.
pub async fn resolve_role(state: &AppState, id_or_key: &str) -> Result<Option<RoleRow>> {
    if let Some(role) = role_by_id(state, id_or_key).await? {
        return Ok(Some(role));
    }
    role_by_key(state, id_or_key).await
}

pub fn has_permission(permissions: &[String], permission: &str) -> bool {
    permissions.iter().any(|value| value == permission)
}

pub fn assert_permission(
    membership: &OrganizationMembershipRow,
    permissions: &[String],
    permission: &str,
) -> Result<()> {
    if has_permission(permissions, permission) {
        return Ok(());
    }
    Err(OrbitError::forbidden(
        error_codes::ORG_PERMISSION_REQUIRED,
        format!(
            "You do not have permission to perform this action. Missing permission: {permission}"
        ),
    )
    .with_meta(serde_json::json!({ "permission": permission, "role": membership.role_key })))
}

/// A role that can be placed on a membership or invitation must exist and be an
/// organization role.
pub async fn assert_organization_role(
    state: &AppState,
    role_key: &str,
    param_name: &str,
) -> Result<RoleRow> {
    let mut conn = state.pool.acquire().await?;
    assert_organization_role_on(&mut conn, role_key, param_name).await
}

/// [`assert_organization_role`] on a caller-owned connection.
pub async fn assert_organization_role_on(
    conn: &mut sqlx::PgConnection,
    role_key: &str,
    param_name: &str,
) -> Result<RoleRow> {
    let Some(role) = role_by_key_on(conn, role_key).await? else {
        return Err(OrbitError::unprocessable(
            error_codes::ORG_ROLE_NOT_FOUND,
            format!("Role {role_key} does not exist"),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    };
    if role_scope(&role.key) != "organization" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!(
                "{} is an instance role and cannot be assigned to an organization. Assign it to the user instead.",
                role.key
            ),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    }
    Ok(role)
}

pub async fn is_admin_role(state: &AppState, role_key: &str) -> Result<bool> {
    Ok(permissions_for_role(state, role_key)
        .await?
        .iter()
        .any(|permission| permission == MEMBERSHIPS_MANAGE))
}

/// [`is_admin_role`] on a caller-owned connection, for decisions taken inside a
/// transaction that already holds the only available connection.
pub async fn is_admin_role_on(conn: &mut sqlx::PgConnection, role_key: &str) -> Result<bool> {
    let Some(role) = role_by_key_on(conn, role_key).await? else {
        return Ok(false);
    };
    // The map is keyed by role id, not key.
    Ok(
        permissions_for_role_ids_on(conn, std::slice::from_ref(&role.id))
            .await?
            .remove(&role.id)
            .unwrap_or_default()
            .iter()
            .any(|permission| permission == MEMBERSHIPS_MANAGE),
    )
}

pub async fn admin_memberships(
    state: &AppState,
    org_id: &str,
) -> Result<Vec<OrganizationMembershipRow>> {
    let rows = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await?;
    let keys: Vec<String> = {
        let mut keys: Vec<String> = rows.iter().map(|row| row.role_key.clone()).collect();
        keys.sort();
        keys.dedup();
        keys
    };
    let permissions = permissions_for_role_keys(state, &keys).await?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            permissions
                .get(&row.role_key)
                .map(|keys| keys.iter().any(|key| key == MEMBERSHIPS_MANAGE))
                .unwrap_or(false)
        })
        .collect())
}

/// Whether removing/demoting `membership` would leave the organization without
/// an admin.
pub async fn is_last_admin(
    state: &AppState,
    membership: &OrganizationMembershipRow,
) -> Result<bool> {
    if !is_admin_role(state, &membership.role_key).await? {
        return Ok(false);
    }
    let admins = admin_memberships(state, &membership.organization_id).await?;
    Ok(admins.iter().filter(|row| row.id != membership.id).count() == 0)
}

/// [`is_last_admin`] on a caller-owned connection. It locks every membership of
/// the organization (`FOR UPDATE`) so two concurrent removals/demotions cannot
/// both observe "another admin exists" and leave the organization adminless.
pub async fn is_last_admin_on(
    conn: &mut sqlx::PgConnection,
    membership: &OrganizationMembershipRow,
) -> Result<bool> {
    let Some(role) = role_by_key_on(conn, &membership.role_key).await? else {
        return Ok(false);
    };
    let ids = vec![role.id.clone()];
    let is_admin = permissions_for_role_ids_on(conn, &ids)
        .await?
        .remove(&role.id)
        .unwrap_or_default()
        .iter()
        .any(|permission| permission == MEMBERSHIPS_MANAGE);
    if !is_admin {
        return Ok(false);
    }
    let rows: Vec<OrganizationMembershipRow> = sqlx::query_as(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&membership.organization_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut keys: Vec<String> = rows.iter().map(|row| row.role_key.clone()).collect();
    keys.sort();
    keys.dedup();
    let roles: Vec<RoleRow> = sqlx::query_as("SELECT * FROM roles WHERE key = ANY($1)")
        .bind(&keys)
        .fetch_all(&mut *conn)
        .await?;
    let role_ids: Vec<String> = roles.iter().map(|role| role.id.clone()).collect();
    let permissions = permissions_for_role_ids_on(conn, &role_ids).await?;
    let admin_ids: std::collections::HashSet<&str> = roles
        .iter()
        .filter(|role| {
            permissions
                .get(&role.id)
                .map(|keys| keys.iter().any(|key| key == MEMBERSHIPS_MANAGE))
                .unwrap_or(false)
        })
        .map(|role| role.key.as_str())
        .collect();
    Ok(rows
        .iter()
        .filter(|row| row.id != membership.id && admin_ids.contains(row.role_key.as_str()))
        .count()
        == 0)
}

pub async fn assert_not_last_admin(
    state: &AppState,
    membership: &OrganizationMembershipRow,
    message: &str,
) -> Result<()> {
    if is_last_admin(state, membership).await? {
        return Err(
            OrbitError::forbidden(error_codes::LAST_ADMIN_CANNOT_LEAVE, message)
                .with_meta(serde_json::json!({ "role": membership.role_key })),
        );
    }
    Ok(())
}

fn valid_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

pub mod roles;

mod custom_permissions;

pub use custom_permissions::{
    create_permission_on, create_role_on, delete_permission_on, delete_role_on,
    update_permission_on, update_role_on, CreatePermissionInput, CreateRoleInput,
};
pub use roles::{
    add_role_permission, add_role_permission_on, assert_creator_eligible, assert_custom_key,
    assert_permission_scopes, assert_role_deletable, assert_role_deletable_on, membership_count,
    membership_count_on, remove_role_permission, remove_role_permission_on, resolve_permissions,
    resolve_permissions_on, role_usage_count, role_usage_count_on, serialize_permission,
    serialize_role, serialize_role_on, set_role_permissions, set_role_permissions_on,
};
