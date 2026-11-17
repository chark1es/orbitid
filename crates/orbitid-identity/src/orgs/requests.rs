//! Organization membership requests, transaction-safe.
//!
//! Creating, accepting and rejecting a request joins the caller's transaction
//! (`_on` variants), so the request row, the membership it creates, the
//! organization-capacity check and their events commit together.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{
    OrganizationMembershipRequestRow, OrganizationMembershipRow, OrganizationRow,
};
use orbitid_core::state::AppState;

use super::{add_membership_on, default_role_key_on};
use crate::locks;

/// Returns the pending request for `(organization, user)`, creating it when
/// none exists. The user key-share lock (rank 3, taken by the request's
/// `user_id` foreign key) is taken before the organization row (rank 8), so
/// concurrent requests cannot both pass the capacity check and a user deletion
/// cannot form a cycle.
pub async fn create_membership_request_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    org: &OrganizationRow,
    user_id: &str,
    status: &str,
) -> Result<OrganizationMembershipRequestRow> {
    if !["pending", "accepted", "rejected"].contains(&status) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "status must be pending, accepted or rejected",
        )
        .with_meta(serde_json::json!({ "param_name": "status" })));
    }
    locks::key_share_user_on(conn, user_id).await?;
    locks::lock_organization_on(conn, &org.id).await?;
    if let Some(existing) = sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests \
         WHERE organization_id = $1 AND user_id = $2 AND status = 'pending' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&org.id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    {
        return Ok(existing);
    }
    let now_ms = now();
    Ok(sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "INSERT INTO organization_membership_requests (id, organization_id, user_id, status, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *",
    )
    .bind(new_id(id_prefix::REQUEST))
    .bind(&org.id)
    .bind(user_id)
    .bind(status)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}

/// Accepts a pending request: locks the request, checks capacity, inserts the
/// membership (and its event) and flips the status in one transaction.
pub async fn accept_membership_request_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    org: &OrganizationRow,
    request_id: &str,
) -> Result<OrganizationMembershipRow> {
    // Read the request without a lock to learn its user, so the user key-share
    // (rank 3) is taken before the organization (rank 8), and both before the
    // request row (rank 9). The unlocked read is only a hint: the row is
    // re-read under `FOR UPDATE` and its user revalidated below.
    let hint = sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests WHERE id = $1 AND organization_id = $2",
    )
    .bind(request_id)
    .bind(&org.id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership request not found",
        )
    })?;
    let lock = locks::lock_membership_write_on(
        conn,
        std::slice::from_ref(&hint.user_id),
        std::slice::from_ref(&org.id),
    )
    .await?;
    let request = sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests WHERE id = $1 AND organization_id = $2 \
         FOR UPDATE",
    )
    .bind(request_id)
    .bind(&org.id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership request not found",
        )
    })?;
    if request.user_id != hint.user_id {
        return Err(OrbitError::internal(
            "membership request user changed while locking",
        ));
    }
    // The organization was deleted between the reads (its row was not there to
    // lock): the request is gone with it, which is this path's normal 404.
    if !lock.covers(&org.id, &request.user_id) {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Membership request not found",
        ));
    }
    if request.status != "pending" {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Membership request is {}", request.status),
        ));
    }
    let role_key = default_role_key_on(conn, state).await?;
    let membership = add_membership_on(
        conn,
        state,
        &lock,
        &org.id,
        &request.user_id,
        &role_key,
        None,
        None,
    )
    .await?;
    sqlx::query(
        "UPDATE organization_membership_requests SET status = 'accepted', updated_at = $1 \
         WHERE id = $2 AND status = 'pending'",
    )
    .bind(now())
    .bind(&request.id)
    .execute(&mut *conn)
    .await?;
    Ok(membership)
}

/// Rejects a pending request; returns `None` when another transaction already
/// resolved it.
pub async fn reject_membership_request_on(
    conn: &mut sqlx::PgConnection,
    org: &OrganizationRow,
    request_id: &str,
) -> Result<Option<OrganizationMembershipRequestRow>> {
    // Rank 8 → 9: lock the organization before mutating its request rows, the
    // same order organization deletion takes when it cascades into them.
    locks::lock_organization_on(conn, &org.id).await?;
    Ok(sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "UPDATE organization_membership_requests SET status = 'rejected', updated_at = $1 \
         WHERE id = $2 AND organization_id = $3 AND status = 'pending' RETURNING *",
    )
    .bind(now())
    .bind(request_id)
    .bind(&org.id)
    .fetch_optional(&mut *conn)
    .await?)
}
