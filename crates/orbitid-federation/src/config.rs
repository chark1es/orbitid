//! Provider configuration, defaults and the public listing used by the Frontend API.
//!
//! Ported from the retired TypeScript server. Configuration
//! reads [`orbitid_core::AppState::settings`]; nothing here touches a database.

use orbitid_core::settings::types::{ClaimMapping, ClientAuthMethod, SocialProtocol};
use orbitid_core::AppState;

use crate::error::provider_not_enabled;

/// Provider configuration resolved from instance settings, with the TypeScript
/// defaults applied (display name, scopes, protocol).
#[derive(Clone)]
pub struct OAuthProviderConfig {
    pub key: String,
    pub name: String,
    pub client_id: String,
    pub client_secret: String,
    pub scopes: Vec<String>,
    pub discovery_url: Option<String>,
    /// Custom providers: `oidc` (default) or `oauth2` (profile comes from userinfo).
    pub protocol: Option<SocialProtocol>,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub userinfo_url: Option<String>,
    pub jwks_url: Option<String>,
    pub issuer: Option<String>,
    pub client_auth_method: Option<ClientAuthMethod>,
    pub pkce: Option<bool>,
    pub trust_email_verified: Option<bool>,
    pub logo_url: Option<String>,
    pub claim_mapping: Option<ClaimMapping>,
    /// Apple only: the `.p8` key material used to mint the client secret.
    pub apple_team_id: Option<String>,
    pub apple_key_id: Option<String>,
    pub apple_private_key: Option<String>,
}

impl std::fmt::Debug for OAuthProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthProviderConfig")
            .field("key", &self.key)
            .field("name", &self.name)
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("scopes", &self.scopes)
            .field("discovery_url", &self.discovery_url)
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
            .field("apple_team_id", &self.apple_team_id)
            .field("apple_key_id", &self.apple_key_id)
            .field("apple_private_key", &"<redacted>")
            .finish()
    }
}

/// One entry of `GET /v1/client/environment`'s social map.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct SocialProviderListing {
    pub key: String,
    pub strategy: String,
    pub name: String,
    pub logo_url: String,
    pub authenticatable: bool,
}

const PROVIDER_NAMES: [(&str, &str); 27] = [
    ("google", "Google"),
    ("github", "GitHub"),
    ("gitlab", "GitLab"),
    ("discord", "Discord"),
    ("microsoft", "Microsoft"),
    ("apple", "Apple"),
    ("facebook", "Facebook"),
    ("twitter", "Twitter"),
    ("x", "X"),
    ("linkedin_oidc", "LinkedIn"),
    ("slack", "Slack"),
    ("twitch", "Twitch"),
    ("spotify", "Spotify"),
    ("bitbucket", "Bitbucket"),
    ("dropbox", "Dropbox"),
    ("notion", "Notion"),
    ("hubspot", "HubSpot"),
    ("tiktok", "TikTok"),
    ("coinbase", "Coinbase"),
    ("line", "LINE"),
    ("linear", "Linear"),
    ("huggingface", "Hugging Face"),
    ("box", "Box"),
    ("atlassian", "Atlassian"),
    ("xero", "Xero"),
    ("zoom", "Zoom"),
    ("", ""),
];

/// `oauth_google` → `google`; `oauth_custom_acme` → `custom_acme`.
pub fn provider_key_from_strategy(strategy: &str) -> &str {
    strategy.strip_prefix("oauth_").unwrap_or(strategy)
}

/// Human-readable provider name: an explicit configured name wins, then the
/// built-in table, then `custom_x` → `x`, then the key itself.
pub fn provider_display_name(key: &str, fallback: Option<&str>) -> String {
    if let Some(name) = fallback.filter(|value| !value.is_empty()) {
        return name.to_string();
    }
    if let Some((_, name)) = PROVIDER_NAMES.iter().find(|(name, _)| *name == key) {
        return (*name).to_string();
    }
    if let Some(custom) = key.strip_prefix("custom_") {
        return custom.to_string();
    }
    key.to_string()
}

/// CDN logo used when the operator did not upload one.
pub fn provider_logo_url(key: &str) -> String {
    let slug = match key {
        "twitter" | "x" => "x",
        "linkedin_oidc" => "linkedin",
        "microsoft" => "microsoft",
        other if other.starts_with("custom_") => "openid",
        other => other,
    };
    format!("https://cdn.simpleicons.org/{slug}")
}

/// Default scopes for every built-in provider.
pub fn default_scopes(key: &str, protocol: Option<SocialProtocol>) -> Vec<String> {
    let scopes: &[&str] = match key {
        "google" => &["openid", "email", "profile"],
        "github" => &["read:user", "user:email"],
        "gitlab" => &["read_user"],
        "discord" => &["identify", "email"],
        "microsoft" => &["openid", "profile", "email", "User.Read"],
        "apple" => &["name", "email"],
        "facebook" => &["email", "public_profile"],
        "twitter" | "x" => &["users.read", "tweet.read", "offline.access"],
        "linkedin_oidc" => &["openid", "profile", "email"],
        "slack" => &["openid", "profile", "email"],
        "twitch" => &["user:read:email"],
        "spotify" => &["user-read-email", "user-read-private"],
        "bitbucket" => &["account", "email"],
        "dropbox" => &["account_info.read"],
        "notion" | "box" => &[],
        "hubspot" => &["oauth"],
        "tiktok" => &["user.info.basic", "user.info.profile"],
        "coinbase" => &["wallet:user:read", "wallet:accounts:read"],
        "line" => &["profile", "openid", "email"],
        "linear" => &["read"],
        "huggingface" => &["openid", "profile", "email"],
        "atlassian" => &["read:me", "read:account", "offline_access"],
        "xero" => &["openid", "profile", "email", "offline_access"],
        "zoom" => &["user:read"],
        _ if key.starts_with("custom_") => match protocol {
            Some(SocialProtocol::Oauth2) => &[],
            _ => &["openid", "profile", "email"],
        },
        _ => &[],
    };
    scopes.iter().map(|scope| (*scope).to_string()).collect()
}

/// `${baseUrl}/v1/oauth_callback/${key}`.
pub fn provider_redirect_uri(base_url: &str, key: &str) -> String {
    format!("{base_url}/v1/oauth_callback/{key}")
}

/// Reads a provider's configuration from instance settings. `None` when the
/// provider is disabled or has no client id, exactly like the TypeScript helper.
pub fn provider_config(state: &AppState, key: &str) -> Option<OAuthProviderConfig> {
    let settings = state.settings.get();
    let cfg = settings.social.get(key)?;
    if !cfg.enabled || cfg.client_id.is_empty() {
        return None;
    }
    let scopes = if cfg.scopes.is_empty() {
        default_scopes(key, cfg.protocol)
    } else {
        cfg.scopes.clone()
    };
    Some(OAuthProviderConfig {
        key: key.to_string(),
        name: provider_display_name(key, cfg.name.as_deref()),
        client_id: cfg.client_id.clone(),
        client_secret: cfg.client_secret.clone(),
        scopes,
        discovery_url: cfg.discovery_url.clone(),
        protocol: cfg.protocol,
        authorization_url: cfg.authorization_url.clone(),
        token_url: cfg.token_url.clone(),
        userinfo_url: cfg.userinfo_url.clone(),
        jwks_url: cfg.jwks_url.clone(),
        issuer: cfg.issuer.clone(),
        client_auth_method: cfg.client_auth_method,
        pkce: cfg.pkce,
        trust_email_verified: cfg.trust_email_verified,
        logo_url: cfg.logo_url.clone(),
        claim_mapping: cfg.claim_mapping.clone(),
        apple_team_id: cfg.apple_team_id.clone(),
        apple_key_id: cfg.apple_key_id.clone(),
        apple_private_key: cfg.apple_private_key.clone(),
    })
}

/// True when the provider is configured and enabled.
pub fn is_provider_enabled(state: &AppState, key: &str) -> bool {
    provider_config(state, key).is_some()
}

/// Providers a sign-in screen may offer, in settings order.
pub fn list_enabled_social_providers(state: &AppState) -> Vec<SocialProviderListing> {
    let settings = state.settings.get();
    settings
        .social
        .iter()
        .filter(|(_, cfg)| cfg.enabled && !cfg.client_id.is_empty())
        .map(|(key, cfg)| SocialProviderListing {
            key: key.clone(),
            strategy: format!("oauth_{key}"),
            name: provider_display_name(key, cfg.name.as_deref()),
            logo_url: cfg
                .logo_url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| provider_logo_url(key)),
            authenticatable: cfg.authenticatable_at_sign_in,
        })
        .collect()
}

/// Apple's issuer, JWKS and token endpoint.
pub const APPLE_ISSUER: &str = "https://appleid.apple.com";
pub const APPLE_JWKS_URL: &str = "https://appleid.apple.com/auth/keys";
pub const APPLE_TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
/// Apple caps the client secret's lifetime at six months.
pub const APPLE_CLIENT_SECRET_LIFETIME_SECONDS: i64 = 180 * 24 * 60 * 60;
/// Renew a day early so a long request never straddles the expiry.
pub const APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS: i64 = 24 * 60 * 60;

/// True when the server can mint the Apple client secret from a `.p8` key.
pub fn has_apple_key(cfg: &OAuthProviderConfig) -> bool {
    cfg.apple_team_id.is_some() && cfg.apple_key_id.is_some() && cfg.apple_private_key.is_some()
}

/// Error for an adapter that cannot be built for the configured key.
pub(crate) fn unsupported(key: &str) -> orbitid_core::OrbitError {
    provider_not_enabled(format!("Unsupported OAuth provider \"{key}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_and_logos() {
        assert_eq!(provider_display_name("google", None), "Google");
        assert_eq!(provider_display_name("google", Some("Acme")), "Acme");
        assert_eq!(provider_display_name("custom_acme", None), "acme");
        assert_eq!(provider_display_name("unknown", None), "unknown");
        assert_eq!(
            provider_logo_url("twitter"),
            "https://cdn.simpleicons.org/x"
        );
        assert_eq!(
            provider_logo_url("custom_acme"),
            "https://cdn.simpleicons.org/openid"
        );
        assert_eq!(
            provider_logo_url("github"),
            "https://cdn.simpleicons.org/github"
        );
    }

    #[test]
    fn provider_key_from_strategy_strips_only_the_prefix() {
        assert_eq!(provider_key_from_strategy("oauth_google"), "google");
        assert_eq!(
            provider_key_from_strategy("oauth_custom_acme"),
            "custom_acme"
        );
        assert_eq!(provider_key_from_strategy("google"), "google");
    }

    #[test]
    fn default_scopes_match_the_typescript_table() {
        assert_eq!(
            default_scopes("github", None),
            vec!["read:user", "user:email"]
        );
        assert!(default_scopes("notion", None).is_empty());
        assert!(default_scopes("custom_a", Some(SocialProtocol::Oauth2)).is_empty());
        assert_eq!(
            default_scopes("custom_a", None),
            vec!["openid", "profile", "email"]
        );
    }

    #[test]
    fn redirect_uri_uses_the_base_url() {
        assert_eq!(
            provider_redirect_uri("https://auth.example", "google"),
            "https://auth.example/v1/oauth_callback/google"
        );
    }
}
