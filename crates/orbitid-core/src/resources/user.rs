use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinkedTo {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmailAddressJson {
    pub object: String,
    pub id: String,
    pub email_address: String,
    pub verification: Option<VerificationJson>,
    pub linked_to: Vec<LinkedTo>,
    pub reserved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhoneNumberJson {
    pub object: String,
    pub id: String,
    pub phone_number: String,
    pub reserved_for_second_factor: bool,
    pub default_second_factor: bool,
    pub verification: Option<VerificationJson>,
    pub linked_to: Vec<LinkedTo>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalAccountJson {
    pub object: String,
    pub id: String,
    pub provider: String,
    pub provider_user_id: String,
    pub identification_id: String,
    pub email_address: String,
    pub first_name: String,
    pub last_name: String,
    pub username: Option<String>,
    pub image_url: Option<String>,
    pub avatar_url: Option<String>,
    pub approved_scopes: String,
    pub public_metadata: Metadata,
    pub label: Option<String>,
    pub verification: Option<VerificationJson>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PasskeyJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub verification: Option<VerificationJson>,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserJson {
    pub object: String,
    pub id: String,
    pub external_id: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub image_url: String,
    pub has_image: bool,
    pub primary_email_address_id: Option<String>,
    pub primary_phone_number_id: Option<String>,
    pub password_enabled: bool,
    pub totp_enabled: bool,
    pub backup_code_enabled: bool,
    pub two_factor_enabled: bool,
    pub passkeys: Vec<PasskeyJson>,
    pub email_addresses: Vec<EmailAddressJson>,
    pub phone_numbers: Vec<PhoneNumberJson>,
    pub external_accounts: Vec<ExternalAccountJson>,
    pub public_metadata: Metadata,
    pub unsafe_metadata: Metadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_metadata: Option<Metadata>,
    pub is_anonymous: bool,
    pub banned: bool,
    pub locked: bool,
    pub lockout_expires_in_seconds: Option<i64>,
    pub verification_attempts_remaining: Option<i64>,
    pub delete_self_enabled: bool,
    pub create_organization_enabled: bool,
    pub create_organizations_limit: Option<i64>,
    pub roles: Vec<String>,
    pub role_permissions: Vec<String>,
    pub last_sign_in_at: Option<i64>,
    pub last_active_at: Option<i64>,
    pub legal_accepted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
