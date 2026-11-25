use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SecuritySettings {
    pub bot_protection: bool,
    pub captcha_provider: CaptchaProvider,
    pub captcha_secret: String,
    pub captcha_site_key: String,
    pub rate_limit_enabled: bool,
    pub enumeration_protection: bool,
    pub testing_tokens_enabled: bool,
}

impl std::fmt::Debug for SecuritySettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecuritySettings")
            .field("bot_protection", &self.bot_protection)
            .field("captcha_provider", &self.captcha_provider)
            .field("captcha_secret", &"<redacted>")
            .field("captcha_site_key", &self.captcha_site_key)
            .field("rate_limit_enabled", &self.rate_limit_enabled)
            .field("enumeration_protection", &self.enumeration_protection)
            .field("testing_tokens_enabled", &self.testing_tokens_enabled)
            .finish()
    }
}

impl Default for SecuritySettings {
    fn default() -> Self {
        Self {
            bot_protection: false,
            captcha_provider: CaptchaProvider::None,
            captcha_secret: String::new(),
            captcha_site_key: String::new(),
            rate_limit_enabled: true,
            enumeration_protection: true,
            testing_tokens_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct BrandingSettings {
    pub primary_color: String,
    pub show_powered_by: bool,
    pub theme: Theme,
}

impl Default for BrandingSettings {
    fn default() -> Self {
        Self {
            primary_color: "#2b2522".into(),
            show_powered_by: true,
            theme: Theme::System,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceSettings {
    pub application: ApplicationSettings,
    pub attributes: AttributesSettings,
    pub password: PasswordSettings,
    pub username: UsernameSettings,
    pub sign_up: SignUpSettings,
    pub restrictions: RestrictionsSettings,
    pub social: BTreeMap<String, SocialProviderConfig>,
    pub mfa: MfaSettings,
    pub session: SessionSettings,
    pub anonymous: AnonymousSettings,
    pub oidc_provider: OidcProviderSettings,
    pub organizations: OrganizationsSettings,
    pub roles: RolesSettings,
    pub user_settings: UserSettings,
    pub email: EmailSettings,
    pub sms: SmsSettings,
    pub security: SecuritySettings,
    pub branding: BrandingSettings,
}

/// Social providers known to the product, in the order the dashboard lists them.
pub const SOCIAL_PROVIDERS: &[&str] = &[
    "google",
    "github",
    "gitlab",
    "discord",
    "microsoft",
    "apple",
    "facebook",
    "twitter",
    "linkedin_oidc",
    "slack",
    "twitch",
    "spotify",
    "bitbucket",
    "dropbox",
    "notion",
    "hubspot",
    "tiktok",
    "coinbase",
    "line",
    "linear",
    "huggingface",
    "box",
    "atlassian",
    "xero",
    "x",
    "zoom",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_dashboard_contract() {
        let settings = InstanceSettings::default();
        assert_eq!(settings.application.name, "OrbitID App");
        assert_eq!(
            settings.application.allowed_origins,
            vec!["http://localhost:3000", "http://localhost:5173"]
        );
        assert!(settings.attributes.email_address.enabled);
        assert!(!settings.attributes.phone_number.enabled);
        assert_eq!(settings.session.token_lifetime_seconds, 60);
        assert_eq!(settings.session.lifetime_seconds, 0);
        assert_eq!(settings.organizations.creator_role, "org:admin");
        assert_eq!(settings.roles.default_role, None);
        assert_eq!(settings.email.provider, EmailProvider::Auto);
        assert_eq!(settings.email.from, "OrbitID <no-reply@localhost>");
    }

    #[test]
    fn serialized_shape_is_camel_case() {
        let value = serde_json::to_value(InstanceSettings::default()).unwrap();
        assert!(value["attributes"]["emailAddress"]["usedForFirstFactor"]
            .as_bool()
            .unwrap());
        assert_eq!(value["oidcProvider"]["accessTokenFormat"], "opaque");
        assert!(value["organizations"]["maxCreatedOrganizationsPerUser"].is_null());
        assert!(value["roles"]["defaultRole"].is_null());
        assert_eq!(value["email"]["codeLength"], 6);
    }

    #[test]
    fn partial_objects_use_attribute_defaults() {
        let value = serde_json::json!({ "attributes": { "phoneNumber": { "enabled": false } } });
        let settings: InstanceSettings = serde_json::from_value(value).unwrap();
        assert!(!settings.attributes.phone_number.enabled);
        // `enabled` is required when the attribute object is present.
        let bad = serde_json::json!({ "attributes": { "phoneNumber": { "required": true } } });
        assert!(serde_json::from_value::<InstanceSettings>(bad).is_err());
    }
}
