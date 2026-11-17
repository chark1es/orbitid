//! Identity tables: `instance`, `signing_keys`, `users`, `email_addresses`,
//! `phone_numbers`, `external_accounts`, `passkeys`.

use super::{JsonList, JsonMetadata, Jsonb};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InstanceRow {
    pub id: String,
    pub settings: Jsonb,
    pub secret_key_hash: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Database-assigned settings revision; publication is ordered by this
    /// counter, never by `updated_at` (migration 0007).
    pub revision: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SigningKeyRow {
    pub kid: String,
    pub alg: String,
    pub public_jwk: Jsonb,
    pub private_jwk_enc: String,
    pub active: bool,
    pub created_at: i64,
    pub rotated_at: Option<i64>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub external_id: Option<String>,
    pub username: Option<String>,
    pub username_lower: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub image_url: Option<String>,
    pub has_image: bool,
    pub password_hash: Option<String>,
    pub password_updated_at: Option<i64>,
    pub primary_email_address_id: Option<String>,
    pub primary_phone_number_id: Option<String>,
    pub public_metadata: JsonMetadata,
    pub private_metadata: JsonMetadata,
    pub unsafe_metadata: JsonMetadata,
    pub banned: bool,
    pub locked: bool,
    pub lockout_expires_at: Option<i64>,
    pub failed_attempts: i64,
    pub totp_secret_enc: Option<String>,
    pub totp_verified: bool,
    /// Last accepted TOTP time step (unix seconds / 30), for replay protection.
    pub totp_last_used_step: Option<i64>,
    pub backup_codes: Option<JsonList>,
    pub is_anonymous: bool,
    pub delete_self_enabled: bool,
    pub create_organization_enabled: bool,
    pub create_organizations_limit: Option<i64>,
    pub legal_accepted_at: Option<i64>,
    pub last_sign_in_at: Option<i64>,
    pub last_active_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EmailAddressRow {
    pub id: String,
    pub user_id: Option<String>,
    /// Stored lowercased.
    pub email: String,
    pub verified: bool,
    pub verified_at: Option<i64>,
    pub verified_strategy: Option<String>,
    pub reserved: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PhoneNumberRow {
    pub id: String,
    pub user_id: Option<String>,
    /// E.164.
    pub phone: String,
    pub verified: bool,
    pub verified_at: Option<i64>,
    pub reserved_for_second_factor: bool,
    pub default_second_factor: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ExternalAccountRow {
    pub id: String,
    pub user_id: Option<String>,
    pub provider: String,
    pub provider_user_id: String,
    pub email_address: String,
    pub first_name: String,
    pub last_name: String,
    pub username: Option<String>,
    pub image_url: Option<String>,
    pub approved_scopes: String,
    pub access_token_enc: Option<String>,
    pub refresh_token_enc: Option<String>,
    pub token_expires_at: Option<i64>,
    pub public_metadata: JsonMetadata,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PasskeyRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// base64url
    pub credential_id: String,
    /// base64url COSE key
    pub public_key: String,
    pub counter: i64,
    pub transports: Option<JsonList>,
    pub device_type: Option<String>,
    pub backed_up: bool,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
