//! Who may use an OAuth application (migration 0019).
//!
//! An application with no owning organization (`organization_id IS NULL`) is
//! instance-wide: every user who may sign in may use it, as before. An
//! organization-owned application may be used by the organization's members and
//! by users an operator granted access to that application
//! (`oauth_application_access_grants`). Everyone else is refused wherever a
//! grant or token would be issued (authorize, consent, device approval and poll,
//! code exchange, refresh).
//!
//! The rule lives here (L2) rather than in the OIDC crate because membership
//! removal, which is identity code, must revoke the grants a user loses with it.
//!
//! ## Serialization with the changes that narrow access
//!
//! - **Membership removal and access-grant revocation** hold the user row
//!   `FOR UPDATE` (rank 3). Every issuer key-shares the user first, so it either
//!   finishes before the change (and the change's revocation sees its rows) or
//!   reads the new state under its own lock.
//! - **Changing an application's owner** updates the application row, which
//!   conflicts with the `FOR SHARE` lock [`user_may_use_application_on`] takes.
//!   The owner change therefore waits for in-flight issuers, and its revocation
//!   sees their rows; an issuer that starts later reads the new owner.
//!
//! `oauth_applications` sits between ranks 10 and 11 in `docs/LOCK_ORDER.md`:
//! after the user (3) and organization (8) rows, before grant families (11).

use orbitid_core::error::Result;

/// The SQL predicate "user `$user` may use application row `a`", shared by the
/// check and the revocations so they can never disagree.
const ENTITLED: &str = "(a.organization_id IS NULL \
     OR EXISTS (SELECT 1 FROM organization_memberships m \
                WHERE m.organization_id = a.organization_id AND m.user_id = {user}) \
     OR EXISTS (SELECT 1 FROM oauth_application_access_grants x \
                WHERE x.application_id = a.id AND x.user_id = {user}))";

fn entitled(user: &str) -> String {
    ENTITLED.replace("{user}", user)
}

/// Whether `user_id` may use `application_id`, read under a `FOR SHARE` lock on
/// the application row. Issuers call this **after** their user key-share and
/// before writing a grant, so an owner change committed meanwhile is either
/// waited for or already visible. A missing application is `false`.
pub async fn user_may_use_application_on(
    conn: &mut sqlx::PgConnection,
    application_id: &str,
    user_id: &str,
) -> Result<bool> {
    let allowed: Option<bool> = sqlx::query_scalar(&format!(
        "SELECT {} FROM oauth_applications a WHERE a.id = $1 FOR SHARE OF a",
        entitled("$2")
    ))
    .bind(application_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(allowed.unwrap_or(false))
}

/// [`user_may_use_application_on`] without the lock, for the read-only gates
/// (authorize redirect, consent screen data, userinfo, introspection). An
/// instance-wide application answers without a query.
pub async fn user_may_use_application(
    pool: &sqlx::PgPool,
    application_id: &str,
    organization_id: Option<&str>,
    user_id: &str,
) -> Result<bool> {
    if organization_id.is_none() {
        return Ok(true);
    }
    user_may_use_application_id(pool, application_id, user_id).await
}

/// [`user_may_use_application`] when only the application id is known (the
/// userinfo path resolves a token, not a client).
pub async fn user_may_use_application_id(
    pool: &sqlx::PgPool,
    application_id: &str,
    user_id: &str,
) -> Result<bool> {
    let allowed: Option<bool> = sqlx::query_scalar(&format!(
        "SELECT {} FROM oauth_applications a WHERE a.id = $1",
        entitled("$2")
    ))
    .bind(application_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(allowed.unwrap_or(false))
}

/// Revokes the live OIDC grants (`code`, `access`, `refresh`) that `user_ids`
/// hold for organization-owned applications they are no longer entitled to,
/// optionally only for `application_id`.
///
/// **Precondition:** the caller holds every `user_ids` row `FOR UPDATE` (rank 3)
/// in its transaction, after the membership or access-grant change it commits
/// with. Issuers key-share the user, so none can add a row this statement
/// misses (the same argument as
/// [`crate::grants::revoke_organization_authority_grants_for_users_on`]; no
/// per-family advisory locks are taken).
pub async fn revoke_unentitled_application_grants_on(
    conn: &mut sqlx::PgConnection,
    user_ids: &[String],
    application_id: Option<&str>,
) -> Result<u64> {
    if user_ids.is_empty() {
        return Ok(0);
    }
    let result = sqlx::query(&format!(
        "UPDATE oauth_grants g SET revoked = true \
         FROM oauth_applications a \
         WHERE g.application_id = a.id AND g.user_id = ANY($1) \
           AND g.kind IN ('access', 'refresh', 'code') AND g.revoked = false \
           AND ($2::text IS NULL OR a.id = $2) \
           AND NOT {}",
        entitled("g.user_id")
    ))
    .bind(user_ids)
    .bind(application_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Revokes every live grant of `application_id` held by a user who is not
/// entitled to it under its **current** owner. Called by an owner change in the
/// same transaction, after the application row was updated (so the caller holds
/// it, and every issuer's `FOR SHARE` read waits for the commit).
pub async fn revoke_application_grants_after_owner_change_on(
    conn: &mut sqlx::PgConnection,
    application_id: &str,
) -> Result<u64> {
    let result = sqlx::query(&format!(
        "UPDATE oauth_grants g SET revoked = true \
         FROM oauth_applications a \
         WHERE g.application_id = a.id AND a.id = $1 \
           AND g.kind IN ('access', 'refresh', 'code') AND g.revoked = false \
           AND NOT {}",
        entitled("g.user_id")
    ))
    .bind(application_id)
    .execute(&mut *conn)
    .await?;
    Ok(result.rows_affected())
}

/// Whether `organization_id` owns at least one OAuth application. Organization
/// deletion refuses (and user deletion keeps an emptied organization) while it
/// does; call with the organization row locked so no assignment can race it.
pub async fn organization_owns_applications_on(
    conn: &mut sqlx::PgConnection,
    organization_id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM oauth_applications WHERE organization_id = $1)",
    )
    .bind(organization_id)
    .fetch_one(&mut *conn)
    .await?)
}
