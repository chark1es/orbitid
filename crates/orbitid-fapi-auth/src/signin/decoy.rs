//! Enumeration protection for sign-in.
//!
//! With `security.enumerationProtection` on, an identifier that matches no account does not get
//! `form_identifier_not_found`. It gets a sign-in shaped like one for a typical account: a verified
//! email or phone (whichever the identifier is) and a password. The form moves on to the password step
//! exactly as it would for a real user, and every attempt then fails with the error a wrong password or
//! code produces. Codes are issued as real verification rows, so the verification snapshot and the
//! attempt limit behave the same, but nothing is ever sent and no code is ever accepted.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::SignInRow;
use orbitid_core::resources::SignInFactor;
use orbitid_core::state::AppState;
use orbitid_credentials::mask_email;
use orbitid_identity::code_check::{check_code_on, commit_code_refusal, CodeCheck};
use orbitid_identity::users::{
    detect_identifier_type, normalize_email, normalize_phone, IdentifierType,
};
use orbitid_identity::verifications::{issue_verification_on, purposes, IssueVerificationInput};
use orbitid_identity::verifications_fapi::get_verification_on;

use crate::signin::core::{
    as_sign_in_state, mask_phone, transition_sign_in, transition_sign_in_on, SignInTransition,
};
use crate::signin::helpers::spend_password_check;
use crate::signin::shared::PrepareFirstBody;
use crate::state::{DecoyState, FactorState, SignInState};
use crate::util::validate_redirect_url;

/// True when enumeration protection answered this sign-in with a stand-in.
pub fn is_decoy(row: &SignInRow) -> bool {
    row.user_id.is_none() && as_sign_in_state(row).decoy.is_some()
}

/// Turns a fresh sign-in for an unknown identifier into a decoy waiting for its first factor.
pub async fn start(
    state: &AppState,
    row: &SignInRow,
    identifier: &str,
    base: SignInState,
    strategy: Option<&str>,
) -> Result<()> {
    let decoy = match detect_identifier_type(identifier) {
        IdentifierType::EmailAddress => DecoyState {
            email_id: Some(new_id(id_prefix::EMAIL)),
            phone_id: None,
        },
        IdentifierType::PhoneNumber => DecoyState {
            email_id: None,
            phone_id: Some(new_id(id_prefix::PHONE)),
        },
        _ => DecoyState::default(),
    };
    let mut next = base;
    next.requested_reset = strategy
        .is_some_and(|value| value.starts_with("reset_password"))
        .then_some(true);
    next.first = strategy.map(|value| FactorState::new(value).status("unverified"));
    next.decoy = Some(decoy);
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&next),
            identifier: Some(identifier),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

fn safe_email(identifier: &str) -> String {
    mask_email(&normalize_email(identifier))
}

fn safe_phone(identifier: &str) -> String {
    mask_phone(&normalize_phone(identifier).unwrap_or_else(|_| identifier.trim().to_string()))
}

/// `supported_first_factors` for a decoy, in the order `compute_first_factors` lists a real account's.
pub fn first_factors(
    state: &AppState,
    identifier: &str,
    decoy: &DecoyState,
    requested_reset: bool,
) -> Vec<SignInFactor> {
    let settings = state.settings.get();
    let factor = |strategy: &str| SignInFactor {
        strategy: strategy.into(),
        email_address_id: None,
        safe_identifier: None,
        phone_number_id: None,
        primary: None,
        default: None,
    };
    let mut factors = Vec::new();
    let email = &settings.attributes.email_address;
    if let Some(email_id) = decoy
        .email_id
        .as_ref()
        .filter(|_| email.enabled && email.used_for_first_factor)
    {
        let strategies: Vec<String> = if email.verifications.is_empty() {
            vec!["email_code".into()]
        } else {
            email.verifications.clone()
        };
        let link_enabled = strategies
            .iter()
            .any(|value| value == "email_link" || value == "email_code");
        let mut code = factor("email_code");
        code.email_address_id = Some(email_id.clone());
        code.safe_identifier = Some(safe_email(identifier));
        code.primary = Some(true);
        if link_enabled {
            let mut link = code.clone();
            link.strategy = "email_link".into();
            factors.push(code);
            factors.push(link);
        } else {
            factors.push(code);
        }
    }
    if settings.attributes.password.enabled && settings.attributes.password.used_for_first_factor {
        factors.push(factor("password"));
    }
    let phone = &settings.attributes.phone_number;
    if let Some(phone_id) = decoy
        .phone_id
        .as_ref()
        .filter(|_| phone.enabled && phone.used_for_first_factor)
    {
        let mut code = factor("phone_code");
        code.phone_number_id = Some(phone_id.clone());
        code.safe_identifier = Some(safe_phone(identifier));
        code.primary = Some(true);
        factors.push(code);
    }
    for provider in orbitid_federation::list_enabled_social_providers(state) {
        if provider.authenticatable {
            factors.push(factor(&provider.strategy));
        }
    }
    if requested_reset {
        if let Some(email_id) = &decoy.email_id {
            let mut reset = factor("reset_password_email_code");
            reset.email_address_id = Some(email_id.clone());
            reset.safe_identifier = Some(safe_email(identifier));
            factors.push(reset);
        }
        if let Some(phone_id) = &decoy.phone_id {
            let mut reset = factor("reset_password_phone_code");
            reset.phone_number_id = Some(phone_id.clone());
            reset.safe_identifier = Some(safe_phone(identifier));
            factors.push(reset);
        }
    }
    factors
}

fn not_enabled(strategy: &str) -> OrbitError {
    OrbitError::bad_request(
        error_codes::STRATEGY_FOR_USER_INVALID,
        format!("Sign-in with \"{strategy}\" is not enabled for this account"),
    )
    .with_meta(serde_json::json!({ "param_name": "strategy" }))
}

/// `prepare_first_factor` for a decoy. Issues the code or link like a real prepare and sends nothing.
pub async fn prepare(
    state: &AppState,
    row: &SignInRow,
    strategy: &str,
    body: &PrepareFirstBody,
) -> Result<()> {
    let mut current = as_sign_in_state(row);
    let decoy = current.decoy.clone().unwrap_or_default();
    let identifier = row.identifier.clone().unwrap_or_default();
    let offered = first_factors(state, &identifier, &decoy, true);
    if !offered.iter().any(|factor| factor.strategy == strategy) {
        return Err(not_enabled(strategy));
    }
    if body
        .email_address_id
        .as_ref()
        .is_some_and(|id| Some(id) != decoy.email_id.as_ref())
    {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Email address not found",
        ));
    }
    if body
        .phone_number_id
        .as_ref()
        .is_some_and(|id| Some(id) != decoy.phone_id.as_ref())
    {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Phone number not found",
        ));
    }
    let settings = state.settings.get();
    let is_reset = strategy.starts_with("reset_password");
    let (channel, target, lifetime, email_id, phone_id) = match strategy {
        "password" => {
            current.first = Some(FactorState::new("password").status("unverified"));
            transition_sign_in(
                state,
                row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&current),
                    ..Default::default()
                },
            )
            .await?;
            return Ok(());
        }
        "email_code" | "reset_password_email_code" => (
            "email_code",
            normalize_email(&identifier),
            settings.email.code_lifetime_seconds,
            decoy.email_id.clone(),
            None,
        ),
        "email_link" => (
            "email_link",
            normalize_email(&identifier),
            settings.email.link_lifetime_seconds,
            decoy.email_id.clone(),
            None,
        ),
        "phone_code" | "reset_password_phone_code" => (
            "phone_code",
            normalize_phone(&identifier).unwrap_or_else(|_| identifier.trim().to_string()),
            settings.email.code_lifetime_seconds,
            None,
            decoy.phone_id.clone(),
        ),
        _ => return Err(not_enabled(strategy)),
    };
    let mut issue = IssueVerificationInput::new(
        if is_reset {
            purposes::RESET_PASSWORD
        } else {
            purposes::SIGN_IN_FIRST_FACTOR
        },
        channel,
        &target,
        &row.id,
        lifetime,
    );
    if channel == "email_link" {
        issue.redirect_url =
            validate_redirect_url(state, body.redirect_url.as_deref(), "redirect_url")?
                .or_else(|| current.redirect_url.clone());
    }
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
    orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
    let issued = issue_verification_on(&mut tx, state, issue).await?;
    current.first = Some(FactorState {
        strategy: strategy.to_string(),
        verification_id: Some(issued.row.id.clone()),
        email_id,
        phone_id,
        status: Some("unverified".into()),
        ..Default::default()
    });
    if channel != "email_link" {
        current.requested_reset = is_reset.then_some(true);
    }
    transition_sign_in_on(
        &mut tx,
        row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&current),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// What an attempt on a decoy answers instead of `Ok`: `None` means "respond with the sign-in unchanged"
/// (an email link that is never clicked keeps polling), `Some` is the error a real wrong guess returns.
pub async fn attempt(
    state: &AppState,
    row: &SignInRow,
    strategy: &str,
    password: Option<&str>,
    code: Option<&str>,
) -> Result<Option<OrbitError>> {
    let current = as_sign_in_state(row);
    let decoy = current.decoy.clone().unwrap_or_default();
    let identifier = row.identifier.clone().unwrap_or_default();
    if !first_factors(state, &identifier, &decoy, true)
        .iter()
        .any(|factor| factor.strategy == strategy)
    {
        return Ok(Some(not_enabled(strategy)));
    }
    match strategy {
        "password" => {
            let Some(password) = password.filter(|value| !value.is_empty()) else {
                return Ok(Some(
                    OrbitError::unprocessable(
                        error_codes::FORM_PARAM_MISSING,
                        "password is missing",
                    )
                    .with_meta(serde_json::json!({ "param_name": "password" })),
                ));
            };
            // The same hashing work as checking a real password.
            spend_password_check(None, Some(password)).await;
            Ok(Some(password_incorrect(row)))
        }
        "email_link" => Ok(None),
        "email_code" | "phone_code" | "reset_password_email_code" | "reset_password_phone_code" => {
            let purpose = if strategy.starts_with("reset_password") {
                purposes::RESET_PASSWORD
            } else {
                purposes::SIGN_IN_FIRST_FACTOR
            };
            let prepared = current
                .first
                .as_ref()
                .is_some_and(|first| first.strategy == strategy && first.verification_id.is_some());
            if !prepared && strategy.starts_with("reset_password") {
                return Ok(Some(
                    OrbitError::bad_request(
                        error_codes::CLIENT_STATE_INVALID,
                        "No matching password recovery is in progress",
                    )
                    .with_meta(serde_json::json!({ "param_name": "strategy" })),
                ));
            }
            let mut tx = state.pool.begin().await?;
            orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
            orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
            let verification = get_verification_on(&mut tx, purpose, &row.id, None).await?;
            // Counts the attempt and refuses like a real check: wrong code, then too many attempts, then expired.
            match check_code_on(&mut tx, state, verification.as_ref(), code).await? {
                CodeCheck::Refused(refusal) => Ok(Some(commit_code_refusal(tx, refusal).await?)),
                // Never sent, so a match is a guess (or a fixed testing code). It still does not sign in.
                CodeCheck::Verified(_) => {
                    tx.rollback().await?;
                    Ok(Some(
                        OrbitError::unprocessable(
                            error_codes::FORM_CODE_INCORRECT,
                            "That verification code is incorrect",
                        )
                        .with_meta(serde_json::json!({ "param_name": "code" })),
                    ))
                }
            }
        }
        _ => Ok(Some(not_enabled(strategy))),
    }
}

/// The error a wrong password on a real account returns.
pub fn password_incorrect(row: &SignInRow) -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PASSWORD_INCORRECT,
        "Password is incorrect",
    )
    .with_meta(serde_json::json!({
        "param_name": "password",
        "session_id": row.id,
    }))
}
