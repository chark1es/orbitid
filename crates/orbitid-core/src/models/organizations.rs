//! Organization and instance access-control tables.

use super::JsonMetadata;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrganizationRow {
    pub id: String,
    pub name: String,
    pub slug: Option<String>,
    pub image_url: Option<String>,
    pub has_image: bool,
    pub max_allowed_memberships: i64,
    pub admin_delete_enabled: bool,
    pub public_metadata: JsonMetadata,
    pub private_metadata: JsonMetadata,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RoleRow {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub is_creator_eligible: bool,
    pub is_system: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PermissionRow {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    /// `system` | `user`
    #[sqlx(rename = "type")]
    pub permission_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RolePermissionRow {
    pub role_id: String,
    pub permission_id: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRoleRow {
    pub user_id: String,
    pub role_key: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrganizationMembershipRow {
    pub id: String,
    pub organization_id: String,
    pub user_id: String,
    pub role_key: String,
    pub public_metadata: JsonMetadata,
    pub private_metadata: JsonMetadata,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrganizationInvitationRow {
    pub id: String,
    pub organization_id: String,
    pub email: String,
    pub role_key: String,
    pub status: String,
    pub token_hash: String,
    pub inviter_user_id: Option<String>,
    pub redirect_url: Option<String>,
    pub public_metadata: JsonMetadata,
    pub private_metadata: JsonMetadata,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The API-visible columns of `organization_domains`. The table also has
/// `enrollment_pending_since` and `enrollment_cursor` (migration 0011), the
/// enrollment worker's private marker; they are deliberately not fields here
/// (`SELECT *` ignores extra columns) and are only read or written by
/// `orbitid_identity::orgs::enrollment_worker` with explicit column lists, so
/// they can never leak into an HTTP response or a webhook payload.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrganizationDomainRow {
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub enrollment_mode: String,
    pub verified: bool,
    pub affiliation_email_address: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OrganizationMembershipRequestRow {
    pub id: String,
    pub organization_id: String,
    pub user_id: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InvitationRow {
    pub id: String,
    pub email: String,
    pub status: String,
    pub token_hash: String,
    pub redirect_url: Option<String>,
    pub public_metadata: JsonMetadata,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WaitlistEntryRow {
    pub id: String,
    pub email: String,
    pub status: String,
    pub invitation_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AllowlistIdentifierRow {
    pub id: String,
    pub identifier: String,
    pub identifier_type: String,
    pub invitation_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BlocklistIdentifierRow {
    pub id: String,
    pub identifier: String,
    pub identifier_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}
