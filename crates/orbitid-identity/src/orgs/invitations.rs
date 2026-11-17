//! Organization invitations: ticket acceptance and creation.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{OrganizationInvitationRow, OrganizationMembershipRow, OrganizationRow};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use super::INVITATION_TTL_MS;
use crate::org_domains::normalize_email;
use crate::org_serializers::serialize_organization_invitation_on;
use crate::rbac::assert_organization_role_on;

/// Accepts an invitation when a sign-up completes with an org invitation ticket.
pub async fn accept_invitation_by_ticket(
    state: &AppState,
    ticket: &str,
    user_id: &str,
) -> Result<()> {
    let hash = orbitid_core::crypto::sha256(ticket);
    let invitation = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE token_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    let Some(invitation) = invitation else {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "Organization invitation ticket is invalid",
        ));
    };
    if invitation.status == "accepted" {
        return Ok(());
    }
    if invitation.status != "pending" {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "Organization invitation is no longer valid",
        ));
    }
    if invitation.expires_at.map(|expires| expires <= now()) == Some(true) {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_EXPIRED,
            "Organization invitation has expired",
        ));
    }
    accept_invitation(state, &invitation, user_id).await?;
    Ok(())
}

/// Accepts a pending invitation. The invitation row is locked for the whole
/// transaction, membership insertion and the conditional status flip commit
/// together, and both event rows are written on the same connection: a revoked
/// invitation can never leave a membership behind, and a crash can never leave
/// an accepted invitation without its event.
pub async fn accept_invitation(
    state: &AppState,
    invitation: &OrganizationInvitationRow,
    user_id: &str,
) -> Result<Option<OrganizationMembershipRow>> {
    let mut tx = state.pool.begin().await?;
    let membership = accept_invitation_on(&mut tx, state, invitation, user_id).await?;
    tx.commit().await?;
    Ok(membership)
}

/// [`accept_invitation`] on a caller-owned transaction, for verified-email
/// enrollment and sign-up completion where several invitations must commit
/// together.
pub async fn accept_invitation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    invitation: &OrganizationInvitationRow,
    user_id: &str,
) -> Result<Option<OrganizationMembershipRow>> {
    let now_ms = now();
    // Rank 3 → 8 → 9: the membership's user key-share, then the organization
    // row, then the invitation it owns. Organization deletion locks the
    // organization first and then cascades into invitations, and user deletion
    // holds the user before it looks at organizations.
    let lock = crate::locks::lock_membership_write_on(
        conn,
        &[user_id.to_string()],
        std::slice::from_ref(&invitation.organization_id),
    )
    .await?;
    let current = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE id = $1 FOR UPDATE",
    )
    .bind(&invitation.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(current) = current else {
        return Ok(None);
    };
    if current.status == "accepted" {
        return Ok(sqlx::query_as::<_, OrganizationMembershipRow>(
            "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
        )
        .bind(&current.organization_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?);
    }
    if current.status != "pending"
        || current.expires_at.map(|expires| expires <= now_ms) == Some(true)
    {
        return Ok(None);
    }
    let membership = super::add_membership_on(
        conn,
        state,
        &lock,
        &current.organization_id,
        user_id,
        &current.role_key,
        Some(current.public_metadata.0.clone()),
        None,
    )
    .await?;
    let accepted = sqlx::query_as::<_, OrganizationInvitationRow>(
        "UPDATE organization_invitations SET status = 'accepted', updated_at = $1 \
         WHERE id = $2 AND status = 'pending' \
         AND (expires_at IS NULL OR expires_at > $1) RETURNING *",
    )
    .bind(now_ms)
    .bind(&current.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(accepted) = accepted else {
        return Ok(None);
    };
    let json = serde_json::to_value(
        serialize_organization_invitation_on(conn, &accepted, true, None).await?,
    )
    .unwrap_or_default();
    emit_event_on(conn, "organizationInvitation.accepted", json).await?;
    Ok(Some(membership))
}

/// Input for [`create_organization_invitation`].
#[derive(Debug, Clone)]
pub struct CreateInvitationInput {
    pub email: String,
    pub role_key: Option<String>,
    pub inviter_user_id: Option<String>,
    pub redirect_url: Option<String>,
    pub public_metadata: Option<Metadata>,
    pub private_metadata: Option<Metadata>,
    pub expires_at: Option<i64>,
}

/// Creates a pending invitation. Returns the plaintext ticket, available only
/// once (the database stores its sha256).
pub async fn create_organization_invitation(
    state: &AppState,
    org: &OrganizationRow,
    input: &CreateInvitationInput,
) -> Result<(OrganizationInvitationRow, String)> {
    let mut tx = state.pool.begin().await?;
    let created = create_organization_invitation_on(&mut tx, state, org, input).await?;
    tx.commit().await?;
    Ok(created)
}

/// [`create_organization_invitation`] on a caller-owned transaction. The
/// duplicate/capacity checks and the insert share that transaction, so two
/// concurrent creates cannot both pass the pending check.
pub async fn create_organization_invitation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    org: &OrganizationRow,
    input: &CreateInvitationInput,
) -> Result<(OrganizationInvitationRow, String)> {
    let email = normalize_email(&input.email)?;
    let role_key = match &input.role_key {
        Some(key) => key.clone(),
        None => super::default_role_key_on(conn, state).await?,
    };
    assert_organization_role_on(conn, &role_key, "role").await?;
    // Lock the organization row so the capacity check and the insert see the
    // same membership/invitation counts. Rank 8; there is no user parent yet.
    let lock =
        crate::locks::lock_membership_write_on(conn, &[], std::slice::from_ref(&org.id)).await?;
    // Re-read under the lock, so the capacity check uses the current limit.
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(&org.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
    let member: Option<String> = sqlx::query_scalar(
        "SELECT m.id FROM organization_memberships m \
         JOIN users u ON u.id = m.user_id \
         JOIN email_addresses e ON e.user_id = u.id \
         WHERE m.organization_id = $1 AND e.email = $2 LIMIT 1",
    )
    .bind(&org.id)
    .bind(&email)
    .fetch_optional(&mut *conn)
    .await?;
    if member.is_some() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("{email} is already a member of this organization"),
        ));
    }
    let pending: Option<String> = sqlx::query_scalar(
        "SELECT id FROM organization_invitations \
         WHERE organization_id = $1 AND email = $2 AND status = 'pending' LIMIT 1",
    )
    .bind(&org.id)
    .bind(&email)
    .fetch_optional(&mut *conn)
    .await?;
    if pending.is_some() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("{email} has already been invited to this organization"),
        ));
    }
    super::assert_organization_capacity_on(conn, &org, true, &lock).await?;

    let now_ms = now();
    let id = new_id(id_prefix::INVITATION);
    let ticket = orbitid_core::crypto::random_token(32);
    sqlx::query(
        "INSERT INTO organization_invitations (id, organization_id, email, role_key, status, \
         token_hash, inviter_user_id, redirect_url, public_metadata, private_metadata, \
         expires_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$11)",
    )
    .bind(&id)
    .bind(&org.id)
    .bind(&email)
    .bind(&role_key)
    .bind(orbitid_core::crypto::sha256(&ticket))
    .bind(&input.inviter_user_id)
    .bind(&input.redirect_url)
    .bind(sqlx::types::Json(
        input.public_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        input.private_metadata.clone().unwrap_or_default(),
    ))
    .bind(input.expires_at.unwrap_or(now_ms + INVITATION_TTL_MS))
    .bind(now_ms)
    .execute(&mut *conn)
    .await?;
    let row = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&mut *conn)
    .await?;
    let json =
        serde_json::to_value(serialize_organization_invitation_on(conn, &row, true, None).await?)
            .unwrap_or_default();
    emit_event_on(conn, "organizationInvitation.created", json).await?;
    Ok((row, ticket))
}

/// Marks a pending invitation revoked and writes its event on the same
/// connection. Idempotent: an already-revoked or accepted row is returned
/// unchanged without a second event.
pub async fn revoke_organization_invitation_on(
    conn: &mut sqlx::PgConnection,
    invitation: &OrganizationInvitationRow,
) -> Result<OrganizationInvitationRow> {
    // Rank 8 → 9: lock the organization before mutating its invitation rows,
    // matching the order organization deletion takes when it cascades.
    crate::locks::lock_organization_on(conn, &invitation.organization_id).await?;
    let revoked = sqlx::query_as::<_, OrganizationInvitationRow>(
        "UPDATE organization_invitations SET status = 'revoked', updated_at = $1 \
         WHERE id = $2 AND status = 'pending' RETURNING *",
    )
    .bind(now())
    .bind(&invitation.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = revoked else {
        // The row can have vanished (its organization was deleted meanwhile):
        // that is this path's 404, not an internal error.
        return sqlx::query_as::<_, OrganizationInvitationRow>(
            "SELECT * FROM organization_invitations WHERE id = $1",
        )
        .bind(&invitation.id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Organization invitation not found",
            )
        });
    };
    let json =
        serde_json::to_value(serialize_organization_invitation_on(conn, &row, true, None).await?)
            .unwrap_or_default();
    emit_event_on(conn, "organizationInvitation.revoked", json).await?;
    Ok(row)
}
