use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitlistStatus {
    Pending,
    Invited,
    Completed,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitlistEntryJson {
    pub object: String,
    pub id: String,
    pub email_address: String,
    pub status: WaitlistStatus,
    pub invitation: Option<InvitationJson>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AllowlistIdentifierJson {
    pub object: String,
    pub id: String,
    pub identifier: String,
    pub identifier_type: String,
    pub invitation_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlocklistIdentifierJson {
    pub object: String,
    pub id: String,
    pub identifier: String,
    pub identifier_type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JwtTemplateJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub claims: Metadata,
    pub lifetime: i64,
    pub allowed_clock_skew: i64,
    pub custom_signing_key: bool,
    pub signing_algorithm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_key: Option<Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct SignInTokenJson {
    pub object: String,
    pub id: String,
    pub user_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for SignInTokenJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInTokenJson")
            .field("object", &self.object)
            .field("id", &self.id)
            .field("user_id", &self.user_id)
            .field("status", &self.status)
            .field("token", &"<redacted>")
            .field("url", &self.url)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserRolesJson {
    pub object: String,
    pub user_id: String,
    pub roles: Vec<String>,
    pub role_permissions: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookEndpointJson {
    pub object: String,
    pub id: String,
    pub url: String,
    pub description: String,
    pub event_types: Vec<String>,
    pub disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for WebhookEndpointJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookEndpointJson")
            .field("object", &self.object)
            .field("id", &self.id)
            .field("url", &self.url)
            .field("description", &self.description)
            .field("event_types", &self.event_types)
            .field("disabled", &self.disabled)
            .field("secret", &"<redacted>")
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WebhookDeliveryJson {
    pub object: String,
    pub id: String,
    pub endpoint_id: String,
    pub event_id: String,
    pub event_type: String,
    pub status: String,
    pub attempt: i64,
    pub response_code: Option<i64>,
    pub response_body: Option<String>,
    pub next_attempt_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct ApiKeyJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub subject: String,
    pub prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub scopes: Vec<String>,
    pub claims: Option<Metadata>,
    pub revoked: bool,
    pub expiration: Option<i64>,
    pub last_used_at: Option<i64>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl std::fmt::Debug for ApiKeyJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiKeyJson")
            .field("object", &self.object)
            .field("id", &self.id)
            .field("name", &self.name)
            .field("description", &self.description)
            .field("subject", &self.subject)
            .field("prefix", &self.prefix)
            .field("secret", &"<redacted>")
            .field("scopes", &self.scopes)
            .field("claims", &self.claims)
            .field("revoked", &self.revoked)
            .field("expiration", &self.expiration)
            .field("last_used_at", &self.last_used_at)
            .field("created_by", &self.created_by)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct M2mMachineJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub scoped_machines: Vec<String>,
    pub default_token_ttl: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct M2mTokenJson {
    pub object: String,
    pub id: String,
    pub machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub claims: Option<Metadata>,
    pub revoked: bool,
    pub expired: bool,
    pub expiration: Option<i64>,
    pub created_at: i64,
}

impl std::fmt::Debug for M2mTokenJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("M2mTokenJson")
            .field("object", &self.object)
            .field("id", &self.id)
            .field("machine_id", &self.machine_id)
            .field("token", &"<redacted>")
            .field("claims", &self.claims)
            .field("revoked", &self.revoked)
            .field("expired", &self.expired)
            .field("expiration", &self.expiration)
            .field("created_at", &self.created_at)
            .finish()
    }
}

pub const DEFAULT_OAUTH_APPLICATION_SCOPES: &str = "openid profile email";
pub const DEFAULT_OAUTH_GROUPS_CLAIM: &str = "none";
pub const DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS: i64 = 300;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct OauthApplicationJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub public: bool,
    pub redirect_uris: Vec<String>,
    pub post_logout_redirect_uris: Vec<String>,
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

impl std::fmt::Debug for OauthApplicationJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OauthApplicationJson")
            .field("object", &self.object)
            .field("id", &self.id)
            .field("name", &self.name)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("public", &self.public)
            .field("redirect_uris", &self.redirect_uris)
            .field("post_logout_redirect_uris", &self.post_logout_redirect_uris)
            .field("scopes", &self.scopes)
            .field("consent_screen_enabled", &self.consent_screen_enabled)
            .field("pkce_required", &self.pkce_required)
            .field(
                "access_token_lifetime_seconds",
                &self.access_token_lifetime_seconds,
            )
            .field(
                "refresh_token_lifetime_seconds",
                &self.refresh_token_lifetime_seconds,
            )
            .field("id_token_lifetime_seconds", &self.id_token_lifetime_seconds)
            .field("groups_claim", &self.groups_claim)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamlConnectionJson {
    pub idp_entity_id: String,
    pub idp_sso_url: String,
    pub idp_certificate: String,
    pub acs_url: String,
    pub sp_entity_id: String,
    pub sp_metadata_url: String,
    pub attribute_mapping: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OidcConnectionJson {
    pub client_id: String,
    pub discovery_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_info_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnterpriseConnectionJson {
    pub object: String,
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub provider: String,
    pub domains: Vec<String>,
    pub active: bool,
    pub allow_subdomains: bool,
    pub allow_idp_initiated: bool,
    pub sync_user_attributes: bool,
    pub disable_additional_identifications: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saml: Option<SamlConnectionJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oidc: Option<OidcConnectionJson>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditLogJson {
    pub object: String,
    pub id: String,
    pub actor: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub metadata: Metadata,
    pub ip: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrustedDeviceJson {
    pub object: String,
    pub id: String,
    pub user_id: String,
    pub label: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub expires_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaginatedList<T> {
    pub data: Vec<T>,
    pub total_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeletedObjectJson {
    pub object: String,
    pub id: String,
    pub deleted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_fields_are_omitted_and_required_nulls_kept() {
        let verification = VerificationJson {
            status: VerificationStatus::Verified,
            strategy: "email_code".into(),
            attempts: None,
            expire_at: None,
            external_verification_redirect_url: None,
            error: None,
            nonce: None,
        };
        let value = serde_json::to_value(verification).unwrap();
        assert!(value["attempts"].is_null());
        assert!(value["expire_at"].is_null());
        // TS `verificationJSON` always emits `error` and `nonce`, as null when absent.
        assert!(value["nonce"].is_null());
        assert!(value["error"].is_null());
        // `external_verification_redirect_url` is genuinely optional.
        assert!(value.get("external_verification_redirect_url").is_none());
    }

    #[test]
    fn session_status_is_snake_case() {
        let value = serde_json::to_value(SessionStatus::Abandoned).unwrap();
        assert_eq!(value, "abandoned");
        let value = serde_json::to_value(AuthMethod::EmailCode).unwrap();
        assert_eq!(value, "email_code");
    }

    #[test]
    fn deleted_object_shape() {
        let value = serde_json::to_value(DeletedObjectJson {
            object: "user".into(),
            id: "user_1".into(),
            deleted: true,
        })
        .unwrap();
        assert_eq!(value["deleted"], true);
    }
}
