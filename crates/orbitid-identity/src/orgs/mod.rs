//! Organizations, memberships, invitations and enrollment, ported from
//! `services/orgs.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow, UserRow};
use orbitid_core::state::AppState;
use serde_json::json;

use crate::rbac::{
    permissions_for_role, role_by_key_on, ADMIN_ROLE_KEY, MEMBER_ROLE_KEY, SYSTEM_PERMISSIONS,
    SYSTEM_ROLES,
};

pub const INVITATION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Role + permissions for a user in an organization, or `None` if not a member.
/// Used when minting session JWTs (`org_id`, `org_role`, `org_permissions`,
/// `org_slug`).
#[derive(Debug, Clone)]
pub struct MembershipContext {
    pub id: String,
    pub org_id: String,
    pub slug: Option<String>,
    pub name: String,
    pub role: String,
    pub permissions: Vec<String>,
}

pub async fn get_membership_context(
    state: &AppState,
    user_id: &str,
    org_id: &str,
) -> Result<Option<MembershipContext>> {
    if !state.settings.get().organizations.enabled {
        return Ok(None);
    }
    let membership = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(membership) = membership else {
        return Ok(None);
    };
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(Some(MembershipContext {
        id: org_id.to_string(),
        org_id: org_id.to_string(),
        slug: org.as_ref().and_then(|org| org.slug.clone()),
        name: org.as_ref().map(|org| org.name.clone()).unwrap_or_default(),
        role: membership.role_key.clone(),
        permissions: permissions_for_role(state, &membership.role_key).await?,
    }))
}

/// Seeds the system roles and permissions. Idempotent and safe when several
/// replicas boot at the same time:
///
/// * one transaction-level advisory lock serialises the whole seed, so two
///   replicas never interleave check-then-insert pairs;
/// * every insert is `ON CONFLICT DO NOTHING`, so a row created by a deploy
///   that does not take the lock (or an older binary) cannot fail the boot.
pub async fn seed_rbac(state: &AppState) -> Result<()> {
    let now_ms = now();
    let mut tx = state.pool.begin().await?;
    // Held until commit; ordering avoids deadlocks with any other seeder.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('orbitid_seed_rbac')::bigint)")
        .execute(&mut *tx)
        .await?;
    for permission in SYSTEM_PERMISSIONS {
        sqlx::query(
            "INSERT INTO permissions (id, key, name, description, type, created_at, updated_at) \
             VALUES ($1,$2,$3,$4,'system',$5,$5) ON CONFLICT (key) DO NOTHING",
        )
        .bind(new_id(id_prefix::PERMISSION))
        .bind(permission.key)
        .bind(permission.name)
        .bind(permission.description)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE permissions SET type = 'system', updated_at = $1 \
             WHERE key = $2 AND type <> 'system'",
        )
        .bind(now_ms)
        .bind(permission.key)
        .execute(&mut *tx)
        .await?;
    }
    for role in SYSTEM_ROLES {
        sqlx::query(
            "INSERT INTO roles (id, key, name, description, is_creator_eligible, is_system, \
             created_at, updated_at) VALUES ($1,$2,$3,$4,$5,true,$6,$6) \
             ON CONFLICT (key) DO NOTHING",
        )
        .bind(new_id(id_prefix::ROLE))
        .bind(role.key)
        .bind(role.name)
        .bind(role.description)
        .bind(role.is_creator_eligible)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        let row = sqlx::query_as::<_, orbitid_core::models::RoleRow>(
            "SELECT * FROM roles WHERE key = $1",
        )
        .bind(role.key)
        .fetch_one(&mut *tx)
        .await?;
        if !row.is_system {
            sqlx::query("UPDATE roles SET is_system = true, updated_at = $1 WHERE id = $2")
                .bind(now_ms)
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
        }
        if role.permissions.is_empty() {
            continue;
        }
        sqlx::query(
            "INSERT INTO role_permissions (role_id, permission_id) \
             SELECT $1, p.id FROM permissions p WHERE p.key = ANY($2) \
             ON CONFLICT DO NOTHING",
        )
        .bind(&row.id)
        .bind(role.permissions)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn creator_role_key(state: &AppState) -> Result<String> {
    let mut conn = state.pool.acquire().await?;
    creator_role_key_on(&mut conn, state).await
}

/// [`creator_role_key`] on a caller-owned connection.
pub async fn creator_role_key_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
) -> Result<String> {
    let key = state.settings.get().organizations.creator_role.clone();
    Ok(if role_by_key_on(conn, &key).await?.is_some() {
        key
    } else {
        ADMIN_ROLE_KEY.to_string()
    })
}

pub async fn default_role_key(state: &AppState) -> Result<String> {
    let mut conn = state.pool.acquire().await?;
    default_role_key_on(&mut conn, state).await
}

/// [`default_role_key`] on a caller-owned connection.
pub async fn default_role_key_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
) -> Result<String> {
    let key = state.settings.get().organizations.default_role.clone();
    Ok(if role_by_key_on(conn, &key).await?.is_some() {
        key
    } else {
        MEMBER_ROLE_KEY.to_string()
    })
}

pub async fn assert_can_create_organization(state: &AppState, user: &UserRow) -> Result<()> {
    let organizations = state.settings.get().organizations.clone();
    if !organizations.enabled {
        return Err(OrbitError::forbidden(
            error_codes::ORGANIZATIONS_DISABLED,
            "Organizations are not enabled for this instance",
        ));
    }
    if user.is_anonymous {
        return Err(OrbitError::forbidden(
            error_codes::ORGANIZATION_CREATION_NOT_ALLOWED,
            "Anonymous accounts cannot create organizations. Add an email address or password first.",
        ));
    }
    if !organizations.creation_enabled || !user.create_organization_enabled {
        return Err(OrbitError::forbidden(
            error_codes::ORGANIZATION_CREATION_NOT_ALLOWED,
            "You are not allowed to create organizations",
        ));
    }
    let limit = user
        .create_organizations_limit
        .or(organizations.max_created_organizations_per_user);
    if let Some(limit) = limit {
        let created: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE created_by = $1")
                .bind(&user.id)
                .fetch_one(&state.pool)
                .await?;
        if created >= limit {
            return Err(OrbitError::forbidden(
                error_codes::ORGANIZATION_CREATION_NOT_ALLOWED,
                format!(
                    "You have reached the maximum of {limit} organization{}",
                    if limit == 1 { "" } else { "s" }
                ),
            )
            .with_meta(json!({ "limit": limit })));
        }
    }
    Ok(())
}

pub async fn assert_organization_capacity(
    state: &AppState,
    org: &OrganizationRow,
    include_pending_invitations: bool,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    let lock =
        crate::locks::lock_membership_write_on(&mut tx, &[], std::slice::from_ref(&org.id)).await?;
    assert_organization_capacity_on(&mut tx, org, include_pending_invitations, &lock).await?;
    tx.commit().await?;
    Ok(())
}

/// Pending invitations of one organization, counted up to `$2` rows (the cap).
const BOUNDED_PENDING_INVITATION_COUNT: &str = "SELECT COUNT(*) FROM \
     (SELECT 1 FROM organization_invitations WHERE organization_id = $1 \
      AND status = 'pending' LIMIT $2) AS bounded";

/// [`assert_organization_capacity`] on a caller-owned connection, so the check
/// runs inside the same transaction as the insert it guards. It takes the
/// [`MembershipWriteLock`] proof, so a caller cannot check capacity without
/// holding the organization row lock.
pub async fn assert_organization_capacity_on(
    conn: &mut sqlx::PgConnection,
    org: &OrganizationRow,
    include_pending_invitations: bool,
    lock: &crate::locks::MembershipWriteLock,
) -> Result<()> {
    if !lock.covers_organization(&org.id) {
        return Err(OrbitError::not_found(
            error_codes::ORGANIZATION_NOT_FOUND,
            "Organization not found",
        ));
    }
    // 0 (the default) means unlimited: nothing to enforce, so no count runs
    // under the organization lock.
    let cap = org.max_allowed_memberships;
    if cap <= 0 {
        return Ok(());
    }
    // Both counts stop at the cap: only "members + pending >= cap" matters, and
    // a count that reaches the cap already decides it.
    let members: i64 = sqlx::query_scalar(enrollment::BOUNDED_MEMBER_COUNT)
        .bind(&org.id)
        .bind(cap)
        .fetch_one(&mut *conn)
        .await?;
    let pending = if include_pending_invitations {
        sqlx::query_scalar::<_, i64>(BOUNDED_PENDING_INVITATION_COUNT)
            .bind(&org.id)
            .bind(cap)
            .fetch_one(&mut *conn)
            .await?
    } else {
        0
    };
    if members + pending >= cap {
        return Err(OrbitError::forbidden(
            error_codes::ORGANIZATION_MEMBERSHIP_QUOTA_EXCEEDED,
            "This organization has reached its maximum number of memberships",
        )
        .with_meta(json!({ "max_allowed_memberships": org.max_allowed_memberships })));
    }
    Ok(())
}

pub mod enrollment;
pub mod enrollment_worker;
pub mod invitations;
pub mod lifecycle;
mod membership;
mod promotion;
pub mod requests;

pub use enrollment::{
    apply_domain_enrollment, apply_domain_enrollment_chunked, domain_enrollment_user_ids_page_on,
    emit_domain_event, emit_domain_event_on, enroll_candidates_counted_on, enroll_candidates_on,
    on_user_email_verified, on_user_email_verified_on, ChunkEnrollment,
};
pub use enrollment_worker::{
    kick_domain_enrollment, run_enrollment_tick, start_enrollment_worker, EnrollmentTick,
    EnrollmentWorker,
};
pub use invitations::{
    accept_invitation, accept_invitation_by_ticket, accept_invitation_on,
    create_organization_invitation, create_organization_invitation_on,
    revoke_organization_invitation_on, CreateInvitationInput,
};
pub use lifecycle::{
    delete_organization, delete_organization_on, leave_organization, leave_organization_on,
    on_user_deleted, on_user_deleted_on, promotion_candidates_on, DeletedOrganization,
    UserOrgEffects,
};
pub(crate) use membership::add_membership_prechecked_on;
pub use membership::{add_membership, add_membership_on};
pub use requests::{
    accept_membership_request_on, create_membership_request_on, reject_membership_request_on,
};
