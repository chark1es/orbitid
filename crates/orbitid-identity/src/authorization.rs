//! Serialized authorization writes, ported from
//! `services/authorization-transaction.ts`.
//!
//! Replacing a grant set (a user's roles, a role's permissions) is a
//! read-modify-write: delete the old rows, insert the new ones. Two requests
//! doing that concurrently could merge their sets. Every writer therefore takes
//! a row lock on the stable parent row first, inside a transaction, so the
//! replacement is serialized even across processes and replicas.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;
use sqlx::{PgConnection, Postgres, Transaction};

/// Locks the stable parent row that owns a set of grant rows.
#[derive(Debug, Clone)]
pub enum LockParent {
    /// `users.updated_at = updated_at` — serializes `user_roles` replacements.
    User(String),
    /// `roles.updated_at = updated_at` — serializes `role_permissions` replacements.
    Role(String),
}

impl LockParent {
    fn statement(&self) -> (&'static str, &str) {
        match self {
            Self::User(id) => ("UPDATE users SET updated_at = updated_at WHERE id = $1", id),
            Self::Role(id) => ("UPDATE roles SET updated_at = updated_at WHERE id = $1", id),
        }
    }
}

/// Starts a write transaction and locks `parent`, returning the transaction.
/// The caller executes its statements on the returned connection and commits.
/// Dropping it without committing rolls everything back, which is what makes a
/// failed insert preserve the previous complete grant set.
pub async fn begin_authorization(
    state: &AppState,
    parent: &LockParent,
) -> Result<Transaction<'static, Postgres>> {
    let mut tx = state.pool.begin().await?;
    let (sql, id) = parent.statement();
    sqlx::query(sql).bind(id).execute(&mut *tx).await?;
    Ok(tx)
}

/// Runs `lock` and then every statement inside one transaction, mirroring
/// `mutateAuthorization`. Statements are runtime queries, so values stay bound.
pub async fn mutate_authorization(
    state: &AppState,
    parent: LockParent,
    statements: Vec<sqlx::query::Query<'static, Postgres, sqlx::postgres::PgArguments>>,
) -> Result<()> {
    let mut tx = begin_authorization(state, &parent).await?;
    for statement in statements {
        statement.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Convenience for `INSERT ... SELECT ... FROM unnest($2::text[])`: replaces
/// every grant row of one parent with `values` in a single statement.
///
/// This is an explicit assignment: it also sets `users.instance_roles_assigned`,
/// so an empty set means "no instance roles", not "inherit the default". The
/// caller holds the user row lock (rank 3).
pub async fn replace_user_roles(
    conn: &mut PgConnection,
    user_id: &str,
    role_keys: &[String],
    now: i64,
) -> Result<()> {
    sqlx::query("UPDATE users SET instance_roles_assigned = true WHERE id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM user_roles WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    if !role_keys.is_empty() {
        sqlx::query(
            "INSERT INTO user_roles (user_id, role_key, created_at, updated_at) \
             SELECT $1, key, $3, $3 FROM unnest($2::text[]) AS key",
        )
        .bind(user_id)
        .bind(role_keys)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Takes `FOR KEY SHARE` on every listed permission row, ascending `id`.
///
/// Parent before child (rank 10): a `role_permissions` writer must hold these
/// before it touches any `role_permissions` row, because permission deletion
/// locks the permission and its cascade then waits for those child rows.
pub async fn key_share_permissions_on(
    conn: &mut PgConnection,
    permission_ids: &[String],
) -> Result<()> {
    let mut ids: Vec<String> = permission_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT id FROM permissions WHERE id = ANY($1) ORDER BY id FOR KEY SHARE")
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(())
}

/// Replaces every `role_permissions` row of `role_id` in one transaction-local
/// statement pair. Mirrors the insert side of `setRolePermissions`. The caller
/// holds the role row; the referenced permissions are key-shared (ascending)
/// **before** the existing rows are deleted.
pub async fn replace_role_permissions(
    conn: &mut PgConnection,
    role_id: &str,
    permission_ids: &[String],
) -> Result<()> {
    key_share_permissions_on(conn, permission_ids).await?;
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1")
        .bind(role_id)
        .execute(&mut *conn)
        .await?;
    if !permission_ids.is_empty() {
        sqlx::query(
            "INSERT INTO role_permissions (role_id, permission_id) \
             SELECT $1, id FROM unnest($2::text[]) AS id",
        )
        .bind(role_id)
        .bind(permission_ids)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}
