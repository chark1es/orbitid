//! Email/SMS service core: templates, provider resolution and the boot-time
//! warnings. The per-`AppState` outbox lives in [`super::outbox`].
//!
//! Ported from the retired TypeScript server. Nothing here ever
//! prints a message: a sign-in code on stdout ends up in logs forever. When no
//! provider is configured delivery fails closed.

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::email_format::{
    header_safe, parse_email_from, parse_smtp_url, redact_smtp_url, DEFAULT_FROM,
};
use orbitid_core::http::now;
use orbitid_core::settings::types::{EmailProvider as SettingsEmailProvider, InstanceSettings};
use orbitid_core::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One of the templates the server renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailTemplate {
    VerificationCode,
    MagicLink,
    ResetPasswordCode,
    Invitation,
    OrganizationInvitation,
    PasswordChanged,
    NewSignIn,
    WaitlistInvited,
    DomainVerificationCode,
    TestEmail,
}

impl EmailTemplate {
    /// The wire template name (`verification_code`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VerificationCode => "verification_code",
            Self::MagicLink => "magic_link",
            Self::ResetPasswordCode => "reset_password_code",
            Self::Invitation => "invitation",
            Self::OrganizationInvitation => "organization_invitation",
            Self::PasswordChanged => "password_changed",
            Self::NewSignIn => "new_sign_in",
            Self::WaitlistInvited => "waitlist_invited",
            Self::DomainVerificationCode => "domain_verification_code",
            Self::TestEmail => "test_email",
        }
    }
}

impl std::fmt::Display for EmailTemplate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Template variables. The TypeScript server accepted `string | number | undefined`.
pub type EmailVars = serde_json::Map<String, Value>;

#[derive(Debug, Clone, PartialEq)]
pub struct SendEmailInput {
    pub to: String,
    pub template: EmailTemplate,
    pub vars: EmailVars,
}

impl SendEmailInput {
    /// Builds an input with no variables.
    pub fn new(to: impl Into<String>, template: EmailTemplate) -> Self {
        Self {
            to: to.into(),
            template,
            vars: EmailVars::new(),
        }
    }

    /// Adds one template variable (`builder` style).
    pub fn with_var(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.vars.insert(key.into(), value.into());
        self
    }
}

/// Outcome of a send. Delivery never breaks an auth flow and never writes to the
/// console: a failed send is reported to the caller and recorded as a
/// recipient-free audit entry (template and reason only).
#[derive(Debug, Clone, PartialEq)]
pub struct EmailDeliveryResult {
    pub delivered: bool,
    /// Machine-readable reason when `delivered` is false; never contains a code,
    /// link, recipient or provider secret.
    pub error: Option<EmailDeliveryError>,
}

impl EmailDeliveryResult {
    /// A successful send.
    pub fn delivered() -> Self {
        Self {
            delivered: true,
            error: None,
        }
    }

    /// A failed send with a secret-free reason.
    pub fn failed(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            delivered: false,
            error: Some(EmailDeliveryError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmailDeliveryError {
    pub code: String,
    pub message: String,
}

/// A rendered message kept in the test outbox.
#[derive(Debug, Clone, PartialEq)]
pub struct SentEmail {
    pub to: String,
    pub template: EmailTemplate,
    pub subject: String,
    pub text: String,
    pub html: String,
    pub vars: EmailVars,
    pub sent_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SentSms {
    pub to: String,
    pub body: String,
    pub sent_at: i64,
}

/// How mail leaves the server. `console` is the legacy "no provider configured"
/// value: it never delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MailProvider {
    Resend,
    Smtp,
    Console,
}

#[derive(Clone, PartialEq)]
pub struct ResolvedEmailTransport {
    pub provider: MailProvider,
    /// Header-safe `From` value, e.g. `"Acme" <no-reply@acme.test>`.
    pub from: String,
    pub resend_api_key: Option<String>,
    pub smtp_url: Option<String>,
}

impl std::fmt::Debug for ResolvedEmailTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedEmailTransport")
            .field("provider", &self.provider)
            .field("from", &self.from)
            .field("resend_api_key", &"<redacted>")
            .field("smtp_url", &"<redacted>")
            .finish()
    }
}

/// Overrides delivery in tests (the TypeScript `setMailTransport` seam).
#[async_trait::async_trait]
pub trait MailTransportOverride: Send + Sync {
    async fn deliver(&self, email: &SentEmail) -> Result<(), OrbitError>;
}

/// Overrides SMS delivery in tests (the TypeScript `setSmsSender` seam).
#[async_trait::async_trait]
pub trait SmsSender: Send + Sync {
    async fn send(&self, to: &str, body: &str) -> Result<(), OrbitError>;
}

/// Picks the transport from settings, falling back to the environment only where
/// the setting is empty. Explicit `email.provider` wins; `auto` uses Resend when a
/// key exists, else SMTP, else nothing.
pub fn resolve_email_transport(state: &AppState) -> Result<ResolvedEmailTransport, OrbitError> {
    let settings = state.settings.get();
    let env = &state.env;
    resolve_email_transport_with(
        &settings,
        &env.resend_api_key,
        &env.smtp_url,
        &env.email_from,
    )
}

/// Pure resolver used by [`resolve_email_transport`] and the unit tests.
pub fn resolve_email_transport_with(
    settings: &InstanceSettings,
    env_resend_api_key: &str,
    env_smtp_url: &str,
    env_email_from: &str,
) -> Result<ResolvedEmailTransport, OrbitError> {
    let email = &settings.email;
    let resend_api_key = first_non_empty(&email.resend_api_key, env_resend_api_key);
    let smtp_url = first_non_empty(&email.smtp_url, env_smtp_url);
    let setting_from = if !email.from.is_empty() && email.from != DEFAULT_FROM {
        email.from.clone()
    } else {
        String::new()
    };
    let from_source = if setting_from.is_empty() {
        let env_from = env_email_from.trim();
        if env_from.is_empty() {
            DEFAULT_FROM.to_string()
        } else {
            env_from.to_string()
        }
    } else {
        setting_from
    };
    let from = parse_email_from(&from_source, "email.from")?.value;

    let provider = match email.provider {
        SettingsEmailProvider::Resend => MailProvider::Resend,
        SettingsEmailProvider::Smtp => MailProvider::Smtp,
        SettingsEmailProvider::Console => MailProvider::Console,
        SettingsEmailProvider::Auto => {
            if !resend_api_key.is_empty() {
                MailProvider::Resend
            } else if !smtp_url.is_empty() {
                MailProvider::Smtp
            } else {
                MailProvider::Console
            }
        }
    };

    match provider {
        MailProvider::Resend => {
            if resend_api_key.is_empty() {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "email.provider is resend but no API key is configured. Set email.resendApiKey or ORBITID_RESEND_API_KEY.",
                )
                .with_meta(serde_json::json!({ "param_name": "email.resendApiKey" })));
            }
            Ok(ResolvedEmailTransport {
                provider,
                from,
                resend_api_key: Some(resend_api_key),
                smtp_url: None,
            })
        }
        MailProvider::Smtp => {
            if smtp_url.is_empty() {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "email.provider is smtp but no SMTP URL is configured. Set email.smtpUrl or ORBITID_SMTP_URL.",
                )
                .with_meta(serde_json::json!({ "param_name": "email.smtpUrl" })));
            }
            parse_smtp_url(&smtp_url, "email.smtpUrl")?;
            Ok(ResolvedEmailTransport {
                provider,
                from,
                resend_api_key: None,
                smtp_url: Some(smtp_url),
            })
        }
        MailProvider::Console => Ok(ResolvedEmailTransport {
            provider,
            from,
            resend_api_key: None,
            smtp_url: None,
        }),
    }
}

fn first_non_empty(setting: &str, environment: &str) -> String {
    // `setting || environment`: only the empty string is falsy in JavaScript.
    let value = if setting.is_empty() {
        environment
    } else {
        setting
    };
    value.trim().to_string()
}

/// `console` is not a delivery channel; only an error is honest.
pub fn email_delivery_configured(state: &AppState) -> bool {
    resolve_email_transport(state)
        .map(|transport| transport.provider != MailProvider::Console)
        .unwrap_or(false)
}

/// Boot-time report so an operator sees a misconfiguration before a user does.
pub fn email_startup_warnings(state: &AppState) -> Vec<String> {
    let settings = state.settings.get();
    let env = &state.env;
    match resolve_email_transport_with(
        &settings,
        &env.resend_api_key,
        &env.smtp_url,
        &env.email_from,
    ) {
        Err(error) => vec![format!("  Email           : MISCONFIGURED — {}", error.message)],
        Ok(transport) => match transport.provider {
            MailProvider::Resend => vec!["  Email           : Resend".to_string()],
            MailProvider::Smtp => vec![format!(
                "  Email           : SMTP ({})",
                redact_smtp_url(transport.smtp_url.as_deref().unwrap_or(""))
            )],
            MailProvider::Console => vec![
                "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!".to_string(),
                "  !! EMAIL IS NOT CONFIGURED, SO NO EMAIL IS SENT.                                   !!".to_string(),
                "  !! Sign-in codes, magic links and invitations cannot be delivered.                 !!".to_string(),
                "  !! Set ORBITID_RESEND_API_KEY or ORBITID_SMTP_URL (or pick a provider in the       !!".to_string(),
                "  !! dashboard). See docs/EMAIL.md.                                                  !!".to_string(),
                "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!".to_string(),
            ],
        },
    }
}

/// Header-safe helper re-export used by `send_email`'s event payload.
pub fn safe_recipient_fallback(value: &str) -> String {
    header_safe(value)
}

pub(crate) fn now_ms() -> i64 {
    now()
}
