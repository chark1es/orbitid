use crate::error::{error_codes, OrbitError};
use crate::http::email_format::{parse_email_from, parse_smtp_url, DEFAULT_FROM};
use crate::settings::types::{AttributeConfig, EmailProvider, InstanceSettings, SmsProvider};

#[derive(Clone, Default)]
pub struct DeliveryEnvironment {
    pub resend_api_key: Option<String>,
    pub smtp_url: Option<String>,
    pub email_from: Option<String>,
}

impl std::fmt::Debug for DeliveryEnvironment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeliveryEnvironment")
            .field("resend_api_key", &"<redacted>")
            .field("smtp_url", &"<redacted>")
            .field("email_from", &self.email_from)
            .finish()
    }
}

pub(super) fn invalid(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(serde_json::json!({ "param_name": param }))
}

pub(super) fn attributes(settings: &InstanceSettings) -> [(&'static str, &AttributeConfig); 9] {
    [
        ("emailAddress", &settings.attributes.email_address),
        ("phoneNumber", &settings.attributes.phone_number),
        ("username", &settings.attributes.username),
        ("firstName", &settings.attributes.first_name),
        ("lastName", &settings.attributes.last_name),
        ("password", &settings.attributes.password),
        ("passkey", &settings.attributes.passkey),
        ("backupCode", &settings.attributes.backup_code),
        ("authenticatorApp", &settings.attributes.authenticator_app),
    ]
}

pub(super) fn assert_attribute_consistency(settings: &InstanceSettings) -> Result<(), OrbitError> {
    for (name, attribute) in attributes(settings) {
        let param = format!("attributes.{name}");
        if attribute.required && !attribute.enabled {
            return Err(invalid(
                &param,
                format!("{param}.required needs {param}.enabled: a required field that is disabled can never be satisfied"),
            ));
        }
        if attribute.used_for_first_factor && !attribute.enabled {
            return Err(invalid(
                &param,
                format!("{param}.usedForFirstFactor needs {param}.enabled"),
            ));
        }
        if attribute.used_for_second_factor && !attribute.enabled {
            return Err(invalid(
                &param,
                format!("{param}.usedForSecondFactor needs {param}.enabled"),
            ));
        }
    }
    Ok(())
}

pub(super) fn assert_email_transport_shape(
    settings: &InstanceSettings,
    env: &DeliveryEnvironment,
) -> Result<(), OrbitError> {
    let email = &settings.email;
    let setting_from = if !email.from.trim().is_empty() && email.from != DEFAULT_FROM {
        email.from.clone()
    } else {
        String::new()
    };
    let from = if !setting_from.is_empty() {
        setting_from
    } else {
        env.email_from
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_FROM)
            .to_string()
    };
    parse_email_from(&from, "email.from")?;
    let smtp_url = if !email.smtp_url.trim().is_empty() {
        email.smtp_url.trim().to_string()
    } else {
        env.smtp_url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };
    if !smtp_url.is_empty() {
        parse_smtp_url(&smtp_url, "email.smtpUrl")?;
    }
    if email.provider == EmailProvider::Smtp && smtp_url.is_empty() {
        return Err(invalid(
            "email.provider",
            "email.provider is smtp but no SMTP URL is configured. Set email.smtpUrl or ORBITID_SMTP_URL.",
        ));
    }
    let resend = !email.resend_api_key.trim().is_empty()
        || env
            .resend_api_key
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty());
    if email.provider == EmailProvider::Resend && !resend {
        return Err(invalid(
            "email.provider",
            "email.provider is resend but no API key is configured. Set email.resendApiKey or ORBITID_RESEND_API_KEY.",
        ));
    }
    Ok(())
}

pub(super) fn assert_sms_transport_shape(settings: &InstanceSettings) -> Result<(), OrbitError> {
    let sms = &settings.sms;
    if sms.provider == SmsProvider::Twilio {
        let missing: Vec<&str> = [
            ("twilioAccountSid", sms.twilio_account_sid.trim().is_empty()),
            ("twilioAuthToken", sms.twilio_auth_token.trim().is_empty()),
            ("twilioFrom", sms.twilio_from.trim().is_empty()),
        ]
        .into_iter()
        .filter_map(|(field, empty)| empty.then_some(field))
        .collect();
        if !missing.is_empty() {
            let names: Vec<String> = missing.iter().map(|f| format!("sms.{f}")).collect();
            let verb = if missing.len() == 1 { "is" } else { "are" };
            return Err(invalid(
                "sms.provider",
                format!(
                    "sms.provider is twilio but {} {verb} empty.",
                    names.join(", ")
                ),
            ));
        }
    }
    if sms.provider == SmsProvider::Webhook && sms.webhook_url.trim().is_empty() {
        return Err(invalid(
            "sms.provider",
            "sms.provider is webhook but sms.webhookUrl is empty.",
        ));
    }
    if !sms.webhook_url.trim().is_empty() {
        let raw = sms.webhook_url.trim();
        let valid = raw.starts_with("https://") && !raw.chars().any(char::is_whitespace);
        if !valid {
            return Err(invalid(
                "sms.webhookUrl",
                "sms.webhookUrl must be an absolute https URL that receives the code.",
            ));
        }
    }
    Ok(())
}

pub(super) fn url_shape(raw: &str, param: &str) -> Result<(), OrbitError> {
    let url = url::Url::parse(raw)
        .map_err(|_| invalid(param, format!("{param} must be an absolute URL.")))?;
    let host = url.host_str().unwrap_or("").to_string();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
    let scheme = url.scheme();
    if scheme != "https" && !(scheme == "http" && loopback) {
        return Err(invalid(
            param,
            format!("{param} must be an absolute https URL (plain http is only accepted for a loopback host)."),
        ));
    }
    Ok(())
}

pub(super) fn assert_social_providers(settings: &InstanceSettings) -> Result<(), OrbitError> {
    for (key, provider) in &settings.social {
        if !provider.enabled {
            continue;
        }
        let param = format!("social.{key}");
        let custom = key.starts_with("custom_");
        if provider.client_id.trim().is_empty() {
            return Err(invalid(
                &param,
                format!("{param} is enabled but has no clientId. Add the provider's client id or turn the provider off."),
            ));
        }
        let apple_with_key = key == "apple"
            && provider
                .apple_team_id
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty())
            && provider
                .apple_key_id
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty())
            && provider
                .apple_private_key
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty());
        let public_client =
            custom && provider.pkce != Some(false) && provider.client_secret.trim().is_empty();
        if provider.client_secret.trim().is_empty() && !apple_with_key && !public_client {
            return Err(invalid(
                &param,
                format!("{param} is enabled but has no clientSecret (or, for Apple, a team id, key id and private key)."),
            ));
        }
        if custom {
            let discovery = provider
                .discovery_url
                .as_deref()
                .map(str::trim)
                .unwrap_or("");
            let manual = provider
                .authorization_url
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty())
                && provider
                    .token_url
                    .as_deref()
                    .is_some_and(|v| !v.trim().is_empty());
            if discovery.is_empty() && !manual {
                return Err(invalid(
                    &param,
                    format!("{param} needs a discoveryUrl, or manual authorizationUrl and tokenUrl endpoints."),
                ));
            }
            let userinfo = provider
                .userinfo_url
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty());
            let jwks = provider
                .jwks_url
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty());
            if discovery.is_empty()
                && provider.protocol == Some(crate::settings::types::SocialProtocol::Oauth2)
                && !userinfo
            {
                return Err(invalid(
                    &param,
                    format!("{param} is an OAuth 2.0 provider and needs a userinfoUrl to read the profile."),
                ));
            }
            if discovery.is_empty()
                && provider.protocol != Some(crate::settings::types::SocialProtocol::Oauth2)
                && !userinfo
                && !jwks
            {
                return Err(invalid(
                    &param,
                    format!("{param} needs a userinfoUrl or a jwksUrl to identify the user."),
                ));
            }
        }
        for (field, value) in [
            ("discoveryUrl", provider.discovery_url.as_deref()),
            ("authorizationUrl", provider.authorization_url.as_deref()),
            ("tokenUrl", provider.token_url.as_deref()),
            ("userinfoUrl", provider.userinfo_url.as_deref()),
            ("jwksUrl", provider.jwks_url.as_deref()),
            ("issuer", provider.issuer.as_deref()),
            ("logoUrl", provider.logo_url.as_deref()),
        ] {
            let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
                continue;
            };
            let param_name = format!("{param}.{field}");
            if field == "issuer" && !(raw.starts_with("http://") || raw.starts_with("https://")) {
                return Err(invalid(
                    &param_name,
                    format!("{param_name} must be an absolute http(s) URL when set."),
                ));
            }
            url_shape(raw, &param_name)?;
        }
    }
    Ok(())
}

pub(super) fn assert_captcha(settings: &InstanceSettings) -> Result<(), OrbitError> {
    if settings.security.captcha_provider == crate::settings::types::CaptchaProvider::None {
        return Ok(());
    }
    if settings.security.captcha_secret.trim().is_empty() {
        return Err(invalid(
            "security.captchaSecret",
            "security.captchaProvider is set but security.captchaSecret is empty; the server would reject every sign-in.",
        ));
    }
    Ok(())
}
