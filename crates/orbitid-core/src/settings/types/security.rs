use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Map;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MfaSettings {
    pub required: bool,
    pub max_attempts: i64,
    pub lockout_duration_seconds: i64,
}

impl Default for MfaSettings {
    fn default() -> Self {
        Self {
            required: false,
            max_attempts: 100,
            lockout_duration_seconds: 3600,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionSettings {
    pub lifetime_seconds: i64,
    pub inactivity_timeout_seconds: i64,
    pub token_lifetime_seconds: i64,
    pub multi_session: bool,
    pub trusted_devices_enabled: bool,
    pub trusted_device_days: i64,
    pub custom_claims: Metadata,
}

impl Default for SessionSettings {
    fn default() -> Self {
        Self {
            lifetime_seconds: 0,
            inactivity_timeout_seconds: 0,
            token_lifetime_seconds: 60,
            multi_session: true,
            trusted_devices_enabled: false,
            trusted_device_days: 30,
            custom_claims: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AnonymousSettings {
    pub enabled: bool,
    pub retention_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OidcProviderSettings {
    pub access_token_format: AccessTokenFormat,
    pub device_authorization_enabled: bool,
    pub device_code_lifetime_seconds: i64,
    pub device_code_interval_seconds: i64,
    pub refresh_token_reuse_grace_seconds: i64,
}

impl Default for OidcProviderSettings {
    fn default() -> Self {
        Self {
            access_token_format: AccessTokenFormat::Opaque,
            device_authorization_enabled: false,
            device_code_lifetime_seconds: 600,
            device_code_interval_seconds: 5,
            refresh_token_reuse_grace_seconds: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct OrganizationsSettings {
    pub enabled: bool,
    pub creation_enabled: bool,
    pub max_allowed_memberships: i64,
    pub slug_enabled: bool,
    pub domains_enabled: bool,
    pub membership_requests_enabled: bool,
    pub force_organization_selection: bool,
    pub creator_role: String,
    pub default_role: String,
    pub admin_delete_enabled: bool,
    pub max_created_organizations_per_user: Option<i64>,
}

impl Default for OrganizationsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            creation_enabled: true,
            max_allowed_memberships: 0,
            slug_enabled: true,
            domains_enabled: false,
            membership_requests_enabled: false,
            force_organization_selection: false,
            creator_role: "org:admin".into(),
            default_role: "org:member".into(),
            admin_delete_enabled: true,
            max_created_organizations_per_user: None,
        }
    }
}
