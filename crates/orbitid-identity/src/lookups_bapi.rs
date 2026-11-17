//! Transaction-scoped lookups and advisory locks the Backend API crates need so
//! that a check and the write it guards run on the same connection.
//!
//! These live in their own module (instead of the pool-based helpers in
//! `org_domains`, `orgs` and `rbac`) because the Backend API composes several
//! domain operations into one transaction and must not acquire a second pool
//! connection while it is open.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{
    AllowlistIdentifierRow, BlocklistIdentifierRow, EnterpriseConnectionRow, InvitationRow,
    OrganizationDomainRow, OrganizationInvitationRow, OrganizationMembershipRequestRow,
    OrganizationMembershipRow, PermissionRow, RoleRow,
};

/// One domain of an organization.
pub async fn find_domain_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    id: &str,
) -> Result<Option<OrganizationDomainRow>> {
    Ok(sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// One domain of an organization by its normalized name.
pub async fn find_domain_by_name_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    name: &str,
) -> Result<Option<OrganizationDomainRow>> {
    Ok(sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE organization_id = $1 AND name = $2",
    )
    .bind(org_id)
    .bind(name.to_lowercase())
    .fetch_optional(&mut *conn)
    .await?)
}

/// One membership of a user in an organization.
pub async fn find_membership_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    user_id: &str,
) -> Result<Option<OrganizationMembershipRow>> {
    Ok(sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// One organization invitation, scoped to its organization.
pub async fn find_org_invitation_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    id: &str,
) -> Result<Option<OrganizationInvitationRow>> {
    Ok(sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// One membership request, scoped to its organization.
pub async fn find_org_request_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    id: &str,
) -> Result<Option<OrganizationMembershipRequestRow>> {
    Ok(sqlx::query_as::<_, OrganizationMembershipRequestRow>(
        "SELECT * FROM organization_membership_requests WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Resolves a role by id or key.
pub async fn resolve_role_on(
    conn: &mut sqlx::PgConnection,
    id_or_key: &str,
) -> Result<Option<RoleRow>> {
    let by_id = sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE id = $1")
        .bind(id_or_key)
        .fetch_optional(&mut *conn)
        .await?;
    if by_id.is_some() {
        return Ok(by_id);
    }
    Ok(
        sqlx::query_as::<_, RoleRow>("SELECT * FROM roles WHERE key = $1")
            .bind(id_or_key)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

/// Resolves a permission by id or key.
pub async fn resolve_permission_on(
    conn: &mut sqlx::PgConnection,
    id_or_key: &str,
) -> Result<Option<PermissionRow>> {
    let by_id = sqlx::query_as::<_, PermissionRow>("SELECT * FROM permissions WHERE id = $1")
        .bind(id_or_key)
        .fetch_optional(&mut *conn)
        .await?;
    if by_id.is_some() {
        return Ok(by_id);
    }
    Ok(
        sqlx::query_as::<_, PermissionRow>("SELECT * FROM permissions WHERE key = $1")
            .bind(id_or_key)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

/// Pending, unexpired instance invitation for `email` (`None` when the newest
/// pending row has expired).
pub async fn pending_invitation_on(
    conn: &mut sqlx::PgConnection,
    email: &str,
) -> Result<Option<InvitationRow>> {
    let normalized = crate::org_domains::normalize_email(email)?;
    let rows = sqlx::query_as::<_, InvitationRow>(
        "SELECT * FROM invitations WHERE email = $1 AND status = 'pending'",
    )
    .bind(normalized)
    .fetch_all(&mut *conn)
    .await?;
    let now_ms = orbitid_core::http::now();
    Ok(rows
        .into_iter()
        .find(|row| row.expires_at.map(|at| at > now_ms).unwrap_or(true)))
}

/// Serializes every instance invitation write. The instance invitation table
/// has no unique `(email, status)` constraint, so the pending check and the
/// insert need an explicit lock to stay correct across replicas.
pub async fn lock_instance_invitations_on(conn: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::query(
        "SELECT pg_advisory_xact_lock(hashtextextended('orbitid_instance_invitations', 0))",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Serializes the "is this enterprise domain already claimed?" check with the
/// insert/update it guards. `enterprise_connections.domains` is a JSON array, so
/// there is no unique constraint to fall back on.
pub async fn lock_enterprise_domains_on(conn: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('orbitid_enterprise_domains', 0))")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Every enterprise connection (used while holding
/// [`lock_enterprise_domains_on`]).
pub async fn enterprise_connections_on(
    conn: &mut sqlx::PgConnection,
) -> Result<Vec<EnterpriseConnectionRow>> {
    Ok(sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections ORDER BY created_at",
    )
    .fetch_all(&mut *conn)
    .await?)
}

/// Serializes JWT-template name checks with the insert/rename they guard.
pub async fn lock_jwt_template_name_on(conn: &mut sqlx::PgConnection, name: &str) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("orbitid_jwt_template:{name}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Loads one organization by id or slug or raises the Backend API's 404 body.
pub async fn require_organization_on(
    conn: &mut sqlx::PgConnection,
    id_or_slug: &str,
) -> Result<orbitid_core::models::OrganizationRow> {
    let by_id = sqlx::query_as::<_, orbitid_core::models::OrganizationRow>(
        "SELECT * FROM organizations WHERE id = $1",
    )
    .bind(id_or_slug)
    .fetch_optional(&mut *conn)
    .await?;
    let row = match by_id {
        Some(row) => Some(row),
        None => {
            sqlx::query_as::<_, orbitid_core::models::OrganizationRow>(
                "SELECT * FROM organizations WHERE slug = $1",
            )
            .bind(id_or_slug)
            .fetch_optional(&mut *conn)
            .await?
        }
    };
    row.ok_or_else(|| {
        OrbitError::not_found(
            error_codes::ORGANIZATION_NOT_FOUND,
            "Organization not found",
        )
    })
}

/// A user row inside the caller's transaction (`None` when absent).
pub async fn find_user_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<orbitid_core::models::UserRow>> {
    crate::users::get_user_by_id_on(conn, id).await
}

/// Whether a role grants organization-admin authority, on the caller's
/// connection (the pool-based [`crate::rbac::is_admin_role`] would open a second
/// connection inside a transaction).
pub async fn is_admin_role_on(conn: &mut sqlx::PgConnection, role_key: &str) -> Result<bool> {
    let permissions = crate::rbac::permissions_for_role_keys_on(
        conn,
        std::slice::from_ref(&role_key.to_string()),
    )
    .await?;
    Ok(permissions
        .get(role_key)
        .map(|keys| {
            keys.iter()
                .any(|key| key == crate::rbac::MEMBERSHIPS_MANAGE)
        })
        .unwrap_or(false))
}

/// Creates an allowlist entry with an explicit `identifier_type` (the Backend
/// API classifies web3 wallets as well as e-mail/phone).
pub async fn create_allowlist_identifier_typed_on(
    conn: &mut sqlx::PgConnection,
    identifier: &str,
    identifier_type: &str,
    invitation_id: Option<&str>,
) -> Result<AllowlistIdentifierRow> {
    let now_ms = orbitid_core::http::now();
    Ok(sqlx::query_as::<_, AllowlistIdentifierRow>(
        "INSERT INTO allowlist_identifiers (id, identifier, identifier_type, invitation_id, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::ALLOW,
    ))
    .bind(identifier)
    .bind(identifier_type)
    .bind(invitation_id)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}

/// Creates a blocklist entry with an explicit `identifier_type`.
pub async fn create_blocklist_identifier_typed_on(
    conn: &mut sqlx::PgConnection,
    identifier: &str,
    identifier_type: &str,
) -> Result<BlocklistIdentifierRow> {
    let now_ms = orbitid_core::http::now();
    Ok(sqlx::query_as::<_, BlocklistIdentifierRow>(
        "INSERT INTO blocklist_identifiers (id, identifier, identifier_type, created_at, \
         updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING *",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::BLOCK,
    ))
    .bind(identifier)
    .bind(identifier_type)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}
