use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub slug: String,
    pub image_url: String,
    pub has_image: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_invitations_count: Option<i64>,
    pub max_allowed_memberships: i64,
    pub admin_delete_enabled: bool,
    pub public_metadata: Metadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_metadata: Option<Metadata>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Backend API only: the operator-configured billing portal (`null` when
    /// none). The Frontend API omits it; members with `org:sys_billing:manage`
    /// read it from `GET /v1/client/organizations/{id}/billing`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing_portal_url: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationMembershipJson {
    pub object: String,
    pub id: String,
    pub role: String,
    pub role_name: String,
    pub permissions: Vec<String>,
    pub public_metadata: Metadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_metadata: Option<Metadata>,
    pub organization: OrganizationJson,
    pub public_user_data: PublicUserData,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InvitationStatus {
    Pending,
    Accepted,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationInvitationJson {
    pub object: String,
    pub id: String,
    pub email_address: String,
    pub organization_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_image_url: Option<String>,
    pub role: String,
    pub role_name: String,
    pub status: InvitationStatus,
    pub public_metadata: Metadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_metadata: Option<Metadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnrollmentMode {
    ManualInvitation,
    AutomaticInvitation,
    AutomaticSuggestion,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationDomainJson {
    pub object: String,
    pub id: String,
    pub organization_id: String,
    pub name: String,
    pub enrollment_mode: EnrollmentMode,
    pub verification: Option<VerificationJson>,
    pub affiliation_email_address: Option<String>,
    pub total_pending_invitations: i64,
    pub total_pending_suggestions: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MembershipRequestStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationMembershipRequestJson {
    pub object: String,
    pub id: String,
    pub organization_id: String,
    pub status: MembershipRequestStatus,
    pub public_user_data: PublicUserData,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationSuggestionJson {
    pub object: String,
    pub id: String,
    pub public_organization_data: SuggestionOrganization,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SuggestionOrganization {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub image_url: String,
    pub has_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PermissionJson {
    pub object: String,
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub permission_type: String,
    pub scope: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoleJson {
    pub object: String,
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub is_system: bool,
    pub is_creator_eligible: bool,
    pub permissions: Vec<PermissionJson>,
    pub created_at: i64,
    pub updated_at: i64,
}

// ---------- backend-only resources ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InvitationJson {
    pub object: String,
    pub id: String,
    pub email_address: String,
    pub status: InvitationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub public_metadata: Metadata,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: Option<i64>,
}
