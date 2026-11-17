use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UserSettings {
    pub delete_self_enabled: bool,
    pub create_organization_enabled: bool,
    pub allow_profile_image_upload: bool,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            delete_self_enabled: true,
            create_organization_enabled: true,
            allow_profile_image_upload: true,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EmailSettings {
    pub from: String,
    pub provider: EmailProvider,
    pub smtp_url: String,
    pub resend_api_key: String,
    pub code_length: i64,
    pub code_lifetime_seconds: i64,
    pub link_lifetime_seconds: i64,
}

impl std::fmt::Debug for EmailSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmailSettings")
            .field("from", &self.from)
            .field("provider", &self.provider)
            .field("smtp_url", &"<redacted>")
            .field("resend_api_key", &"<redacted>")
            .field("code_length", &self.code_length)
            .field("code_lifetime_seconds", &self.code_lifetime_seconds)
            .field("link_lifetime_seconds", &self.link_lifetime_seconds)
            .finish()
    }
}

impl Default for EmailSettings {
    fn default() -> Self {
        Self {
            from: "OrbitID <no-reply@localhost>".into(),
            provider: EmailProvider::Auto,
            smtp_url: String::new(),
            resend_api_key: String::new(),
            code_length: 6,
            code_lifetime_seconds: 600,
            link_lifetime_seconds: 3600,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SmsSettings {
    pub provider: SmsProvider,
    pub twilio_account_sid: String,
    pub twilio_auth_token: String,
    pub twilio_from: String,
    pub webhook_url: String,
}

impl std::fmt::Debug for SmsSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmsSettings")
            .field("provider", &self.provider)
            .field("twilio_account_sid", &self.twilio_account_sid)
            .field("twilio_auth_token", &"<redacted>")
            .field("twilio_from", &self.twilio_from)
            .field("webhook_url", &self.webhook_url)
            .finish()
    }
}

impl Default for SmsSettings {
    fn default() -> Self {
        Self {
            provider: SmsProvider::Console,
            twilio_account_sid: String::new(),
            twilio_auth_token: String::new(),
            twilio_from: String::new(),
            webhook_url: String::new(),
        }
    }
}
