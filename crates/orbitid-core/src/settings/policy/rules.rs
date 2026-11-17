use super::delivery::*;
use super::validation::*;
use crate::error::OrbitError;
#[cfg(test)]
use crate::settings::types::EmailProvider;
use crate::settings::types::InstanceSettings;

fn assert_attributes_usable(settings: &mut InstanceSettings) -> Result<(), OrbitError> {
    let email = &settings.attributes.email_address;
    for strategy in &email.verifications {
        if strategy != "email_code" && strategy != "email_link" {
            return Err(invalid(
                "attributes.emailAddress.verifications",
                format!("attributes.emailAddress.verifications contains \"{strategy}\"; only email_code and email_link are valid for an email address."),
            ));
        }
    }
    for strategy in &settings.attributes.phone_number.verifications {
        if strategy != "phone_code" {
            return Err(invalid(
                "attributes.phoneNumber.verifications",
                format!("attributes.phoneNumber.verifications contains \"{strategy}\"; only phone_code is valid for a phone number."),
            ));
        }
    }
    let email = &settings.attributes.email_address;
    if email.enabled
        && (email.verify_at_sign_up || email.used_for_first_factor || email.used_for_second_factor)
        && email.verifications.is_empty()
    {
        return Err(invalid(
            "attributes.emailAddress.verifications",
            "attributes.emailAddress needs at least one verification strategy (email_code or email_link) when it is verified, a first factor or a second factor.",
        ));
    }
    let phone = &settings.attributes.phone_number;
    if phone.enabled
        && (phone.used_for_first_factor || phone.used_for_second_factor)
        && phone.verifications.is_empty()
    {
        settings.attributes.phone_number.verifications = vec!["phone_code".to_string()];
    }
    let can_sign_in = email.enabled
        || settings.attributes.phone_number.enabled
        || settings.attributes.username.enabled
        || settings.attributes.password.enabled
        || settings.attributes.passkey.enabled;
    if !can_sign_in {
        return Err(invalid(
            "attributes",
            "Every attribute is disabled, so nobody could sign up or sign in. Enable at least one of email address, phone number, username, password or passkey.",
        ));
    }
    let a = &settings.attributes;
    if a.password.enabled
        && a.password.required
        && !a.password.used_for_first_factor
        && !a.email_address.enabled
        && !a.phone_number.enabled
        && !a.username.enabled
        && !a.passkey.enabled
    {
        return Err(invalid(
            "attributes.password",
            "A required password with no identifier cannot be created through sign-up.",
        ));
    }
    Ok(())
}

fn assert_password_policy(settings: &InstanceSettings) -> Result<(), OrbitError> {
    let policy = &settings.password;
    if policy.min_length < 1 || policy.max_length < policy.min_length || policy.max_length > 72 {
        return Err(invalid(
            "password",
            "password.maxLength must be between password.minLength and 72 (bcrypt's limit), and minLength at least 1.",
        ));
    }
    Ok(())
}

fn assert_session_policy(settings: &InstanceSettings) -> Result<(), OrbitError> {
    let session = &settings.session;
    if session.lifetime_seconds < 0 {
        return Err(invalid(
            "session.lifetimeSeconds",
            "session.lifetimeSeconds must be 0 (no maximum lifetime) or greater.",
        ));
    }
    if session.token_lifetime_seconds <= 0 {
        return Err(invalid(
            "session.tokenLifetimeSeconds",
            "session.tokenLifetimeSeconds must be greater than 0.",
        ));
    }
    if session.lifetime_seconds > 0 && session.token_lifetime_seconds > session.lifetime_seconds {
        return Err(invalid(
            "session.tokenLifetimeSeconds",
            "session.tokenLifetimeSeconds cannot exceed session.lifetimeSeconds.",
        ));
    }
    if session.inactivity_timeout_seconds < 0 {
        return Err(invalid(
            "session.inactivityTimeoutSeconds",
            "session.inactivityTimeoutSeconds must be 0 (disabled) or greater.",
        ));
    }
    Ok(())
}

fn assert_organization_role_settings(settings: &InstanceSettings) -> Result<(), OrbitError> {
    let orgs = &settings.organizations;
    for (field, key) in [
        ("creatorRole", orgs.creator_role.as_str()),
        ("defaultRole", orgs.default_role.as_str()),
    ] {
        if !key.starts_with("org:") {
            return Err(invalid(
                &format!("organizations.{field}"),
                format!("organizations.{field} must be an organization role key (\"org:...\"), not \"{key}\"."),
            ));
        }
    }
    if orgs.max_allowed_memberships < 0 {
        return Err(invalid(
            "organizations.maxAllowedMemberships",
            "organizations.maxAllowedMemberships must be 0 (no limit) or greater.",
        ));
    }
    if orgs
        .max_created_organizations_per_user
        .is_some_and(|value| value < 0)
    {
        return Err(invalid(
            "organizations.maxCreatedOrganizationsPerUser",
            "organizations.maxCreatedOrganizationsPerUser must be null (no limit) or at least 0.",
        ));
    }
    Ok(())
}

/// Disabled features are locked: their sub-switches are forced off.
pub fn normalize_settings(settings: &mut InstanceSettings) {
    if !settings.organizations.enabled {
        settings.organizations.creation_enabled = false;
        settings.organizations.domains_enabled = false;
        settings.organizations.membership_requests_enabled = false;
        settings.organizations.force_organization_selection = false;
        settings.user_settings.create_organization_enabled = false;
    } else if !settings.organizations.creation_enabled {
        settings.user_settings.create_organization_enabled = false;
    }
    let attrs = [
        &mut settings.attributes.email_address,
        &mut settings.attributes.phone_number,
        &mut settings.attributes.username,
        &mut settings.attributes.first_name,
        &mut settings.attributes.last_name,
        &mut settings.attributes.password,
        &mut settings.attributes.passkey,
        &mut settings.attributes.backup_code,
        &mut settings.attributes.authenticator_app,
    ];
    for attribute in attrs {
        if attribute.enabled {
            continue;
        }
        attribute.required = false;
        attribute.used_for_first_factor = false;
        attribute.used_for_second_factor = false;
        attribute.verify_at_sign_up = false;
    }
    if settings.security.captcha_provider == crate::settings::types::CaptchaProvider::None {
        settings.security.captcha_site_key.clear();
    }
}

/// Throws a 422 naming the offending field when the settings cannot be served.
pub fn assert_settings_usable(
    settings: &mut InstanceSettings,
    node_env: &str,
    env: &DeliveryEnvironment,
) -> Result<(), OrbitError> {
    assert_attribute_consistency(settings)?;
    assert_attributes_usable(settings)?;
    assert_email_transport_shape(settings, env)?;
    assert_sms_transport_shape(settings)?;
    assert_social_providers(settings)?;
    assert_captcha(settings)?;
    assert_password_policy(settings)?;
    assert_session_policy(settings)?;
    assert_organization_role_settings(settings)?;
    assert_production_delivery(settings, node_env, env)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> InstanceSettings {
        let mut settings = InstanceSettings::default();
        normalize_settings(&mut settings);
        settings
    }

    fn assert_ok(settings: &mut InstanceSettings) {
        assert!(
            assert_settings_usable(settings, "test", &DeliveryEnvironment::default()).is_ok(),
            "expected settings to be usable"
        );
    }

    #[test]
    fn default_settings_are_usable() {
        assert_ok(&mut settings());
    }

    #[test]
    fn organization_sub_switches_are_forced_off() {
        let mut s = settings();
        s.organizations.creation_enabled = true;
        normalize_settings(&mut s);
        assert!(!s.organizations.creation_enabled);
        assert!(!s.user_settings.create_organization_enabled);
    }

    #[test]
    fn required_disabled_attribute_is_refused() {
        let mut s = settings();
        s.attributes.phone_number.enabled = false;
        s.attributes.phone_number.required = true;
        let error =
            assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).unwrap_err();
        assert!(error.message.contains("phoneNumber.required"));
    }

    #[test]
    fn email_provider_requires_configuration() {
        let mut s = settings();
        s.email.provider = EmailProvider::Smtp;
        let error =
            assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).unwrap_err();
        assert!(error.message.contains("SMTP URL"));

        let mut s = settings();
        s.email.provider = EmailProvider::Resend;
        let error =
            assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).unwrap_err();
        assert!(error.message.contains("API key"));
    }

    #[test]
    fn social_provider_validation() {
        let mut s = settings();
        s.social.insert(
            "google".into(),
            crate::settings::types::SocialProviderConfig {
                enabled: true,
                client_id: "id".into(),
                client_secret: "secret".into(),
                ..Default::default()
            },
        );
        assert_ok(&mut s);

        let mut s = settings();
        s.social.insert(
            "custom_test".into(),
            crate::settings::types::SocialProviderConfig {
                enabled: true,
                client_id: "id".into(),
                pkce: Some(true),
                ..Default::default()
            },
        );
        let error =
            assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).unwrap_err();
        assert!(error.message.contains("discoveryUrl"));
    }

    #[test]
    fn password_and_session_policies() {
        let mut s = settings();
        s.password.max_length = 100;
        assert!(assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).is_err());

        let mut s = settings();
        s.session.token_lifetime_seconds = 0;
        assert!(assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).is_err());

        let mut s = settings();
        s.session.lifetime_seconds = 10;
        s.session.token_lifetime_seconds = 60;
        assert!(assert_settings_usable(&mut s, "test", &DeliveryEnvironment::default()).is_err());
    }

    #[test]
    fn effective_provider_prefers_resend_then_smtp() {
        let s = settings();
        assert_eq!(
            effective_email_provider(&s, &DeliveryEnvironment::default()),
            EmailProvider::Console
        );
        let env = DeliveryEnvironment {
            smtp_url: Some("smtp://host".into()),
            ..Default::default()
        };
        assert_eq!(effective_email_provider(&s, &env), EmailProvider::Smtp);
        let env = DeliveryEnvironment {
            resend_api_key: Some("re_x".into()),
            smtp_url: Some("smtp://host".into()),
            ..Default::default()
        };
        assert_eq!(effective_email_provider(&s, &env), EmailProvider::Resend);
    }
}
