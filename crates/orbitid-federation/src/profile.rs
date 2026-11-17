//! The provider-neutral identity a federation flow produces.
//!
//! Ported from `ExternalProfile` in the retired TypeScript server.
//! Linking this profile to a local user belongs to a higher layer; this crate only
//! establishes that the identity provider asserted it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A user identity returned by a social, custom OIDC or SAML provider.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ExternalProfile {
    /// Provider key: `google`, `custom_acme`, `saml_<connection id>`, `oidc_<connection id>`, …
    pub provider: String,
    /// Stable subject inside that provider (`sub`, NameID, provider-specific id).
    pub provider_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix epoch milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

impl std::fmt::Debug for ExternalProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalProfile")
            .field("provider", &self.provider)
            .field("provider_user_id", &self.provider_user_id)
            .field("email", &self.email)
            .field("email_verified", &self.email_verified)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("username", &self.username)
            .field("image_url", &self.image_url)
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .field("raw", &self.raw)
            .finish()
    }
}

impl ExternalProfile {
    /// True only when the provider explicitly verified the address. An unverified
    /// claim must never be linked to an existing local account, whatever the
    /// operator's `trustEmailVerified` setting says.
    pub fn email_may_link(&self) -> bool {
        self.email_verified == Some(true)
            && self.email.as_deref().is_some_and(|value| !value.is_empty())
    }
}

/// Builder used by the provider adapters (`profile()` in the TypeScript source).
pub(crate) fn build_profile(
    key: &str,
    provider_user_id: impl Into<String>,
    tokens: Option<&crate::oauth::OAuthTokenSet>,
) -> ExternalProfile {
    let mut profile = ExternalProfile {
        provider: key.to_string(),
        provider_user_id: provider_user_id.into(),
        ..ExternalProfile::default()
    };
    if let Some(tokens) = tokens {
        profile.access_token = Some(tokens.access_token.clone());
        profile.refresh_token = tokens.refresh_token.clone();
        profile.expires_at = tokens.expires_at;
        profile.scopes = tokens.scopes.clone();
    }
    profile
}
