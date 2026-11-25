//! Organization lifecycle side effects (user deletion, organization deletion,
//! leaving an organization).

use crate::grants::revoke_organization_authority_grants_on;
use crate::rbac::permissions_for_role_keys_on;
use crate::serializers::{serialize_membership_on, serialize_organization_on};
use std::collections::HashSet;

use crate::grants::revoke_organization_authority_grants_for_users_on;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow};
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use super::creator_role_key_on;
pub use super::promotion::{promotion_candidates_on, UserOrgEffects};
use crate::uploads::delete_logo_for_org_on;

/// Removes memberships/invitations/requests of a deleted user; promotes or
/// deletes organizations left without admins.
///
/// Everything runs on one connection: a partial failure cannot leave the user's
/// memberships removed while the organizations they administered still exist
/// (or vice versa). The avatar and every logo of an organization deleted here
/// are removed in the same transaction, so a deletion never leaves a publicly
/// served upload row behind.
pub async fn on_user_deleted(state: &AppState, user_id: &str) -> Result<()> {
    // A candidate that changed between the plain pre-read and the locks is a
    // retryable conflict (see `on_user_deleted_on`).
    orbitid_core::db::with_retry("on_user_deleted", |_| async {
        let mut tx = state.pool.begin().await?;
        let outcome = async {
            let mut ids = promotion_candidates_on(&mut tx, user_id).await?;
            ids.push(user_id.to_string());
            let locked = crate::locks::lock_users_on(&mut tx, &ids).await?;
            let effects = on_user_deleted_on(&mut tx, state, user_id, &locked).await?;
            for promoted in &effects.promoted_user_ids {
                revoke_organization_authority_grants_on(&mut tx, promoted).await?;
            }
            for (org_id, image_url) in effects.deleted_org_logos {
                delete_logo_for_org_on(&mut tx, &org_id, image_url.as_deref()).await?;
            }
            Ok(())
        }
        .await;
        orbitid_core::db::finish_transaction(tx, outcome).await
    })
    .await
}

/// [`on_user_deleted`] on a caller-owned transaction. Returns the effects the
/// caller finishes once it has taken every lower-ranked lock (the logo rows of
/// deleted organizations, rank 12, and the grant revocation of promoted
/// members, rank 11), so `delete_user_on` keeps the transaction in rank order.
///
/// `locked_users` are the users the caller already holds `FOR UPDATE`: the
/// deleted user and the [`promotion_candidates_on`] it pre-read, locked in
/// ascending id **before** any organization. A promotion of anybody else (the
/// candidate changed since the pre-read) is a retryable `transaction_conflict`.
pub async fn on_user_deleted_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    locked_users: &[String],
) -> Result<UserOrgEffects> {
    // Never touch `uploads` (rank 12) before organizations (rank 8): a user
    // deletion and an organization deletion can share an upload row, and the
    // lower rank must always be locked first. The avatar rows are removed at
    // the end of the caller's transaction instead.
    let user_exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&mut *conn)
        .await?;
    let memberships = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE user_id = $1 ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut affected: HashSet<String> = memberships
        .iter()
        .map(|membership| membership.organization_id.clone())
        .collect();
    let created = sqlx::query_as::<_, OrganizationRow>(
        "SELECT * FROM organizations WHERE created_by = $1 ORDER BY id",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    for org in created {
        affected.insert(org.id);
    }
    // Requests are a rank-9 child of the organization (rank 8), so their
    // organizations must be part of the lock set before any request row is
    // deleted. Deleting them first would invert the order against an
    // accept/revoke that locks the organization and then the request.
    let request_orgs: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT organization_id FROM organization_membership_requests \
         WHERE user_id = $1 ORDER BY organization_id",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    for org_id in request_orgs {
        affected.insert(org_id);
    }

    // A stable order: two user deletions that share organizations must not
    // lock the same organization rows in opposite orders. Organizations (rank
    // 8) are locked in ascending id before any membership/request (rank 9) is
    // read, deleted or promoted; an organization deletion does the same.
    let mut org_ids: Vec<String> = affected.into_iter().collect();
    org_ids.sort();
    if !org_ids.is_empty() {
        sqlx::query("SELECT id FROM organizations WHERE id = ANY($1) ORDER BY id FOR UPDATE")
            .bind(&org_ids)
            .fetch_all(&mut *conn)
            .await?;
    }
    sqlx::query("DELETE FROM organization_membership_requests WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    // Uploads (rank 12) are removed only after every organization (rank 8) has
    // been processed, so the loop never goes back to a lower rank.
    let mut deleted_org_logos: Vec<(String, Option<String>)> = Vec::new();
    let mut promoted_user_ids: Vec<String> = Vec::new();
    for org_id in org_ids {
        let Some(org) =
            sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
                .bind(&org_id)
                .fetch_optional(&mut *conn)
                .await?
        else {
            continue;
        };
        let rows = sqlx::query_as::<_, OrganizationMembershipRow>(
            "SELECT * FROM organization_memberships WHERE organization_id = $1 \
             ORDER BY id FOR UPDATE",
        )
        .bind(&org_id)
        .fetch_all(&mut *conn)
        .await?;
        let mut remaining: Vec<OrganizationMembershipRow> = Vec::with_capacity(rows.len());
        for membership in rows {
            if membership.user_id != user_id {
                remaining.push(membership);
                continue;
            }
            let payload = if user_exists {
                serialize_membership_on(conn, state, &membership, true)
                    .await
                    .ok()
                    .and_then(|json| serde_json::to_value(json).ok())
            } else {
                None
            };
            sqlx::query("DELETE FROM organization_memberships WHERE id = $1")
                .bind(&membership.id)
                .execute(&mut *conn)
                .await?;
            if let Some(payload) = payload {
                emit_event_on(conn, "organizationMembership.deleted", payload).await?;
            }
        }
        if remaining.is_empty() {
            // An organization that owns OAuth applications outlives its last
            // member: deleting it would have to delete or widen those
            // applications (the foreign key refuses either). The row is locked
            // above, so no application can be assigned to it meanwhile.
            if crate::app_access::organization_owns_applications_on(conn, &org_id).await? {
                continue;
            }
            let payload = serialize_organization_on(conn, &org, true, true).await?;
            sqlx::query("DELETE FROM organizations WHERE id = $1")
                .bind(&org_id)
                .execute(&mut *conn)
                .await?;
            emit_event_on(
                conn,
                "organization.deleted",
                serde_json::to_value(payload).unwrap_or_default(),
            )
            .await?;
            deleted_org_logos.push((org_id.clone(), org.image_url.clone()));
            continue;
        }
        let role_keys: Vec<String> = {
            let mut keys: Vec<String> = remaining.iter().map(|row| row.role_key.clone()).collect();
            keys.sort();
            keys.dedup();
            keys
        };
        let permissions = permissions_for_role_keys_on(conn, &role_keys).await?;
        let has_admin = remaining.iter().any(|membership| {
            permissions
                .get(&membership.role_key)
                .map(|keys| {
                    keys.iter()
                        .any(|key| key == crate::rbac::MEMBERSHIPS_MANAGE)
                })
                .unwrap_or(false)
        });
        if has_admin {
            continue;
        }
        let mut sorted = remaining.clone();
        sorted.sort_by_key(|membership| membership.created_at);
        let Some(promote) = sorted.first() else {
            continue;
        };
        if !locked_users.contains(&promote.user_id) {
            return Err(OrbitError::conflict(
                error_codes::TRANSACTION_CONFLICT,
                "The organization's members changed; retry the request",
            ));
        }
        promoted_user_ids.push(promote.user_id.clone());
        let role_key = creator_role_key_on(conn, state).await?;
        sqlx::query(
            "UPDATE organization_memberships SET role_key = $1, updated_at = $2 WHERE id = $3",
        )
        .bind(&role_key)
        .bind(now())
        .bind(&promote.id)
        .execute(&mut *conn)
        .await?;
        let updated = sqlx::query_as::<_, OrganizationMembershipRow>(
            "SELECT * FROM organization_memberships WHERE id = $1",
        )
        .bind(&promote.id)
        .fetch_one(&mut *conn)
        .await?;
        let payload =
            serde_json::to_value(serialize_membership_on(conn, state, &updated, true).await?)
                .unwrap_or_default();
        emit_event_on(conn, "organizationMembership.updated", payload).await?;
    }
    // Rank-12 upload rows are returned to the caller; `delete_user_on` still
    // has rank-10/11 work to do before it may touch uploads.
    Ok(UserOrgEffects {
        deleted_org_logos,
        promoted_user_ids,
    })
}

/// A deleted organization plus the members whose OIDC grants were revoked in
/// the same transaction.
#[derive(Debug, Clone)]
pub struct DeletedOrganization {
    pub organization: OrganizationRow,
    pub member_ids: Vec<String>,
}

/// Deletes an organization, revokes the organization-authority OIDC grants of
/// every member and writes its event, all in the caller's transaction.
pub async fn delete_organization_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    org_id: &str,
) -> Result<Option<DeletedOrganization>> {
    // Rank 3 before 8: every member's grants are revoked below, and that must
    // serialize with token issuance (which key-shares the user). The members
    // are read plainly, locked ascending, and re-read under the organization
    // lock; a member who joined in between is a retryable conflict.
    let candidates: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 ORDER BY user_id",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let locked_users = crate::locks::lock_users_on(conn, &candidates).await?;
    let Some(org) = sqlx::query_as::<_, OrganizationRow>(
        "SELECT * FROM organizations WHERE id = $1 FOR UPDATE",
    )
    .bind(org_id)
    .fetch_optional(&mut *conn)
    .await?
    else {
        return Ok(None);
    };
    // Owned OAuth applications must be reassigned or deleted first. Assigning
    // an application key-shares the organization row, so with the row held
    // `FOR UPDATE` this answer cannot go stale before the delete.
    if crate::app_access::organization_owns_applications_on(conn, org_id).await? {
        return Err(OrbitError::conflict(
            error_codes::ORGANIZATION_HAS_APPLICATIONS,
            "This organization owns OAuth applications. Reassign or delete them before deleting the organization.",
        ));
    }
    let payload = serde_json::to_value(serialize_organization_on(conn, &org, true, true).await?)
        .unwrap_or_default();
    let member_ids: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 ORDER BY user_id",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let locked_users: HashSet<&String> = locked_users.iter().collect();
    if member_ids
        .iter()
        .any(|member| !locked_users.contains(member))
    {
        return Err(OrbitError::conflict(
            error_codes::TRANSACTION_CONFLICT,
            "The organization's members changed; retry the request",
        ));
    }
    // Rank 8 → 9: lock the memberships in ascending id before the cascade
    // would delete them implicitly. Then rank 11 (grant families) and rank 12
    // (uploads). Deleting the organization first would take the membership
    // locks during the cascade, after the advisory locks, and deadlocked
    // against a concurrent membership change.
    let membership_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM organization_memberships WHERE organization_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    // Lock the other rank-9 children before the rank-11 grant advisory locks:
    // the cascade below would otherwise lock them after the advisory lock.
    sqlx::query(
        "SELECT id FROM organization_invitations WHERE organization_id = $1 \
                 ORDER BY id FOR UPDATE",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query(
        "SELECT id FROM organization_membership_requests WHERE organization_id = $1 \
                 ORDER BY id FOR UPDATE",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    if !membership_ids.is_empty() {
        sqlx::query("DELETE FROM organization_memberships WHERE id = ANY($1)")
            .bind(&membership_ids)
            .execute(&mut *conn)
            .await?;
    }
    // The members lose the authority this organization asserted in their
    // tokens, so revocation commits with the deletion; a failed revoke rolls
    // the deletion back.
    revoke_organization_authority_grants_for_users_on(conn, &member_ids).await?;
    sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(org_id)
        .execute(&mut *conn)
        .await?;
    // The pointer and every upload row the organization owns leave with it. A
    // failure here rolls the deletion back, so a deleted logo can never remain
    // publicly served.
    delete_logo_for_org_on(conn, org_id, org.image_url.as_deref()).await?;
    emit_event_on(conn, "organization.deleted", payload).await?;
    Ok(Some(DeletedOrganization {
        organization: org,
        member_ids,
    }))
}

/// [`delete_organization_on`] in its own transaction. The grant revocation and
/// the logo deletion are part of that transaction.
pub async fn delete_organization(
    state: &AppState,
    org_id: &str,
) -> Result<Option<DeletedOrganization>> {
    // A member who joined between the plain member read and the organization
    // lock is a retryable conflict (see `delete_organization_on`).
    orbitid_core::db::with_retry("delete_organization", |_| async {
        let mut tx = state.pool.begin().await?;
        let outcome = delete_organization_on(&mut tx, state, org_id).await;
        orbitid_core::db::finish_transaction(tx, outcome).await
    })
    .await
}

/// Removes one membership, refusing to remove the last admin. All memberships
/// of the organization are locked in a stable order first, so two concurrent
/// removals cannot both pass the last-admin check.
pub async fn leave_organization_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    org_id: &str,
    user_id: &str,
) -> Result<OrganizationMembershipRow> {
    // Rank 3 first: the revocation below must serialize with token issuance,
    // which key-shares this user. Then rank 8 before the rank-9 membership
    // rows. Deleting a membership writes no foreign-key column.
    crate::locks::lock_user_on(conn, user_id).await?;
    crate::locks::lock_organization_on(conn, org_id).await?;
    let rows = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 \
         ORDER BY id FOR UPDATE",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let Some(membership) = rows.into_iter().find(|row| row.user_id == user_id) else {
        return Err(OrbitError::not_found(
            error_codes::NOT_A_MEMBER_IN_ORGANIZATION,
            "You are not a member of this organization",
        ));
    };
    if crate::rbac::is_last_admin_on(conn, &membership).await? {
        return Err(OrbitError::forbidden(
            error_codes::LAST_ADMIN_CANNOT_LEAVE,
            "You are the last admin of this organization and cannot leave it",
        )
        .with_meta(serde_json::json!({ "role": membership.role_key })));
    }
    let payload =
        serde_json::to_value(serialize_membership_on(conn, state, &membership, true).await?)
            .unwrap_or_default();
    sqlx::query("DELETE FROM organization_memberships WHERE id = $1")
        .bind(&membership.id)
        .execute(&mut *conn)
        .await?;
    // The member's organization-authority grants must die with the membership.
    revoke_organization_authority_grants_on(conn, user_id).await?;
    emit_event_on(conn, "organizationMembership.deleted", payload).await?;
    Ok(membership)
}

/// [`leave_organization_on`] in its own transaction. The grant revocation is
/// part of that transaction; nothing security-relevant runs after commit.
pub async fn leave_organization(
    state: &AppState,
    org_id: &str,
    user_id: &str,
) -> Result<OrganizationMembershipRow> {
    let mut tx = state.pool.begin().await?;
    let membership = leave_organization_on(&mut tx, state, org_id, user_id).await?;
    tx.commit().await?;
    Ok(membership)
}
