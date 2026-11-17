//! Identifier availability and instance restriction checks for sign-up.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;
use orbitid_identity::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};
use orbitid_identity::users::{find_email, normalize_email};

use crate::state::SignUpFields;

fn matches_domain_pattern(identifier: &str, pattern: &str) -> bool {
    let Some(domain) = identifier.split('@').nth(1).map(str::to_lowercase) else {
        return false;
    };
    let trimmed = pattern
        .trim_start_matches('*')
        .trim_start_matches('@')
        .to_lowercase();
    if pattern.starts_with('@') || pattern.starts_with("*@") {
        domain == trimmed || domain.ends_with(&format!(".{trimmed}"))
    } else {
        identifier.to_lowercase() == pattern.to_lowercase()
    }
}

#[derive(Debug, Clone, Default)]
pub struct SignUpIdentifierOptions {
    pub ticket: bool,
    pub invitation_ticket: Option<String>,
    pub verified_email: bool,
}

/// Rejects identifiers already claimed or blocked by instance restrictions.
pub async fn assert_sign_up_identifiers(
    state: &AppState,
    fields: &SignUpFields,
    opts: &SignUpIdentifierOptions,
) -> Result<()> {
    let settings = state.settings.get();
    let email = fields.email_address.as_deref().map(normalize_email);
    if fields.phone_number.is_some() && !settings.attributes.phone_number.enabled {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_UNKNOWN,
            "Phone numbers are disabled for this instance",
        )
        .with_meta(serde_json::json!({ "param_name": "phone_number" })));
    }
    if fields.username.is_some() && !settings.attributes.username.enabled {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_UNKNOWN,
            "Usernames are disabled for this instance",
        )
        .with_meta(serde_json::json!({ "param_name": "username" })));
    }
    if let Some(email) = &email {
        let holder = find_email(state, email).await?;
        let will_verify =
            settings.attributes.email_address.verify_at_sign_up || opts.verified_email;
        if holder
            .as_ref()
            .map(|holder| holder.verified || (!will_verify && holder.user_id.is_some()))
            .unwrap_or(false)
        {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "That email address is already in use",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
        if !settings.attributes.email_address.enabled {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_UNKNOWN,
                "Email addresses are disabled for this instance",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
        if settings.restrictions.block_email_subaddresses {
            let local = email.split('@').next().unwrap_or_default();
            if local.contains('+') {
                return Err(OrbitError::unprocessable(
                    error_codes::IDENTIFIER_NOT_ALLOWED,
                    "Email subaddresses are not allowed",
                )
                .with_meta(serde_json::json!({ "param_name": "email_address" })));
            }
        }
        let blocked: Vec<String> =
            sqlx::query_scalar("SELECT identifier FROM blocklist_identifiers")
                .fetch_all(&state.pool)
                .await?;
        if blocked
            .iter()
            .any(|pattern| matches_domain_pattern(email, pattern))
        {
            return Err(OrbitError::unprocessable(
                error_codes::IDENTIFIER_NOT_ALLOWED,
                "This identifier is not allowed",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
        let allowlisted: Vec<String> =
            sqlx::query_scalar("SELECT identifier FROM allowlist_identifiers")
                .fetch_all(&state.pool)
                .await?;
        let allowlisted = allowlisted
            .iter()
            .any(|pattern| matches_domain_pattern(email, pattern));
        if !opts.ticket {
            if settings.restrictions.allowlist_enabled && !allowlisted {
                return Err(OrbitError::unprocessable(
                    error_codes::SIGN_UP_RESTRICTED,
                    "Sign-ups are restricted to allowlisted identifiers",
                )
                .with_meta(serde_json::json!({ "param_name": "email_address" })));
            }
            if settings.sign_up.mode == orbitid_core::settings::types::SignUpMode::Waitlist {
                return Err(OrbitError::unprocessable(
                    error_codes::WAITLIST_MODE,
                    "Sign-ups are currently limited to the waitlist",
                )
                .with_meta(serde_json::json!({ "param_name": "email_address" })));
            }
            if settings.sign_up.mode == orbitid_core::settings::types::SignUpMode::Restricted
                && !allowlisted
            {
                return Err(OrbitError::unprocessable(
                    error_codes::SIGN_UP_RESTRICTED,
                    "Sign-ups are restricted on this instance",
                )
                .with_meta(serde_json::json!({ "param_name": "email_address" })));
            }
        }
    }
    assert_identifiers_allowed(
        state,
        &IdentifiersToCheck {
            emails: email.into_iter().collect(),
            phones: fields.phone_number.clone().into_iter().collect(),
            invitation_ticket: opts.invitation_ticket.clone(),
        },
        false,
    )
    .await?;
    Ok(())
}
