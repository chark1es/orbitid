//! `GET /v1/client/environment`: the public, secret-free environment projection
//! used to render every UI component. Ported from `modules/environment.ts`.

use axum::extract::State;
use orbitid_core::settings::types::{AttributeConfig, InstanceSettings};
use orbitid_core::state::AppState;
use serde_json::{json, Map, Value};

fn attribute_json(attribute: &AttributeConfig) -> Value {
    json!({
        "enabled": attribute.enabled,
        "required": attribute.required,
        "used_for_first_factor": attribute.used_for_first_factor,
        "used_for_second_factor": attribute.used_for_second_factor,
        "verifications": attribute.verifications,
        "verify_at_sign_up": attribute.verify_at_sign_up,
    })
}

/// Builds the environment JSON (public and secret-free).
pub fn build_environment(state: &AppState) -> Value {
    let settings: std::sync::Arc<InstanceSettings> = state.settings.get();
    let social = orbitid_federation::list_enabled_social_providers(state);
    let mut enabled_social = Map::new();
    for provider in &social {
        enabled_social.insert(
            provider.key.clone(),
            json!({
                "enabled": true,
                "name": provider.name,
                "strategy": provider.strategy,
                "authenticatable": provider.authenticatable,
                "logo_url": provider.logo_url,
            }),
        );
    }

    let attributes = &settings.attributes;
    let mut first_factors: Vec<String> = Vec::new();
    if attributes.email_address.enabled && attributes.email_address.used_for_first_factor {
        first_factors.push("email_code".into());
        let verifications = &attributes.email_address.verifications;
        if verifications.is_empty()
            || verifications.iter().any(|value| value == "email_link")
            || verifications.iter().any(|value| value == "email_code")
        {
            first_factors.push("email_link".into());
        }
    }
    if attributes.password.enabled && attributes.password.used_for_first_factor {
        first_factors.push("password".into());
    }
    if attributes.phone_number.enabled && attributes.phone_number.used_for_first_factor {
        first_factors.push("phone_code".into());
    }
    if attributes.passkey.enabled && attributes.passkey.used_for_first_factor {
        first_factors.push("passkey".into());
    }
    for provider in &social {
        first_factors.push(provider.strategy.clone());
    }

    let mut second_factors: Vec<String> = Vec::new();
    if attributes.authenticator_app.enabled {
        second_factors.push("totp".into());
    }
    if attributes.phone_number.enabled && attributes.phone_number.used_for_second_factor {
        second_factors.push("phone_code".into());
    }
    if attributes.email_address.enabled && attributes.email_address.used_for_second_factor {
        second_factors.push("email_code".into());
    }
    if attributes.backup_code.enabled {
        second_factors.push("backup_code".into());
    }

    let mut identification: Vec<String> = Vec::new();
    if attributes.email_address.enabled && attributes.email_address.used_for_first_factor {
        identification.push("email_address".into());
    }
    if attributes.phone_number.enabled && attributes.phone_number.used_for_first_factor {
        identification.push("phone_number".into());
    }
    if attributes.username.enabled && attributes.username.used_for_first_factor {
        identification.push("username".into());
    }
    if attributes.password.enabled {
        identification.push("password".into());
    }
    if attributes.passkey.enabled {
        identification.push("passkey".into());
    }
    for provider in &social {
        identification.push(provider.strategy.clone());
    }
    let identification_requirements = if identification.is_empty() {
        json!([])
    } else {
        json!([identification])
    };

    json!({
        "object": "environment",
        "auth_config": {
            "identification_requirements": identification_requirements,
            "first_factors": first_factors,
            "second_factors": second_factors,
            "single_session_mode": !settings.session.multi_session,
            "sign_up_mode": settings.sign_up.mode,
            "legal_consent_required": settings.sign_up.legal_consent_required,
            "trusted_devices": {
                "enabled": settings.session.trusted_devices_enabled,
                "days": settings.session.trusted_device_days,
            },
            "anonymous": { "enabled": settings.anonymous.enabled },
        },
        "user_settings": {
            "attributes": {
                "email_address": attribute_json(&attributes.email_address),
                "phone_number": attribute_json(&attributes.phone_number),
                "username": attribute_json(&attributes.username),
                "first_name": attribute_json(&attributes.first_name),
                "last_name": attribute_json(&attributes.last_name),
                "password": attribute_json(&attributes.password),
                "passkey": attribute_json(&attributes.passkey),
                "backup_code": attribute_json(&attributes.backup_code),
                "authenticator_app": attribute_json(&attributes.authenticator_app),
            },
            "social": enabled_social,
            "password_settings": {
                "min_length": settings.password.min_length,
                "max_length": settings.password.max_length,
                "require_lowercase": settings.password.require_lowercase,
                "require_uppercase": settings.password.require_uppercase,
                "require_numbers": settings.password.require_numbers,
                "require_special_char": settings.password.require_special_character,
            },
            "username_settings": {
                "min_length": settings.username.min_length,
                "max_length": settings.username.max_length,
            },
            "sign_up": {
                "mode": settings.sign_up.mode,
                "progressive": settings.sign_up.progressive,
            },
            "actions": {
                "delete_self": settings.user_settings.delete_self_enabled,
                "create_organization": settings.user_settings.create_organization_enabled
                    && settings.organizations.enabled
                    && settings.organizations.creation_enabled,
            },
            "passkey_settings": {
                "allow_autofill": true,
                "show_sign_in_button": true,
            },
        },
        "organization_settings": {
            "enabled": settings.organizations.enabled,
            "max_allowed_memberships": settings.organizations.max_allowed_memberships,
            "creation_enabled": settings.organizations.enabled
                && settings.organizations.creation_enabled,
            "domains_enabled": settings.organizations.domains_enabled,
            "membership_requests_enabled": settings.organizations.membership_requests_enabled,
            "slug_enabled": settings.organizations.slug_enabled,
            "force_organization_selection": settings.organizations.force_organization_selection,
            "creator_role": settings.organizations.creator_role,
            "default_role": settings.organizations.default_role,
            "max_created_organizations_per_user": settings.organizations.max_created_organizations_per_user,
        },
        "display_config": {
            "application_name": settings.application.name,
            "logo_image_url": settings.application.logo_url,
            "home_url": settings.application.home_url,
            "support_email": settings.application.support_email,
            "terms_url": settings.application.terms_url,
            "privacy_url": settings.application.privacy_url,
            "primary_color": settings.branding.primary_color,
            "theme": settings.branding.theme,
            "branded": settings.branding.show_powered_by,
            "captcha_enabled": settings.security.captcha_provider
                != orbitid_core::settings::types::CaptchaProvider::None
                && !settings.security.captcha_secret.is_empty(),
            "captcha_provider": settings.security.captcha_provider,
            "captcha_site_key": settings.security.captcha_site_key,
        },
    })
}

/// `GET /v1/client/environment` with `Cache-Control: public, max-age=60`.
pub async fn environment(State(state): State<AppState>) -> crate::util::Reply {
    crate::util::Reply::json(build_environment(&state))
        .header("Cache-Control", "public, max-age=60")
}
