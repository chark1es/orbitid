//! `GET /v1/client/environment`: the public, secret-free settings projection,
//! ported from the retired TypeScript server.
//!
//! The enabled-provider list is supplied by the federation layer (it knows the
//! display names and `oauth_<key>` strategies); core only renders it.

use serde::{Deserialize, Serialize};

use crate::settings::types::{CaptchaProvider, InstanceSettings};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SocialProviderSummary {
    pub key: String,
    pub name: String,
    pub strategy: String,
    pub authenticatable: bool,
    pub logo_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttributeJson {
    pub enabled: bool,
    pub required: bool,
    pub used_for_first_factor: bool,
    pub used_for_second_factor: bool,
    pub verifications: Vec<String>,
    pub verify_at_sign_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrustedDevicesJson {
    pub enabled: bool,
    pub days: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnonymousJson {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthConfigJson {
    pub identification_requirements: Vec<Vec<String>>,
    pub first_factors: Vec<String>,
    pub second_factors: Vec<String>,
    pub single_session_mode: bool,
    pub sign_up_mode: String,
    pub legal_consent_required: bool,
    pub trusted_devices: TrustedDevicesJson,
    pub anonymous: AnonymousJson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SocialProviderJson {
    pub enabled: bool,
    pub name: String,
    pub strategy: String,
    pub authenticatable: bool,
    pub logo_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PasswordSettingsJson {
    pub min_length: i64,
    pub max_length: i64,
    pub require_lowercase: bool,
    pub require_uppercase: bool,
    pub require_numbers: bool,
    pub require_special_char: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsernameSettingsJson {
    pub min_length: i64,
    pub max_length: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignUpJson {
    pub mode: String,
    pub progressive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionsJson {
    pub delete_self: bool,
    pub create_organization: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PasskeySettingsJson {
    pub allow_autofill: bool,
    pub show_sign_in_button: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttributesJson {
    pub email_address: AttributeJson,
    pub phone_number: AttributeJson,
    pub username: AttributeJson,
    pub first_name: AttributeJson,
    pub last_name: AttributeJson,
    pub password: AttributeJson,
    pub passkey: AttributeJson,
    pub backup_code: AttributeJson,
    pub authenticator_app: AttributeJson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UserSettingsJson {
    pub attributes: AttributesJson,
    pub social: std::collections::BTreeMap<String, SocialProviderJson>,
    pub password_settings: PasswordSettingsJson,
    pub username_settings: UsernameSettingsJson,
    pub sign_up: SignUpJson,
    pub actions: ActionsJson,
    pub passkey_settings: PasskeySettingsJson,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrganizationSettingsJson {
    pub enabled: bool,
    pub max_allowed_memberships: i64,
    pub creation_enabled: bool,
    pub domains_enabled: bool,
    pub membership_requests_enabled: bool,
    pub slug_enabled: bool,
    pub force_organization_selection: bool,
    pub creator_role: String,
    pub default_role: String,
    pub max_created_organizations_per_user: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DisplayConfigJson {
    pub application_name: String,
    pub logo_image_url: Option<String>,
    pub home_url: String,
    pub support_email: Option<String>,
    pub terms_url: Option<String>,
    pub privacy_url: Option<String>,
    pub primary_color: String,
    pub theme: String,
    pub branded: bool,
    pub captcha_enabled: bool,
    pub captcha_provider: String,
    pub captcha_site_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvironmentJson {
    pub object: String,
    pub auth_config: AuthConfigJson,
    pub user_settings: UserSettingsJson,
    pub organization_settings: OrganizationSettingsJson,
    pub display_config: DisplayConfigJson,
}

fn attribute(a: &crate::settings::types::AttributeConfig) -> AttributeJson {
    AttributeJson {
        enabled: a.enabled,
        required: a.required,
        used_for_first_factor: a.used_for_first_factor,
        used_for_second_factor: a.used_for_second_factor,
        verifications: a.verifications.clone(),
        verify_at_sign_up: a.verify_at_sign_up,
    }
}

/// Renders the environment. `social` must only contain enabled providers.
pub fn build_environment(
    settings: &InstanceSettings,
    social: &[SocialProviderSummary],
) -> EnvironmentJson {
    let st = settings;
    let mut first_factors = Vec::new();
    if st.attributes.email_address.enabled && st.attributes.email_address.used_for_first_factor {
        first_factors.push("email_code".to_string());
        let verifications = &st.attributes.email_address.verifications;
        if verifications.is_empty()
            || verifications
                .iter()
                .any(|v| v == "email_link" || v == "email_code")
        {
            first_factors.push("email_link".to_string());
        }
    }
    if st.attributes.password.enabled && st.attributes.password.used_for_first_factor {
        first_factors.push("password".to_string());
    }
    if st.attributes.phone_number.enabled && st.attributes.phone_number.used_for_first_factor {
        first_factors.push("phone_code".to_string());
    }
    if st.attributes.passkey.enabled && st.attributes.passkey.used_for_first_factor {
        first_factors.push("passkey".to_string());
    }
    for provider in social {
        first_factors.push(provider.strategy.clone());
    }

    let mut second_factors = Vec::new();
    if st.attributes.authenticator_app.enabled {
        second_factors.push("totp".to_string());
    }
    if st.attributes.phone_number.enabled && st.attributes.phone_number.used_for_second_factor {
        second_factors.push("phone_code".to_string());
    }
    if st.attributes.email_address.enabled && st.attributes.email_address.used_for_second_factor {
        second_factors.push("email_code".to_string());
    }
    if st.attributes.backup_code.enabled {
        second_factors.push("backup_code".to_string());
    }

    let mut identification = Vec::new();
    if st.attributes.email_address.enabled && st.attributes.email_address.used_for_first_factor {
        identification.push("email_address".to_string());
    }
    if st.attributes.phone_number.enabled && st.attributes.phone_number.used_for_first_factor {
        identification.push("phone_number".to_string());
    }
    if st.attributes.username.enabled && st.attributes.username.used_for_first_factor {
        identification.push("username".to_string());
    }
    if st.attributes.password.enabled {
        identification.push("password".to_string());
    }
    if st.attributes.passkey.enabled {
        identification.push("passkey".to_string());
    }
    for provider in social {
        identification.push(provider.strategy.clone());
    }

    let enabled_social = social
        .iter()
        .map(|provider| {
            (
                provider.key.clone(),
                SocialProviderJson {
                    enabled: true,
                    name: provider.name.clone(),
                    strategy: provider.strategy.clone(),
                    authenticatable: provider.authenticatable,
                    logo_url: provider.logo_url.clone(),
                },
            )
        })
        .collect();

    EnvironmentJson {
        object: "environment".to_string(),
        auth_config: AuthConfigJson {
            identification_requirements: if identification.is_empty() {
                Vec::new()
            } else {
                vec![identification]
            },
            first_factors,
            second_factors,
            single_session_mode: !st.session.multi_session,
            sign_up_mode: match st.sign_up.mode {
                crate::settings::types::SignUpMode::Public => "public",
                crate::settings::types::SignUpMode::Restricted => "restricted",
                crate::settings::types::SignUpMode::Waitlist => "waitlist",
            }
            .to_string(),
            legal_consent_required: st.sign_up.legal_consent_required,
            trusted_devices: TrustedDevicesJson {
                enabled: st.session.trusted_devices_enabled,
                days: st.session.trusted_device_days,
            },
            anonymous: AnonymousJson {
                enabled: st.anonymous.enabled,
            },
        },
        user_settings: UserSettingsJson {
            attributes: AttributesJson {
                email_address: attribute(&st.attributes.email_address),
                phone_number: attribute(&st.attributes.phone_number),
                username: attribute(&st.attributes.username),
                first_name: attribute(&st.attributes.first_name),
                last_name: attribute(&st.attributes.last_name),
                password: attribute(&st.attributes.password),
                passkey: attribute(&st.attributes.passkey),
                backup_code: attribute(&st.attributes.backup_code),
                authenticator_app: attribute(&st.attributes.authenticator_app),
            },
            social: enabled_social,
            password_settings: PasswordSettingsJson {
                min_length: st.password.min_length,
                max_length: st.password.max_length,
                require_lowercase: st.password.require_lowercase,
                require_uppercase: st.password.require_uppercase,
                require_numbers: st.password.require_numbers,
                require_special_char: st.password.require_special_character,
            },
            username_settings: UsernameSettingsJson {
                min_length: st.username.min_length,
                max_length: st.username.max_length,
            },
            sign_up: SignUpJson {
                mode: match st.sign_up.mode {
                    crate::settings::types::SignUpMode::Public => "public",
                    crate::settings::types::SignUpMode::Restricted => "restricted",
                    crate::settings::types::SignUpMode::Waitlist => "waitlist",
                }
                .to_string(),
                progressive: st.sign_up.progressive,
            },
            actions: ActionsJson {
                delete_self: st.user_settings.delete_self_enabled,
                create_organization: st.user_settings.create_organization_enabled
                    && st.organizations.enabled
                    && st.organizations.creation_enabled,
            },
            passkey_settings: PasskeySettingsJson {
                allow_autofill: true,
                show_sign_in_button: true,
            },
        },
        organization_settings: OrganizationSettingsJson {
            enabled: st.organizations.enabled,
            max_allowed_memberships: st.organizations.max_allowed_memberships,
            creation_enabled: st.organizations.enabled && st.organizations.creation_enabled,
            domains_enabled: st.organizations.domains_enabled,
            membership_requests_enabled: st.organizations.membership_requests_enabled,
            slug_enabled: st.organizations.slug_enabled,
            force_organization_selection: st.organizations.force_organization_selection,
            creator_role: st.organizations.creator_role.clone(),
            default_role: st.organizations.default_role.clone(),
            max_created_organizations_per_user: st.organizations.max_created_organizations_per_user,
        },
        display_config: DisplayConfigJson {
            application_name: st.application.name.clone(),
            logo_image_url: st.application.logo_url.clone(),
            home_url: st.application.home_url.clone(),
            support_email: st.application.support_email.clone(),
            terms_url: st.application.terms_url.clone(),
            privacy_url: st.application.privacy_url.clone(),
            primary_color: st.branding.primary_color.clone(),
            theme: match st.branding.theme {
                crate::settings::types::Theme::Light => "light",
                crate::settings::types::Theme::Dark => "dark",
                crate::settings::types::Theme::System => "system",
            }
            .to_string(),
            // OrbitID shows no attribution line on its components.
            branded: false,
            captcha_enabled: st.security.captcha_provider != CaptchaProvider::None
                && !st.security.captcha_secret.is_empty(),
            captcha_provider: match st.security.captcha_provider {
                CaptchaProvider::None => "none",
                CaptchaProvider::Turnstile => "turnstile",
                CaptchaProvider::Hcaptcha => "hcaptcha",
            }
            .to_string(),
            captcha_site_key: st.security.captcha_site_key.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_defaults() {
        let environment = build_environment(&InstanceSettings::default(), &[]);
        assert_eq!(environment.object, "environment");
        assert_eq!(
            environment.auth_config.identification_requirements,
            vec![vec!["email_address".to_string(), "password".to_string()]]
        );
        assert_eq!(
            environment.auth_config.first_factors,
            vec![
                "email_code".to_string(),
                "email_link".to_string(),
                "password".to_string()
            ]
        );
        assert_eq!(environment.display_config.application_name, "OrbitID App");
    }

    #[test]
    fn social_providers_become_factors() {
        let social = vec![SocialProviderSummary {
            key: "google".into(),
            name: "Google".into(),
            strategy: "oauth_google".into(),
            authenticatable: true,
            logo_url: String::new(),
        }];
        let environment = build_environment(&InstanceSettings::default(), &social);
        assert!(environment
            .auth_config
            .first_factors
            .contains(&"oauth_google".to_string()));
        assert_eq!(environment.user_settings.social["google"].name, "Google");
    }
}
