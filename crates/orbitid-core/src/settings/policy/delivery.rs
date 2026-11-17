use super::validation::*;
use crate::error::OrbitError;
use crate::settings::types::{EmailProvider, InstanceSettings, SmsProvider};

pub fn email_delivery_required(settings: &InstanceSettings) -> bool {
    let a = &settings.attributes.email_address;
    a.enabled && (a.used_for_first_factor || a.used_for_second_factor || a.verify_at_sign_up)
}

pub fn sms_delivery_required(settings: &InstanceSettings) -> bool {
    let a = &settings.attributes.phone_number;
    a.enabled && (a.used_for_first_factor || a.used_for_second_factor || a.verify_at_sign_up)
}

/// The provider the mail resolver would pick.
pub fn effective_email_provider(
    settings: &InstanceSettings,
    env: &DeliveryEnvironment,
) -> EmailProvider {
    let email = &settings.email;
    if email.provider != EmailProvider::Auto {
        return email.provider;
    }
    let resend = if email.resend_api_key.is_empty() {
        env.resend_api_key.clone().unwrap_or_default()
    } else {
        email.resend_api_key.clone()
    };
    let smtp = if email.smtp_url.is_empty() {
        env.smtp_url.clone().unwrap_or_default()
    } else {
        email.smtp_url.clone()
    };
    if !resend.trim().is_empty() {
        EmailProvider::Resend
    } else if !smtp.trim().is_empty() {
        EmailProvider::Smtp
    } else {
        EmailProvider::Console
    }
}

pub(super) fn is_test_environment(node_env: &str) -> bool {
    node_env == "test" || std::env::var("NODE_ENV").as_deref() == Ok("test")
}

pub(super) fn assert_production_delivery(
    settings: &InstanceSettings,
    node_env: &str,
    env: &DeliveryEnvironment,
) -> Result<(), OrbitError> {
    if node_env != "production" || is_test_environment(node_env) {
        return Ok(());
    }
    if email_delivery_required(settings)
        && effective_email_provider(settings, env) == EmailProvider::Console
    {
        return Err(invalid(
            "email.provider",
            "E-mail sign-in is enabled but no e-mail provider is configured. Set email.resendApiKey or email.smtpUrl (or ORBITID_RESEND_API_KEY / ORBITID_SMTP_URL) before saving.",
        ));
    }
    if sms_delivery_required(settings) && settings.sms.provider == SmsProvider::Console {
        return Err(invalid(
            "sms.provider",
            "Phone sign-in is enabled but sms.provider is console. Configure Twilio or the SMS webhook before saving.",
        ));
    }
    Ok(())
}
