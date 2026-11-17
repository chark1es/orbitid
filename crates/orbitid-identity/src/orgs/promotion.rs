//! Last-admin promotion on user deletion: which remaining members may be
//! promoted, so they can be locked (rank 3) with the deleted user **before**
//! any organization lock, and the effects the caller finishes afterwards.

use orbitid_core::error::Result;

/// What [`super::lifecycle::on_user_deleted_on`] leaves for its caller.
#[derive(Debug, Default)]
pub struct UserOrgEffects {
    /// `(organization id, logo url)` of the organizations it deleted
    /// (rank-12 `uploads` rows, removed by the caller last).
    pub deleted_org_logos: Vec<(String, Option<String>)>,
    /// Members it promoted. A promotion changes organization authority, so the
    /// caller revokes their authority grants (rank 11) once it is past rank 10.
    pub promoted_user_ids: Vec<String>,
}

/// The members that deleting `user_id` would promote: one per organization the
/// user belongs to or created that is left without an admin, the earliest
/// joined remaining member. A plain (unlocked) read; the deletion re-checks the
/// choice under the locks and a different candidate is a retryable conflict.
pub async fn promotion_candidates_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT ON (m.organization_id) m.user_id \
         FROM organization_memberships m \
         WHERE m.user_id <> $1 \
           AND (m.organization_id IN (SELECT organization_id FROM organization_memberships \
                                      WHERE user_id = $1) \
                OR m.organization_id IN (SELECT id FROM organizations WHERE created_by = $1)) \
           AND NOT EXISTS (SELECT 1 FROM organization_memberships a \
                JOIN roles r ON r.key = a.role_key \
                JOIN role_permissions rp ON rp.role_id = r.id \
                JOIN permissions p ON p.id = rp.permission_id \
                WHERE a.organization_id = m.organization_id AND a.user_id <> $1 \
                  AND p.key = $2) \
         ORDER BY m.organization_id, m.created_at, m.id",
    )
    .bind(user_id)
    .bind(crate::rbac::MEMBERSHIPS_MANAGE)
    .fetch_all(&mut *conn)
    .await?)
}
