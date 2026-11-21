//! The one global lock order every multi-row transaction in the workspace
//! follows. See `crates/README.md` ("Global lock order") for the table and the
//! audit.
//!
//! Rank, low to high:
//!
//! 1. `instance` (the settings row; always alone, never combined with domain
//!    rows)
//! 2. `clients`, ascending `id`
//! 3. `users`, then the rows a user owns (`email_addresses`, `phone_numbers`,
//!    `external_accounts`, `trusted_devices`, `passkeys`, `api_keys`),
//!    ascending `id`
//! 4. `sign_ups`
//! 5. `sign_ins`
//! 6. `verifications`
//! 7. `sessions`, ascending `id`
//! 8. `organizations`, ascending `id`
//! 9. `organization_memberships`, `organization_invitations`,
//!    `organization_membership_requests`, ascending `id`; the organization row
//!    is always locked before these children
//! 10. `roles` / `role_permissions` / `permissions` / `user_roles`, ascending
//!     `id`
//! 11. OIDC grant-family advisory locks, ascending family name, then
//!     `oauth_grants` rows
//! 12. `uploads`, ascending `file`
//! 13. signing-key advisory lock, then `signing_keys`
//! 14. instance-level admin rows (`invitations`, `waitlist_entries`,
//!     `enterprise_connections`, `jwt_templates`), one row per transaction
//!
//! Insert-only outbox rows (`webhook_events`, `audit_logs`,
//! `rate_limit_windows`, `oauth_states`, `device_codes`) carry no ordering
//! constraint: they are either written after the row that owns them in the
//! order above, or their statement is the only one in its transaction.
//!
//! Two worker advisory locks (`orbitid_retention`, `orbitid_anonymous_cleanup`)
//! and the first-run `orbitid_owner_setup` lock (owner setup, imports) are
//! taken as the first statement of their own transaction, holding nothing
//! else, so they cannot participate in a cycle; the holder still follows the row ranks after acquiring its lock.
//!
//! A transaction that does not know the user or the client up front must first
//! resolve it with a plain read and then acquire the locks in rank order, e.g.
//! "ban a user" locks every client the user has a session for (ascending `id`),
//! then the user row. A multi-row statement in one table always locks in
//! ascending primary-key order before the update (`SELECT id … ORDER BY id FOR
//! UPDATE`, then `UPDATE … WHERE id = ANY($1)`).
//!
//! **Foreign-key locks count too.** An `INSERT`/`UPDATE` of a foreign-key
//! column takes a `FOR KEY SHARE` lock on every referenced parent row, at the
//! parent's rank. A transaction that will write a child row while it holds (or
//! will later take) another ranked lock must take the parents explicitly first,
//! in rank order, and revalidate after locking. The helpers below do that for
//! users (`key_share_user_on`, `key_share_users_on`), organizations
//! (`lock_organization_on`/`lock_organizations_on`) and the membership write
//! pair (`lock_membership_write_on`, whose returned [`MembershipWriteLock`] is
//! the only proof `add_membership_on`/`assert_organization_capacity_on`
//! accept).

use std::collections::HashSet;

use orbitid_core::error::{error_codes, OrbitError, Result};

/// Locks one client row. Rank 2.
pub async fn lock_client_on(conn: &mut sqlx::PgConnection, client_id: &str) -> Result<()> {
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(client_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// Locks a set of client rows in ascending `id` order (deduplicated). Rank 2.
pub async fn lock_clients_on(conn: &mut sqlx::PgConnection, client_ids: &[String]) -> Result<()> {
    let mut ids: Vec<String> = client_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT id FROM clients WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
    Ok(())
}

/// Locks the clients the user currently has a session for, ascending `id`, and
/// returns them. Rank 2, before the user row.
///
/// Used by moderation and deletion, which affect every session of a user but do
/// not know the client ids up front. A client created concurrently for this
/// user is not in the returned set; its session creation blocks on the user row
/// that the caller locks next, so the caller still sees and ends every session
/// that can make progress.
pub async fn lock_clients_for_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Vec<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT client_id FROM sessions WHERE user_id = $1 ORDER BY client_id",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    lock_clients_on(conn, &ids).await?;
    Ok(ids)
}

/// Locks one user row. Rank 3.
pub async fn lock_user_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// Locks every listed user that still exists `FOR UPDATE`, ascending `id`
/// (deduplicated), and returns the ids it locked. Rank 3.
pub async fn lock_users_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
) -> Result<Vec<String>> {
    let mut ids: Vec<String> = user_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_scalar("SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE")
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?,
    )
}

/// Locks the client row, then the user row. Rank 2 → 3.
pub async fn lock_client_then_user_on(
    conn: &mut sqlx::PgConnection,
    client_id: &str,
    user_id: &str,
) -> Result<()> {
    lock_client_on(conn, client_id).await?;
    lock_user_on(conn, user_id).await?;
    Ok(())
}

/// Locks every client of the user, then the user row. Rank 2 → 3.
pub async fn lock_user_clients_then_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<()> {
    lock_clients_for_user_on(conn, user_id).await?;
    lock_user_on(conn, user_id).await?;
    Ok(())
}

/// Locks one `sign_ups` row `FOR UPDATE`. Rank 4. A missing row is a no-op: the
/// caller's version-CAS write still classifies it as it does today.
///
/// Take it after the client/user locks and **before** the first `verifications`
/// write (rank 6) of the transaction.
pub async fn lock_sign_up_on(conn: &mut sqlx::PgConnection, sign_up_id: &str) -> Result<()> {
    sqlx::query("SELECT id FROM sign_ups WHERE id = $1 FOR UPDATE")
        .bind(sign_up_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// Locks one `sign_ins` row `FOR UPDATE`. Rank 5; same contract as
/// [`lock_sign_up_on`].
pub async fn lock_sign_in_on(conn: &mut sqlx::PgConnection, sign_in_id: &str) -> Result<()> {
    sqlx::query("SELECT id FROM sign_ins WHERE id = $1 FOR UPDATE")
        .bind(sign_in_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// Takes `FOR KEY SHARE` on one user row. Rank 3.
///
/// This is the lock an `INSERT` of a child row (`organization_memberships`,
/// `organization_membership_requests`, `oauth_grants`, …) would take implicitly
/// on its `user_id` parent. Taking it up front lets the transaction hold it in
/// rank order before it locks an organization at rank 8. A missing row is the
/// same not-found error the write path would otherwise produce.
pub async fn key_share_user_on(conn: &mut sqlx::PgConnection, user_id: &str) -> Result<()> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR KEY SHARE")
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    if found.is_none() {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "User not found",
        ));
    }
    Ok(())
}

/// What a credential-issuing transaction needs to re-check **under** the lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserEligibility {
    pub banned: bool,
    pub locked: bool,
}

/// Takes `FOR KEY SHARE` on the user (rank 3) and returns the eligibility flags
/// as they are under that lock, or `None` when the user no longer exists.
///
/// Ban/lock/delete take `FOR UPDATE` on the same row, so once this returns the
/// flags cannot change until the transaction ends: a token, grant or session
/// issued after an unlocked `banned` pre-check must re-check here and refuse,
/// or a ban that commits (and revokes grants) between the pre-check and the
/// insert is bypassed by a fresh credential.
pub async fn key_share_active_user_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Option<UserEligibility>> {
    let row: Option<(bool, bool)> =
        sqlx::query_as("SELECT banned, locked FROM users WHERE id = $1 FOR KEY SHARE")
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    Ok(row.map(|(banned, locked)| UserEligibility { banned, locked }))
}

/// Takes `FOR KEY SHARE` on every user that still exists, in ascending `id`
/// order (rank 3), and returns the ids it locked. A user that no longer exists
/// is **skipped**, not an error: callers that enroll or notify many users (a
/// user deleted between the candidate read and the lock must not fail the
/// whole operation) use the returned set as the proof of who may be written.
/// Use [`key_share_all_users_on`] when a missing user is a not-found error.
pub async fn key_share_users_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
) -> Result<Vec<String>> {
    let mut ids: Vec<String> = user_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_scalar("SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR KEY SHARE")
            .bind(&ids)
            .fetch_all(&mut *conn)
            .await?,
    )
}

/// [`key_share_users_on`] where every user must exist: a missing row is the
/// not-found error the write path would otherwise produce.
pub async fn key_share_all_users_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
) -> Result<()> {
    let mut ids: Vec<String> = user_ids.to_vec();
    ids.sort();
    ids.dedup();
    if key_share_users_on(conn, &ids).await?.len() != ids.len() {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "User not found",
        ));
    }
    Ok(())
}

/// Locks one organization row `FOR UPDATE`. Rank 8.
pub async fn lock_organization_on(
    conn: &mut sqlx::PgConnection,
    organization_id: &str,
) -> Result<()> {
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(organization_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(())
}

/// Locks every organization in ascending `id` order (rank 8) and returns the
/// ids that exist. A caller that needs a missing organization to be an error
/// checks the returned set (or re-reads the row under the lock).
pub async fn lock_organizations_on(
    conn: &mut sqlx::PgConnection,
    organization_ids: &[String],
) -> Result<Vec<String>> {
    let mut ids: Vec<String> = organization_ids.to_vec();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_scalar(
            "SELECT id FROM organizations WHERE id = ANY($1) ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?,
    )
}

/// Proof that a transaction holds the locks a membership write needs: every
/// user in `user_ids` is `FOR KEY SHARE` (rank 3) and every organization in
/// `organization_ids` is `FOR UPDATE` (rank 8), taken in that order.
///
/// Only [`lock_membership_write_on`] constructs one, so membership and capacity
/// writes cannot be reached without the locks.
#[derive(Debug, Clone)]
pub struct MembershipWriteLock {
    users: HashSet<String>,
    organizations: HashSet<String>,
}

impl MembershipWriteLock {
    /// Whether the lock was taken for this user and organization.
    pub fn covers(&self, organization_id: &str, user_id: &str) -> bool {
        self.organizations.contains(organization_id) && self.users.contains(user_id)
    }

    /// Whether the lock was taken for this organization (capacity checks).
    pub fn covers_organization(&self, organization_id: &str) -> bool {
        self.organizations.contains(organization_id)
    }

    /// Whether the lock was taken for this user.
    pub fn covers_user(&self, user_id: &str) -> bool {
        self.users.contains(user_id)
    }
}

/// Takes the user key-share locks (rank 3, ascending) and then the
/// organization `FOR UPDATE` locks (rank 8, ascending) and returns the proof
/// that a membership write needs. Every user must exist.
pub async fn lock_membership_write_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
    organization_ids: &[String],
) -> Result<MembershipWriteLock> {
    key_share_all_users_on(conn, user_ids).await?;
    let organizations = lock_organizations_on(conn, organization_ids).await?;
    Ok(MembershipWriteLock {
        users: user_ids.iter().cloned().collect(),
        organizations: organizations.into_iter().collect(),
    })
}

/// [`lock_membership_write_on`] for bulk enrollment: users that no longer exist
/// are skipped, and the proof covers only the users actually locked (and the
/// organizations that exist). Users first (ascending), then organizations.
pub async fn lock_enrollment_on(
    conn: &mut sqlx::PgConnection,
    candidate_user_ids: &[String],
    organization_ids: &[String],
) -> Result<MembershipWriteLock> {
    let users = key_share_users_on(conn, candidate_user_ids).await?;
    let organizations = lock_organizations_on(conn, organization_ids).await?;
    Ok(MembershipWriteLock {
        users: users.into_iter().collect(),
        organizations: organizations.into_iter().collect(),
    })
}
