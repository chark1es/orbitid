//! API tables: `api_keys`, `machines`, `m2m_tokens`, `oauth_applications`,
//! `oauth_grants`, `oauth_consents`, `enterprise_connections`, `audit_logs`.

use super::{JsonList, JsonMetadata, Jsonb};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApiKeyRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `user_xxx` or `org_xxx`.
    pub subject: String,
    /// First characters shown in the UI, e.g. `ak_live_AbCd`.
    pub prefix: String,
    pub secret_hash: String,
    pub scopes: JsonList,
    pub claims: Option<JsonMetadata>,
    pub revoked: bool,
    pub revocation_reason: Option<String>,
    pub expires_at: Option<i64>,
    pub last_used_at: Option<i64>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MachineRow {
    pub id: String,
    pub name: String,
    pub secret_hash: String,
    pub scoped_machines: JsonList,
    pub default_token_ttl: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct M2mTokenRow {
    pub id: String,
    pub machine_id: String,
    pub token_hash: String,
    pub claims: Option<JsonMetadata>,
    pub revoked: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OauthApplicationRow {
    pub id: String,
    pub name: String,
    pub client_id: String,
    pub client_secret_hash: Option<String>,
    pub is_public: bool,
    pub redirect_uris: JsonList,
    pub post_logout_redirect_uris: JsonList,
    pub scopes: String,
    pub consent_screen_enabled: bool,
    pub pkce_required: bool,
    pub access_token_lifetime_seconds: i64,
    pub refresh_token_lifetime_seconds: i64,
    pub id_token_lifetime_seconds: i64,
    pub groups_claim: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OauthGrantRow {
    pub id: String,
    /// `code` | `access` | `refresh`
    pub kind: String,
    pub application_id: String,
    pub user_id: String,
    pub token_hash: String,
    pub scopes: String,
    pub redirect_uri: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub nonce: Option<String>,
    pub family_id: Option<String>,
    pub session_id: Option<String>,
    pub consumed_at: Option<i64>,
    pub successor_id: Option<String>,
    pub successor_token_enc: Option<String>,
    pub revoked: bool,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OauthConsentRow {
    pub application_id: String,
    pub user_id: String,
    pub scopes: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnterpriseConnectionRow {
    pub id: String,
    pub name: String,
    /// `saml` | `oidc`
    pub protocol: String,
    pub provider: String,
    pub domains: JsonList,
    pub active: bool,
    pub allow_subdomains: bool,
    pub allow_idp_initiated: bool,
    pub sync_user_attributes: bool,
    pub disable_additional_identifications: bool,
    pub config: Jsonb,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuditLogRow {
    pub id: String,
    pub actor: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub metadata: JsonMetadata,
    pub ip: Option<String>,
    pub created_at: i64,
}
