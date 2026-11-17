//! Instance-wide custom roles: assignments (`user_roles`) and the claims they
//! produce. Ported from `services/user-roles.ts`.
//!
//! Organization roles live on `organization_memberships.role_key`; instance
//! roles are assigned to a user by an operator and travel in session tokens as
//! `roles` / `role_permissions`. Nothing a signed-in user can write reaches
//! these claims.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{RoleRow, UserRoleRow};
use orbitid_core::state::AppState;

use crate::rbac::{permissions_for_role_ids, role_by_key_on, role_scope, system_role_key};

/// Every assignment row for a user, sorted by key.
pub async fn user_role_rows(state: &AppState, user_id: &str) -> Result<Vec<UserRoleRow>> {
    Ok(sqlx::query_as::<_, UserRoleRow>(
        "SELECT * FROM user_roles WHERE user_id = $1 ORDER BY role_key ASC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?)
}

/// The instance role keys assigned to `user_id`.
pub async fn roles_for_user(state: &AppState, user_id: &str) -> Result<Vec<String>> {
    Ok(user_role_rows(state, user_id)
        .await?
        .into_iter()
        .map(|row| row.role_key)
        .collect())
}

/// Role keys + the union of their permissions, for the session token and
/// `UserJSON`. A role that was deleted (or is not an instance role) is dropped
/// rather than carried into a token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoleClaims {
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
}

pub async fn role_claims_for_user(state: &AppState, user_id: &str) -> Result<RoleClaims> {
    let keys = roles_for_user(state, user_id).await?;
    if keys.is_empty() {
        return Ok(RoleClaims::default());
    }
    let stored = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = ANY($1)")
        .bind(&keys)
        .fetch_all(&state.pool)
        .await?;
    let by_key: std::collections::HashMap<String, RoleRow> = stored
        .into_iter()
        .map(|role| (role.key.clone(), role))
        .collect();
    let active: Vec<String> = keys
        .iter()
        .filter(|key| {
            by_key
                .get(*key)
                .map(|role| role_scope(&role.key) == "instance")
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let role_ids: Vec<String> = active
        .iter()
        .filter_map(|key| by_key.get(key).map(|role| role.id.clone()))
        .collect();
    // One IN query for every assigned role, not one query per role.
    let by_role_id = permissions_for_role_ids(state, &role_ids).await?;
    let mut permissions = std::collections::BTreeSet::new();
    for key in &active {
        if let Some(role) = by_key.get(key) {
            if let Some(keys) = by_role_id.get(&role.id) {
                for permission in keys {
                    permissions.insert(permission.clone());
                }
            }
        }
    }
    let mut roles = active;
    roles.sort();
    Ok(RoleClaims {
        roles,
        permissions: permissions.into_iter().collect(),
    })
}

/// [`role_claims_for_user`] on a caller-owned connection, for payloads that
/// must be serialized inside the transaction.
pub async fn role_claims_for_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<RoleClaims> {
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT role_key FROM user_roles WHERE user_id = $1 ORDER BY role_key ASC",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    if keys.is_empty() {
        return Ok(RoleClaims::default());
    }
    let stored = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = ANY($1)")
        .bind(&keys)
        .fetch_all(&mut *conn)
        .await?;
    let by_key: std::collections::HashMap<String, RoleRow> = stored
        .into_iter()
        .map(|role| (role.key.clone(), role))
        .collect();
    let active: Vec<String> = keys
        .iter()
        .filter(|key| {
            by_key
                .get(*key)
                .map(|role| role_scope(&role.key) == "instance")
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    let role_ids: Vec<String> = active
        .iter()
        .filter_map(|key| by_key.get(key).map(|role| role.id.clone()))
        .collect();
    let by_role_id = crate::rbac::permissions_for_role_ids_on(conn, &role_ids).await?;
    let mut permissions = std::collections::BTreeSet::new();
    for key in &active {
        if let Some(role) = by_key.get(key) {
            if let Some(keys) = by_role_id.get(&role.id) {
                for permission in keys {
                    permissions.insert(permission.clone());
                }
            }
        }
    }
    let mut roles = active;
    roles.sort();
    Ok(RoleClaims {
        roles,
        permissions: permissions.into_iter().collect(),
    })
}

/// Replaces the instance roles of a user. Throws when a key is not an instance
/// role, and leaves the previous assignment untouched on failure.
pub async fn set_user_roles(
    state: &AppState,
    user_id: &str,
    role_keys: &[String],
) -> Result<Vec<String>> {
    let mut tx = state.pool.begin().await?;
    let roles = set_user_roles_on(&mut tx, state, user_id, role_keys).await?;
    tx.commit().await?;
    Ok(roles)
}

/// [`set_user_roles`] on a caller-owned transaction. The user row is locked
/// `FOR UPDATE` through [`crate::locks::lock_user_on`] (rank 3, before the
/// `user_roles` rows at rank 10) so two replacement requests cannot merge their sets;
/// validation and the delete/insert run inside the same transaction, leaving
/// the previous assignment untouched on failure.
pub async fn set_user_roles_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    user_id: &str,
    role_keys: &[String],
) -> Result<Vec<String>> {
    let mut unique: Vec<String> = Vec::new();
    for key in role_keys {
        if !unique.contains(key) {
            unique.push(key.clone());
        }
    }
    for key in &unique {
        let Some(role) = role_by_key_on(conn, key).await? else {
            return Err(OrbitError::unprocessable(
                error_codes::ORG_ROLE_NOT_FOUND,
                format!("Role {key} does not exist"),
            )
            .with_meta(serde_json::json!({ "param_name": "roles" })));
        };
        if role_scope(&role.key) != "instance" {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                format!(
                    "{key} is an organization role. Assign it through an organization membership, not through the user's instance roles."
                ),
            )
            .with_meta(serde_json::json!({ "param_name": "roles" })));
        }
        if system_role_key(&role.key) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                format!("{key} is a system role and cannot be assigned as an instance role"),
            )
            .with_meta(serde_json::json!({ "param_name": "roles" })));
        }
    }
    crate::locks::lock_user_on(conn, user_id).await?;
    crate::authorization::replace_user_roles(conn, user_id, &unique, now()).await?;
    unique.sort();
    Ok(unique)
}

/// How many users hold `role_key` (role deletion guard).
pub async fn role_assignment_count(state: &AppState, role_key: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_key = $1")
            .bind(role_key)
            .fetch_one(&state.pool)
            .await?,
    )
}

/// Role claims for many users with a bounded number of queries (list
/// endpoints): assignments, role rows and one permissions IN query.
pub async fn role_claims_for_users(
    state: &AppState,
    user_ids: &[String],
) -> Result<std::collections::HashMap<String, RoleClaims>> {
    let mut out: std::collections::HashMap<String, RoleClaims> = user_ids
        .iter()
        .map(|id| (id.clone(), RoleClaims::default()))
        .collect();
    let mut unique_ids: Vec<String> = user_ids.to_vec();
    unique_ids.sort();
    unique_ids.dedup();
    if unique_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, role_key FROM user_roles WHERE user_id = ANY($1) ORDER BY role_key",
    )
    .bind(&unique_ids)
    .fetch_all(&state.pool)
    .await?;
    let mut per_user: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut keys: Vec<String> = Vec::new();
    for (user_id, key) in rows {
        per_user.entry(user_id).or_default().push(key.clone());
        keys.push(key);
    }
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return Ok(out);
    }
    let stored = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = ANY($1)")
        .bind(&keys)
        .fetch_all(&state.pool)
        .await?;
    let by_key: std::collections::HashMap<String, RoleRow> = stored
        .into_iter()
        .map(|role| (role.key.clone(), role))
        .collect();
    let role_ids: Vec<String> = {
        let mut ids: Vec<String> = by_key
            .values()
            .filter(|role| role_scope(&role.key) == "instance")
            .map(|role| role.id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let by_role_id = permissions_for_role_ids(state, &role_ids).await?;
    for (user_id, assigned) in per_user {
        let mut roles: Vec<String> = assigned
            .into_iter()
            .filter(|key| {
                by_key
                    .get(key)
                    .map(|role| role_scope(&role.key) == "instance")
                    .unwrap_or(false)
            })
            .collect();
        roles.sort();
        let mut permissions = std::collections::BTreeSet::new();
        for key in &roles {
            if let Some(role) = by_key.get(key) {
                if let Some(keys) = by_role_id.get(&role.id) {
                    for permission in keys {
                        permissions.insert(permission.clone());
                    }
                }
            }
        }
        out.insert(
            user_id,
            RoleClaims {
                roles,
                permissions: permissions.into_iter().collect(),
            },
        );
    }
    Ok(out)
}
