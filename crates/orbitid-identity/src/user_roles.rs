//! Instance-wide custom roles: assignments (`user_roles`), the instance default
//! role, and the claims they produce. Ported from `services/user-roles.ts`.
//!
//! Organization roles live on `organization_memberships.role_key`; instance
//! roles are assigned to a user by an operator and travel in session tokens as
//! `roles` / `role_permissions`. Nothing a signed-in user can write reaches
//! these claims.
//!
//! # Effective roles
//!
//! Every reader (session tokens, JWT templates, OIDC claims, `UserJSON`,
//! `SessionJSON.user`, `GET /v1/users/{id}/roles`) goes through
//! [`role_claims_for_user`] and friends, which resolve one **effective** set:
//!
//! - **System grants** (`app:sys_owner`, `app:sys_admin` rows) always count and
//!   never decide the source: console access is granted one account at a time
//!   and is independent of the default.
//! - **Assigned**: the user has custom (non-system) `user_roles` rows, or
//!   `users.instance_roles_assigned` is true (an operator explicitly set the
//!   set with `PUT`, possibly to nothing). Those rows are the custom roles; the
//!   default plays no part.
//! - **Default**: otherwise. A non-guest user holds the configured
//!   `roles.defaultRole` when it names an existing custom `app:` role, and
//!   nothing when no default is configured. Guests (`is_anonymous`) never
//!   inherit it; they pick it up the moment they become a full account. A
//!   guest, or an id with no user, reports `Default` while holding nothing.
//!
//! The default is resolved at read time and never copied into `user_roles`, so
//! changing it applies to every inheriting user at their next token mint, and
//! an explicit assignment always wins. [`reset_user_roles_on`] returns a user to
//! the default, keeping their system grants.

use std::collections::{BTreeSet, HashMap};

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{RoleRow, UserRoleRow};
use orbitid_core::state::AppState;

use crate::rbac::{
    permissions_for_role_ids_on, role_by_key_on, role_scope, system_role_key,
    RESERVED_INSTANCE_KEY_PREFIX,
};

/// Every assignment row for a user, sorted by key. Rows only: a user who
/// inherits the default has none (see [`role_claims_for_user`]).
pub async fn user_role_rows(state: &AppState, user_id: &str) -> Result<Vec<UserRoleRow>> {
    Ok(sqlx::query_as::<_, UserRoleRow>(
        "SELECT * FROM user_roles WHERE user_id = $1 ORDER BY role_key ASC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?)
}

/// The instance role keys explicitly assigned to `user_id` (`user_roles`
/// rows). The *effective* roles, default included, are [`role_claims_for_user`].
pub async fn roles_for_user(state: &AppState, user_id: &str) -> Result<Vec<String>> {
    Ok(user_role_rows(state, user_id)
        .await?
        .into_iter()
        .map(|row| row.role_key)
        .collect())
}

/// Where a user's effective instance roles come from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RoleSource {
    /// Nothing was assigned: the instance default role applies (possibly none).
    #[default]
    Default,
    /// An operator assigned the set (possibly empty); the default is ignored.
    Assigned,
}

impl RoleSource {
    /// Wire value: `"default"` or `"assigned"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Assigned => "assigned",
        }
    }
}

/// Role keys + the union of their permissions, for the session token and
/// `UserJSON`. A role that was deleted (or is not an instance role) is dropped
/// rather than carried into a token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoleClaims {
    pub roles: Vec<String>,
    pub permissions: Vec<String>,
    pub source: RoleSource,
}

/// The configured instance default role key, if any. Not validated: the
/// resolver below drops a key that no longer names a custom instance role.
pub fn configured_default_role(state: &AppState) -> Option<String> {
    state
        .settings
        .get()
        .roles
        .default_role
        .clone()
        .filter(|key| !key.is_empty())
}

/// Whether `key` may be inherited as the default: a custom `app:` role. The
/// seeded `app:sys_*` roles open the admin console and are never inherited.
fn default_role_eligible(key: &str) -> bool {
    role_scope(key) == "instance" && !key.starts_with(RESERVED_INSTANCE_KEY_PREFIX)
}

/// Seeded instance roles (`app:sys_*`): console grants, never inherited and
/// never removed by a reset.
pub fn system_grant_key(key: &str) -> bool {
    key.starts_with(RESERVED_INSTANCE_KEY_PREFIX)
}

/// `(source, candidate keys)` per existing user, before role rows are checked.
async fn sources_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_ids: &[String],
) -> Result<HashMap<String, (RoleSource, Vec<String>)>> {
    let mut ids: Vec<String> = user_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, bool, bool, Option<String>)> = sqlx::query_as(
        "SELECT u.id, u.instance_roles_assigned, u.is_anonymous, ur.role_key \
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id \
         WHERE u.id = ANY($1) ORDER BY u.id, ur.role_key",
    )
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    let default_role = configured_default_role(state).filter(|key| default_role_eligible(key));
    let mut per_user: HashMap<String, (bool, bool, Vec<String>)> = HashMap::new();
    for (user_id, flagged, anonymous, key) in rows {
        let entry = per_user
            .entry(user_id)
            .or_insert_with(|| (flagged, anonymous, Vec::new()));
        if let Some(key) = key {
            entry.2.push(key);
        }
    }
    Ok(per_user
        .into_iter()
        .map(|(user_id, (flagged, anonymous, keys))| {
            // System grants are additive; only custom rows (or the explicit
            // marker) decide whether the default applies.
            let (mut effective, custom): (Vec<String>, Vec<String>) =
                keys.into_iter().partition(|key| system_grant_key(key));
            let source = if flagged || !custom.is_empty() {
                effective.extend(custom);
                RoleSource::Assigned
            } else {
                if !anonymous {
                    effective.extend(default_role.iter().cloned());
                }
                RoleSource::Default
            };
            (user_id, (source, effective))
        })
        .collect())
}

/// Effective role claims for many users on one connection, with a bounded
/// number of queries: assignments, role rows, one permissions IN query. A user
/// id that does not exist resolves to no roles.
pub async fn role_claims_for_users_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_ids: &[String],
) -> Result<HashMap<String, RoleClaims>> {
    let sources = sources_on(conn, state, user_ids).await?;
    let mut keys: Vec<String> = sources
        .values()
        .flat_map(|(_, keys)| keys.iter().cloned())
        .collect();
    keys.sort();
    keys.dedup();
    let by_key: HashMap<String, RoleRow> = if keys.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = ANY($1)")
            .bind(&keys)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .filter(|role| role_scope(&role.key) == "instance")
            .map(|role| (role.key.clone(), role))
            .collect()
    };
    let mut role_ids: Vec<String> = by_key.values().map(|role| role.id.clone()).collect();
    role_ids.sort();
    let by_role_id = permissions_for_role_ids_on(conn, &role_ids).await?;
    let mut out: HashMap<String, RoleClaims> = user_ids
        .iter()
        .map(|id| (id.clone(), RoleClaims::default()))
        .collect();
    for (user_id, (source, keys)) in sources {
        let mut roles: Vec<String> = keys
            .into_iter()
            .filter(|key| by_key.contains_key(key))
            .collect();
        roles.sort();
        roles.dedup();
        let mut permissions = BTreeSet::new();
        for key in &roles {
            if let Some(granted) = by_key.get(key).and_then(|role| by_role_id.get(&role.id)) {
                permissions.extend(granted.iter().cloned());
            }
        }
        out.insert(
            user_id,
            RoleClaims {
                roles,
                permissions: permissions.into_iter().collect(),
                source,
            },
        );
    }
    Ok(out)
}

/// Effective role claims for many users (list endpoints).
pub async fn role_claims_for_users(
    state: &AppState,
    user_ids: &[String],
) -> Result<HashMap<String, RoleClaims>> {
    if user_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut conn = state.pool.acquire().await?;
    role_claims_for_users_on(&mut conn, state, user_ids).await
}

/// The effective instance roles of one user, default included.
pub async fn role_claims_for_user(state: &AppState, user_id: &str) -> Result<RoleClaims> {
    let mut conn = state.pool.acquire().await?;
    role_claims_for_user_on(&mut conn, state, user_id).await
}

/// [`role_claims_for_user`] on a caller-owned connection, for payloads that
/// must be serialized inside the transaction.
pub async fn role_claims_for_user_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
) -> Result<RoleClaims> {
    let ids = [user_id.to_string()];
    Ok(role_claims_for_users_on(conn, state, &ids)
        .await?
        .remove(user_id)
        .unwrap_or_default())
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
///
/// The result is an explicit assignment, even when `role_keys` is empty: the
/// user stops inheriting the instance default until [`reset_user_roles_on`].
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

/// Drops a user's explicit custom instance-role assignment so they inherit the
/// instance default again. System grants (`app:sys_*`, console access) are
/// kept, so resetting the only owner never leaves the console unclaimed. Same
/// locking as [`set_user_roles_on`]: the user row (rank 3) before its
/// `user_roles` rows (rank 10).
pub async fn reset_user_roles_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    crate::locks::lock_user_on(conn, user_id).await?;
    sqlx::query("DELETE FROM user_roles WHERE user_id = $1 AND left(role_key, 8) <> $2")
        .bind(user_id)
        .bind(RESERVED_INSTANCE_KEY_PREFIX)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE users SET instance_roles_assigned = false WHERE id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Adds one system grant (`app:sys_*`) to a user, keeping every other row and
/// leaving the explicit-assignment marker alone: a console grant is additive
/// and never pins the user's custom roles, so a user who follows the default
/// keeps following it. Returns whether a row was inserted. The caller holds the
/// user row lock (rank 3).
pub async fn add_system_grant_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    role_key: &str,
) -> Result<bool> {
    debug_assert!(system_grant_key(role_key));
    let inserted = sqlx::query(
        "INSERT INTO user_roles (user_id, role_key, created_at, updated_at) \
         VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(role_key)
    .bind(now())
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(inserted > 0)
}

/// How many users hold `role_key` through an explicit assignment (role
/// deletion guard). Users inheriting the default have no row; the default role
/// itself is guarded separately.
pub async fn role_assignment_count(state: &AppState, role_key: &str) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM user_roles WHERE role_key = $1")
            .bind(role_key)
            .fetch_one(&state.pool)
            .await?,
    )
}
