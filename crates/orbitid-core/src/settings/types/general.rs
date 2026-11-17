use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ApplicationSettings {
    pub name: String,
    pub logo_url: Option<String>,
    pub home_url: String,
    pub support_email: Option<String>,
    pub terms_url: Option<String>,
    pub privacy_url: Option<String>,
    pub allowed_origins: Vec<String>,
    pub allowed_redirect_origins: Vec<String>,
    pub development_mode: bool,
}

impl Default for ApplicationSettings {
    fn default() -> Self {
        Self {
            name: "OrbitID App".into(),
            logo_url: None,
            home_url: "http://localhost:3000".into(),
            support_email: None,
            terms_url: None,
            privacy_url: None,
            allowed_origins: vec![
                "http://localhost:3000".into(),
                "http://localhost:5173".into(),
            ],
            allowed_redirect_origins: Vec::new(),
            development_mode: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PasswordSettings {
    pub min_length: i64,
    pub max_length: i64,
    pub require_lowercase: bool,
    pub require_uppercase: bool,
    pub require_numbers: bool,
    pub require_special_character: bool,
    pub reject_pwned: bool,
    pub sign_out_of_other_sessions_on_change: bool,
    pub sign_out_of_other_sessions_on_reset: bool,
}

impl Default for PasswordSettings {
    fn default() -> Self {
        Self {
            min_length: 8,
            max_length: 72,
            require_lowercase: false,
            require_uppercase: false,
            require_numbers: false,
            require_special_character: false,
            reject_pwned: false,
            sign_out_of_other_sessions_on_change: false,
            sign_out_of_other_sessions_on_reset: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UsernameSettings {
    pub min_length: i64,
    pub max_length: i64,
}

impl Default for UsernameSettings {
    fn default() -> Self {
        Self {
            min_length: 4,
            max_length: 64,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SignUpSettings {
    pub mode: SignUpMode,
    pub legal_consent_required: bool,
    pub progressive: bool,
}

impl Default for SignUpSettings {
    fn default() -> Self {
        Self {
            mode: SignUpMode::Public,
            legal_consent_required: false,
            progressive: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RestrictionsSettings {
    pub allowlist_enabled: bool,
    pub blocklist_enabled: bool,
    pub block_email_subaddresses: bool,
    pub block_disposable_email_domains: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaimMapping {
    pub sub: String,
    pub email: String,
    pub email_verified: String,
    pub name: String,
    pub first_name: String,
    pub last_name: String,
    pub username: String,
    pub picture: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SocialProviderConfig {
    pub enabled: bool,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<SocialProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub userinfo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jwks_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_auth_method: Option<ClientAuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkce: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust_email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_mapping: Option<ClaimMapping>,
    pub authenticatable_at_sign_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apple_team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apple_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apple_private_key: Option<String>,
}

impl std::fmt::Debug for SocialProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SocialProviderConfig")
            .field("enabled", &self.enabled)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("scopes", &self.scopes)
            .field("discovery_url", &self.discovery_url)
            .field("name", &self.name)
            .field("protocol", &self.protocol)
            .field("authorization_url", &self.authorization_url)
            .field("token_url", &self.token_url)
            .field("userinfo_url", &self.userinfo_url)
            .field("jwks_url", &self.jwks_url)
            .field("issuer", &self.issuer)
            .field("client_auth_method", &self.client_auth_method)
            .field("pkce", &self.pkce)
            .field("trust_email_verified", &self.trust_email_verified)
            .field("logo_url", &self.logo_url)
            .field("claim_mapping", &self.claim_mapping)
            .field(
                "authenticatable_at_sign_in",
                &self.authenticatable_at_sign_in,
            )
            .field("apple_team_id", &self.apple_team_id)
            .field("apple_key_id", &self.apple_key_id)
            .field("apple_private_key", &"<redacted>")
            .finish()
    }
}

impl Default for SocialProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            client_id: String::new(),
            client_secret: String::new(),
            scopes: Vec::new(),
            discovery_url: None,
            name: None,
            protocol: None,
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            jwks_url: None,
            issuer: None,
            client_auth_method: None,
            pkce: None,
            trust_email_verified: None,
            logo_url: None,
            claim_mapping: None,
            authenticatable_at_sign_in: true,
            apple_team_id: None,
            apple_key_id: None,
            apple_private_key: None,
        }
    }
}
