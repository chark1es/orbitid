//! Sign-in factor discovery and verification snapshots.

use orbitid_core::error::Result;
use orbitid_core::models::{EnterpriseConnectionRow, UserRow};
use orbitid_core::resources::{SignInFactor, VerificationJson, VerificationStatus};
use orbitid_core::state::AppState;
use orbitid_credentials::mask_email;
use orbitid_identity::users::{list_emails, list_phones, primary_email, primary_phone};
use orbitid_identity::verifications::{get_verification_by_id, verification_json};

use crate::state::FactorState;

/// `factorJSON`: the verification snapshot for a factor in the sign-in state.
pub async fn factor_json(
    state: &AppState,
    factor: Option<&FactorState>,
) -> Result<Option<VerificationJson>> {
    let Some(factor) = factor else {
        return Ok(None);
    };
    if let Some(id) = &factor.verification_id {
        let row = get_verification_by_id(state, id).await?;
        if let Some(mut json) = verification_json(row.as_ref(), None) {
            json.strategy = factor.strategy.clone();
            if factor.nonce.is_some() {
                json.nonce = factor.nonce.clone();
            }
            return Ok(Some(json));
        }
    }
    Ok(Some(VerificationJson {
        status: match factor.status.as_deref() {
            Some("verified") => VerificationStatus::Verified,
            Some("transferable") => VerificationStatus::Transferable,
            Some("failed") => VerificationStatus::Failed,
            Some("expired") => VerificationStatus::Expired,
            _ => VerificationStatus::Unverified,
        },
        strategy: factor.strategy.clone(),
        attempts: None,
        expire_at: None,
        external_verification_redirect_url: factor.external_verification_redirect_url.clone(),
        error: factor
            .error
            .as_ref()
            .map(|error| orbitid_core::resources::VerificationErrorJson {
                code: error.code.clone(),
                message: error.message.clone(),
            }),
        nonce: factor.nonce.clone(),
    }))
}

/// `${phone.slice(0, -4).replace(/\d/g, "*")}${phone.slice(-4)}`.
pub fn mask_phone(phone: &str) -> String {
    let chars: Vec<char> = phone.chars().collect();
    if chars.len() <= 4 {
        return phone.to_string();
    }
    let split = chars.len() - 4;
    let mut out: String = chars[..split]
        .iter()
        .map(|c| if c.is_ascii_digit() { '*' } else { *c })
        .collect();
    out.extend(&chars[split..]);
    out
}

pub async fn verified_email_of(
    state: &AppState,
    user: &UserRow,
) -> Result<Option<orbitid_core::models::EmailAddressRow>> {
    Ok(list_emails(state, &user.id)
        .await?
        .into_iter()
        .find(|email| email.verified))
}

pub async fn verified_phone_of(
    state: &AppState,
    user: &UserRow,
) -> Result<Option<orbitid_core::models::PhoneNumberRow>> {
    Ok(list_phones(state, &user.id)
        .await?
        .into_iter()
        .find(|phone| phone.verified))
}

/// Active enterprise SSO connection whose domain matches the email.
pub async fn enterprise_connection_for_email(
    state: &AppState,
    email: &str,
) -> Result<Option<EnterpriseConnectionRow>> {
    let Some(domain) = email.split('@').nth(1).map(str::to_lowercase) else {
        return Ok(None);
    };
    let rows = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE active = true ORDER BY created_at ASC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.into_iter().find(|connection| {
        let domains: Vec<String> = connection
            .domains
            .0
            .iter()
            .map(|value| value.to_lowercase())
            .collect();
        domains.iter().any(|candidate| candidate == &domain)
            || (connection.allow_subdomains
                && domains
                    .iter()
                    .any(|candidate| domain.ends_with(&format!(".{candidate}"))))
    }))
}

/// Factors a user may use to sign in (`supported_first_factors`).
pub async fn compute_first_factors(
    state: &AppState,
    user: &UserRow,
    requested_reset: bool,
) -> Result<Vec<SignInFactor>> {
    let settings = state.settings.get();
    let mut factors = Vec::new();
    let email = match verified_email_of(state, user).await? {
        Some(email) => Some(email),
        None => primary_email(state, user).await?,
    };
    let phone = match verified_phone_of(state, user).await? {
        Some(phone) => Some(phone),
        None => primary_phone(state, user).await?,
    };
    if settings.attributes.email_address.enabled
        && settings.attributes.email_address.used_for_first_factor
    {
        if let Some(email) = email.as_ref().filter(|email| email.verified) {
            let strategies = &settings.attributes.email_address.verifications;
            let email_strategies: Vec<String> = if strategies.is_empty() {
                vec!["email_code".into()]
            } else {
                strategies.clone()
            };
            let link_enabled = email_strategies.iter().any(|value| value == "email_link")
                || email_strategies.iter().any(|value| value == "email_code");
            let primary = Some(&email.id) == user.primary_email_address_id.as_ref();
            factors.push(SignInFactor {
                strategy: "email_code".into(),
                email_address_id: Some(email.id.clone()),
                safe_identifier: Some(mask_email(&email.email)),
                phone_number_id: None,
                primary: Some(primary),
                default: None,
            });
            if link_enabled {
                factors.push(SignInFactor {
                    strategy: "email_link".into(),
                    email_address_id: Some(email.id.clone()),
                    safe_identifier: Some(mask_email(&email.email)),
                    phone_number_id: None,
                    primary: Some(primary),
                    default: None,
                });
            }
        }
    }
    if user.password_hash.is_some()
        && settings.attributes.password.enabled
        && settings.attributes.password.used_for_first_factor
    {
        factors.push(SignInFactor {
            strategy: "password".into(),
            email_address_id: None,
            safe_identifier: None,
            phone_number_id: None,
            primary: None,
            default: None,
        });
    }
    if settings.attributes.phone_number.enabled
        && settings.attributes.phone_number.used_for_first_factor
    {
        if let Some(phone) = phone.as_ref().filter(|phone| phone.verified) {
            factors.push(SignInFactor {
                strategy: "phone_code".into(),
                email_address_id: None,
                safe_identifier: Some(mask_phone(&phone.phone)),
                phone_number_id: Some(phone.id.clone()),
                primary: Some(Some(&phone.id) == user.primary_phone_number_id.as_ref()),
                default: None,
            });
        }
    }
    if settings.attributes.passkey.enabled
        && settings.attributes.passkey.used_for_first_factor
        && !orbitid_credentials::list_passkeys(&state.pool, &user.id)
            .await?
            .is_empty()
    {
        factors.push(SignInFactor {
            strategy: "passkey".into(),
            email_address_id: None,
            safe_identifier: None,
            phone_number_id: None,
            primary: None,
            default: None,
        });
    }
    for provider in orbitid_federation::list_enabled_social_providers(state) {
        if provider.authenticatable {
            factors.push(SignInFactor {
                strategy: provider.strategy,
                email_address_id: None,
                safe_identifier: None,
                phone_number_id: None,
                primary: None,
                default: None,
            });
        }
    }
    if let Some(email) = email.as_ref().filter(|email| email.verified) {
        if enterprise_connection_for_email(state, &email.email)
            .await?
            .is_some()
        {
            factors.push(SignInFactor {
                strategy: "enterprise_sso".into(),
                email_address_id: None,
                safe_identifier: None,
                phone_number_id: None,
                primary: None,
                default: None,
            });
        }
    }
    if requested_reset {
        if let Some(email) = email.as_ref().filter(|email| email.verified) {
            factors.push(SignInFactor {
                strategy: "reset_password_email_code".into(),
                email_address_id: Some(email.id.clone()),
                safe_identifier: Some(mask_email(&email.email)),
                phone_number_id: None,
                primary: None,
                default: None,
            });
        }
        if let Some(phone) = phone.as_ref().filter(|phone| phone.verified) {
            factors.push(SignInFactor {
                strategy: "reset_password_phone_code".into(),
                email_address_id: None,
                safe_identifier: Some(mask_phone(&phone.phone)),
                phone_number_id: Some(phone.id.clone()),
                primary: None,
                default: None,
            });
        }
    }
    Ok(factors)
}

pub fn supported_identifiers(state: &AppState) -> Vec<String> {
    let settings = state.settings.get();
    let mut ids = Vec::new();
    if settings.attributes.email_address.enabled
        && settings.attributes.email_address.used_for_first_factor
    {
        ids.push("email_address".to_string());
    }
    if settings.attributes.phone_number.enabled
        && settings.attributes.phone_number.used_for_first_factor
    {
        ids.push("phone_number".to_string());
    }
    if settings.attributes.username.enabled && settings.attributes.username.used_for_first_factor {
        ids.push("username".to_string());
    }
    ids
}
