//! Organization, membership and public-user serializers.

use std::collections::HashMap;

use orbitid_core::error::Result;
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow, UserRow};
use orbitid_core::resources::{OrganizationJson, OrganizationMembershipJson, PublicUserData};
use orbitid_core::state::AppState;
use orbitid_platform::default_avatar;

use super::user::{
    load_relations_for_users, load_user_relations_on, public_user_data_for, UserRelations,
};
use crate::rbac::{
    permissions_for_role, permissions_for_role_ids_on, permissions_for_role_keys, role_by_key,
    role_by_key_on,
};

fn organization_json(
    org: &OrganizationRow,
    backend: bool,
    counts: Option<(i64, i64)>,
) -> OrganizationJson {
    let name = org.name.clone();
    OrganizationJson {
        object: "organization".into(),
        id: org.id.clone(),
        name: name.clone(),
        slug: org.slug.clone().unwrap_or_default(),
        image_url: org
            .image_url
            .clone()
            .unwrap_or_else(|| default_avatar(&name)),
        has_image: org.has_image,
        members_count: counts.map(|(members, _)| members),
        pending_invitations_count: counts.map(|(_, pending)| pending),
        max_allowed_memberships: org.max_allowed_memberships,
        admin_delete_enabled: org.admin_delete_enabled,
        public_metadata: org.public_metadata.0.clone(),
        private_metadata: backend.then(|| org.private_metadata.0.clone()),
        created_by: org.created_by.clone(),
        created_at: org.created_at,
        updated_at: org.updated_at,
    }
}

async fn organization_counts(state: &AppState, org_id: &str) -> Result<(i64, i64)> {
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&state.pool)
    .await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE organization_id = $1 AND status = 'pending'",
    )
    .bind(org_id)
    .fetch_one(&state.pool)
    .await?;
    Ok((members, pending))
}

async fn organization_counts_on(conn: &mut sqlx::PgConnection, org_id: &str) -> Result<(i64, i64)> {
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(org_id)
    .fetch_one(&mut *conn)
    .await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE organization_id = $1 AND status = 'pending'",
    )
    .bind(org_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok((members, pending))
}

/// Serializes an organization on a caller-owned connection (webhook payloads
/// written inside a transaction).
pub async fn serialize_organization_on(
    conn: &mut sqlx::PgConnection,
    org: &OrganizationRow,
    backend: bool,
    counts: bool,
) -> Result<OrganizationJson> {
    let counts = if counts {
        Some(organization_counts_on(conn, &org.id).await?)
    } else {
        None
    };
    Ok(organization_json(org, backend, counts))
}

/// Serializes an organization. `counts: false` omits members/pending counts
/// (used by nested suggestion payloads where the TS does too).
pub async fn serialize_organization(
    state: &AppState,
    org: &OrganizationRow,
    backend: bool,
    counts: bool,
) -> Result<OrganizationJson> {
    let counts = if counts {
        Some(organization_counts(state, &org.id).await?)
    } else {
        None
    };
    Ok(organization_json(org, backend, counts))
}

/// Batch serializer: one grouped query per count.
pub async fn serialize_organizations(
    state: &AppState,
    orgs: &[OrganizationRow],
    backend: bool,
    counts: bool,
) -> Result<Vec<OrganizationJson>> {
    let mut member_counts: HashMap<String, i64> = HashMap::new();
    let mut pending_counts: HashMap<String, i64> = HashMap::new();
    if counts && !orgs.is_empty() {
        let ids: Vec<String> = orgs.iter().map(|org| org.id.clone()).collect();
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT organization_id, COUNT(*) FROM organization_memberships \
             WHERE organization_id = ANY($1) GROUP BY organization_id",
        )
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;
        member_counts.extend(rows);
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT organization_id, COUNT(*) FROM organization_invitations \
             WHERE organization_id = ANY($1) AND status = 'pending' GROUP BY organization_id",
        )
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;
        pending_counts.extend(rows);
    }
    Ok(orgs
        .iter()
        .map(|org| {
            let counts = counts.then(|| {
                (
                    *member_counts.get(&org.id).unwrap_or(&0),
                    *pending_counts.get(&org.id).unwrap_or(&0),
                )
            });
            organization_json(org, backend, counts)
        })
        .collect())
}

/// Public user data (`public_user_data` on memberships, invitations, requests).
pub async fn public_user_data(state: &AppState, user: &UserRow) -> Result<PublicUserData> {
    let relations = super::user::load_user_relations(state, user).await?;
    Ok(public_user_data_for(user, &relations))
}

#[allow(clippy::too_many_arguments)]
fn membership_json(
    row: &OrganizationMembershipRow,
    org: &OrganizationRow,
    user: &UserRow,
    role_name: &str,
    permissions: Vec<String>,
    relations: &UserRelations,
    counts: Option<(i64, i64)>,
    backend: bool,
) -> OrganizationMembershipJson {
    OrganizationMembershipJson {
        object: "organization_membership".into(),
        id: row.id.clone(),
        role: row.role_key.clone(),
        role_name: role_name.to_string(),
        permissions,
        public_metadata: row.public_metadata.0.clone(),
        private_metadata: backend.then(|| row.private_metadata.0.clone()),
        organization: organization_json(org, backend, counts),
        public_user_data: public_user_data_for(user, relations),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Serializes one membership (organization, user, role and permissions).
pub async fn serialize_membership(
    state: &AppState,
    row: &OrganizationMembershipRow,
    backend: bool,
) -> Result<OrganizationMembershipJson> {
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(&row.organization_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            orbitid_core::OrbitError::not_found(
                orbitid_core::error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            orbitid_core::OrbitError::not_found(
                orbitid_core::error_codes::RESOURCE_NOT_FOUND,
                "User not found",
            )
        })?;
    let role_name = role_by_key(state, &row.role_key)
        .await?
        .map(|role| role.name)
        .unwrap_or_else(|| row.role_key.clone());
    let permissions = permissions_for_role(state, &row.role_key).await?;
    let relations = super::user::load_user_relations(state, &user).await?;
    let counts = Some(organization_counts(state, &org.id).await?);
    Ok(membership_json(
        row,
        &org,
        &user,
        &role_name,
        permissions,
        &relations,
        counts,
        backend,
    ))
}

/// [`serialize_membership`] on a caller-owned connection, for events written in
/// the same transaction as the membership insert.
pub async fn serialize_membership_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    row: &OrganizationMembershipRow,
    backend: bool,
) -> Result<OrganizationMembershipJson> {
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(&row.organization_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            orbitid_core::OrbitError::not_found(
                orbitid_core::error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            orbitid_core::OrbitError::not_found(
                orbitid_core::error_codes::RESOURCE_NOT_FOUND,
                "User not found",
            )
        })?;
    let role = role_by_key_on(conn, &row.role_key).await?;
    let role_name = role
        .as_ref()
        .map(|role| role.name.clone())
        .unwrap_or_else(|| row.role_key.clone());
    let permissions = match &role {
        Some(role) => {
            let ids = vec![role.id.clone()];
            permissions_for_role_ids_on(conn, &ids)
                .await?
                .remove(&role.id)
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    let relations = load_user_relations_on(conn, &user).await?;
    let counts = Some(organization_counts_on(conn, &org.id).await?);
    Ok(membership_json(
        row,
        &org,
        &user,
        &role_name,
        permissions,
        &relations,
        counts,
        backend,
    ))
}

/// Batch serializer for membership lists: organizations, users, roles and
/// counts are loaded with a bounded number of queries.
pub async fn serialize_memberships(
    state: &AppState,
    rows: &[OrganizationMembershipRow],
    backend: bool,
) -> Result<Vec<OrganizationMembershipJson>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let org_ids: Vec<String> = {
        let mut ids: Vec<String> = rows.iter().map(|row| row.organization_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let user_ids: Vec<String> = {
        let mut ids: Vec<String> = rows.iter().map(|row| row.user_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let role_keys: Vec<String> = {
        let mut keys: Vec<String> = rows.iter().map(|row| row.role_key.clone()).collect();
        keys.sort();
        keys.dedup();
        keys
    };
    let orgs: Vec<OrganizationRow> =
        sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = ANY($1)")
            .bind(&org_ids)
            .fetch_all(&state.pool)
            .await?;
    let orgs: HashMap<String, OrganizationRow> =
        orgs.into_iter().map(|org| (org.id.clone(), org)).collect();
    let users: Vec<UserRow> =
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = ANY($1)")
            .bind(&user_ids)
            .fetch_all(&state.pool)
            .await?;
    let users: HashMap<String, UserRow> = users
        .into_iter()
        .map(|user| (user.id.clone(), user))
        .collect();
    let mut relations = load_relations_for_users(state, &user_ids).await?;
    let roles: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT key, name FROM roles WHERE key = ANY($1)")
            .bind(&role_keys)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .collect();
    let permissions = permissions_for_role_keys(state, &role_keys).await?;
    let member_counts: HashMap<String, i64> = sqlx::query_as(
        "SELECT organization_id, COUNT(*) FROM organization_memberships \
         WHERE organization_id = ANY($1) GROUP BY organization_id",
    )
    .bind(&org_ids)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();
    let pending_counts: HashMap<String, i64> = sqlx::query_as(
        "SELECT organization_id, COUNT(*) FROM organization_invitations \
         WHERE organization_id = ANY($1) AND status = 'pending' GROUP BY organization_id",
    )
    .bind(&org_ids)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .collect();

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let (Some(org), Some(user)) = (orgs.get(&row.organization_id), users.get(&row.user_id))
        else {
            continue;
        };
        let relations_for_user = relations.remove(&row.user_id).unwrap_or(UserRelations {
            emails: Vec::new(),
            phones: Vec::new(),
            externals: Vec::new(),
            passkeys: Vec::new(),
        });
        let counts = Some((
            *member_counts.get(&org.id).unwrap_or(&0),
            *pending_counts.get(&org.id).unwrap_or(&0),
        ));
        let role_name = roles
            .get(&row.role_key)
            .cloned()
            .unwrap_or_else(|| row.role_key.clone());
        out.push(membership_json(
            row,
            org,
            user,
            &role_name,
            permissions.get(&row.role_key).cloned().unwrap_or_default(),
            &relations_for_user,
            counts,
            backend,
        ));
    }
    Ok(out)
}
