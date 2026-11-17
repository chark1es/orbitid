//! Membership writes: the idempotent insert, its capacity check and the event.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;

use crate::serializers::serialize_membership_on;

use super::assert_organization_capacity_on;

/// Inserts a membership (idempotent) in a transaction and emits
/// `organizationMembership.created` in that same transaction only when this call
/// created the row.
pub async fn add_membership(
    state: &AppState,
    organization_id: &str,
    user_id: &str,
    role_key: &str,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
) -> Result<OrganizationMembershipRow> {
    let mut tx = state.pool.begin().await?;
    let lock = crate::locks::lock_membership_write_on(
        &mut tx,
        &[user_id.to_string()],
        &[organization_id.to_string()],
    )
    .await?;
    let membership = add_membership_on(
        &mut tx,
        state,
        &lock,
        organization_id,
        user_id,
        role_key,
        public_metadata,
        private_metadata,
    )
    .await?;
    tx.commit().await?;
    Ok(membership)
}

/// [`add_membership`] on a caller-owned transaction. Use this when the
/// membership must commit with another write (organization creation,
/// invitation acceptance).
///
/// The [`MembershipWriteLock`] proof is required: the caller must have taken
/// the user key-share (rank 3) and organization `FOR UPDATE` (rank 8) locks in
/// that order via [`crate::locks::lock_membership_write_on`] first. That also
/// serialises the capacity check with the insert.
#[allow(clippy::too_many_arguments)]
pub async fn add_membership_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    lock: &crate::locks::MembershipWriteLock,
    organization_id: &str,
    user_id: &str,
    role_key: &str,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
) -> Result<OrganizationMembershipRow> {
    Ok(add_membership_checked_on(
        conn,
        state,
        lock,
        organization_id,
        user_id,
        role_key,
        public_metadata,
        private_metadata,
        true,
    )
    .await?
    .0)
}

/// [`add_membership_on`] for bulk enrollment: the caller counted the
/// organization's free capacity once for the whole chunk (under the same
/// organization lock) and so skips the per-row `COUNT(*)`. Returns whether the
/// row was created by this call.
pub(crate) async fn add_membership_prechecked_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    lock: &crate::locks::MembershipWriteLock,
    organization_id: &str,
    user_id: &str,
    role_key: &str,
) -> Result<bool> {
    Ok(add_membership_checked_on(
        conn,
        state,
        lock,
        organization_id,
        user_id,
        role_key,
        None,
        None,
        false,
    )
    .await?
    .1)
}

#[allow(clippy::too_many_arguments)]
async fn add_membership_checked_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    lock: &crate::locks::MembershipWriteLock,
    organization_id: &str,
    user_id: &str,
    role_key: &str,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    check_capacity: bool,
) -> Result<(OrganizationMembershipRow, bool)> {
    let (membership, created) = insert_membership_on(
        conn,
        state,
        lock,
        organization_id,
        user_id,
        role_key,
        public_metadata,
        private_metadata,
        check_capacity,
    )
    .await?;
    if created {
        let json =
            serde_json::to_value(serialize_membership_on(conn, state, &membership, true).await?)
                .unwrap_or_default();
        orbitid_platform::webhooks::emit_event_on(conn, "organizationMembership.created", json)
            .await?;
    }
    Ok((membership, created))
}

#[allow(clippy::too_many_arguments)]
async fn insert_membership_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    lock: &crate::locks::MembershipWriteLock,
    organization_id: &str,
    user_id: &str,
    role_key: &str,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    check_capacity: bool,
) -> Result<(OrganizationMembershipRow, bool)> {
    if !lock.covers_user(user_id) {
        return Err(OrbitError::internal(
            "membership insert requires the user key-share lock",
        ));
    }
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(organization_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
    // The organization exists (read above); the proof must cover this exact
    // user *and* organization pair.
    if !lock.covers(organization_id, user_id) {
        return Err(OrbitError::internal(
            "membership insert requires the user key-share and organization locks",
        ));
    }
    let existing = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(existing) = existing {
        return Ok((existing, false));
    }
    if check_capacity {
        assert_organization_capacity_on(conn, &org, false, lock).await?;
    }
    let now_ms = now();
    let row = sqlx::query_as::<_, OrganizationMembershipRow>(
        "INSERT INTO organization_memberships (id, organization_id, user_id, role_key, \
         public_metadata, private_metadata, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) \
         ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING *",
    )
    .bind(new_id(id_prefix::MEMBERSHIP))
    .bind(organization_id)
    .bind(user_id)
    .bind(role_key)
    .bind(sqlx::types::Json(public_metadata.unwrap_or_default()))
    .bind(sqlx::types::Json(private_metadata.unwrap_or_default()))
    .bind(now_ms)
    .fetch_optional(&mut *conn)
    .await
    .map_err(OrbitError::from_row_write)?;
    match row {
        Some(row) => Ok((row, true)),
        None => Ok((
            sqlx::query_as::<_, OrganizationMembershipRow>(
                "SELECT * FROM organization_memberships \
                 WHERE organization_id = $1 AND user_id = $2",
            )
            .bind(organization_id)
            .bind(user_id)
            .fetch_one(&mut *conn)
            .await?,
            false,
        )),
    }
}
