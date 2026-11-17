//! Second-factor preparation. Ported from `modules/sign-in/second-factor.ts`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::verified_second_factor_phones_on;
use orbitid_credentials::{supported_second_factors, SecondFactorOptions};
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::users_fapi::list_emails_on;
use orbitid_identity::verifications::{issue_verification_on, purposes};
use orbitid_platform::mail::{send_email, send_sms, EmailTemplate, SendEmailInput};

use crate::signin::core::{
    as_sign_in_state, assert_sign_in_allowed, transition_sign_in_on, SignInTransition,
};
use crate::signin::helpers::{load_sign_in, open_client, reload, respond_sign_in, user_for_row};
use crate::signin::shared::PrepareSecondBody;
use crate::state::FactorState;
use crate::util::{client_ip, hit, Reply};

pub(crate) fn factor_options(state: &crate::state::SignInState) -> SecondFactorOptions {
    SecondFactorOptions {
        first_factor_strategy: state.first.as_ref().map(|first| first.strategy.clone()),
        first_factor_email_id: state
            .first
            .as_ref()
            .and_then(|first| first.email_id.clone()),
        first_factor_phone_id: state
            .first
            .as_ref()
            .and_then(|first| first.phone_id.clone()),
    }
}

pub async fn prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PrepareSecondBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    let row = load_sign_in(&state, &client.id, &id).await?;
    hit(
        &state,
        &format!("sign_in:prepare_second:{}", client_ip(&state, &headers)),
        30,
        60_000,
    )
    .await?;
    let user = user_for_row(&state, &row).await?;
    assert_sign_in_allowed(&user)?;
    let current = as_sign_in_state(&row);
    if current
        .first
        .as_ref()
        .and_then(|first| first.status.as_deref())
        != Some("verified")
    {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "The first factor has not been verified",
        ));
    }
    let available = supported_second_factors(&state, &user, factor_options(&current)).await?;
    if available.is_empty() {
        return Err(OrbitError::bad_request(
            error_codes::NEEDS_SECOND_FACTOR,
            "This account has no second factor",
        ));
    }
    let strategy = body
        .strategy
        .clone()
        .or_else(|| {
            current
                .second
                .as_ref()
                .map(|second| second.strategy.clone())
        })
        .unwrap_or_else(|| {
            available
                .first()
                .map(|factor| factor.strategy.clone())
                .unwrap_or_default()
        });
    if !available.iter().any(|factor| factor.strategy == strategy) {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Second factor \"{strategy}\" is not available"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }
    let mut next = current.clone();
    let settings = state.settings.get();
    // Issuing the code (when a code is needed) and recording the pending
    // second factor commit together; delivery happens after commit.
    enum Outgoing {
        None,
        Email(SendEmailInput),
        Sms(String, String),
    }
    let outgoing;
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
    orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
    if strategy == "totp" {
        if !user.totp_verified {
            return Err(OrbitError::bad_request(
                error_codes::TOTP_NOT_ENABLED,
                "TOTP is not enabled for this user",
            ));
        }
        next.second = Some(FactorState::new("totp").status("unverified"));
        outgoing = Outgoing::None;
    } else if strategy == "backup_code" {
        if user
            .backup_codes
            .as_ref()
            .map(|codes| codes.0.is_empty())
            .unwrap_or(true)
        {
            return Err(OrbitError::bad_request(
                error_codes::MFA_NOT_ENABLED,
                "No backup codes available",
            ));
        }
        next.second = Some(FactorState::new("backup_code").status("unverified"));
        outgoing = Outgoing::None;
    } else if strategy == "email_code" {
        let emails = list_emails_on(&mut tx, &user.id).await?;
        let offered: Vec<_> = available
            .iter()
            .filter(|factor| factor.strategy == "email_code")
            .collect();
        let chosen = match &body.email_address_id {
            Some(id) => offered
                .iter()
                .find(|factor| factor.email_address_id.as_deref() == Some(id.as_str()))
                .copied(),
            None => offered.first().copied(),
        };
        if body.email_address_id.is_some() && chosen.is_none() {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "That email address is not available as a second factor",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address_id" })));
        }
        let email = emails
            .into_iter()
            .find(|email| Some(&email.id) == chosen.and_then(|f| f.email_address_id.as_ref()));
        let Some(email) = email.filter(|email| email.verified) else {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "This account has no verified email address",
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        };
        let issued = issue_verification_on(
            &mut tx,
            &state,
            orbitid_identity::verifications::IssueVerificationInput::new(
                purposes::SIGN_IN_SECOND_FACTOR,
                "email_code",
                &email.email,
                &row.id,
                settings.email.code_lifetime_seconds,
            ),
        )
        .await?;
        let mut input = SendEmailInput::new(email.email.clone(), EmailTemplate::VerificationCode);
        input.vars.insert(
            "code".into(),
            serde_json::json!(issued.code.clone().unwrap_or_default()),
        );
        input.vars.insert(
            "expires_in_minutes".into(),
            serde_json::json!((settings.email.code_lifetime_seconds as f64 / 60.0).round() as i64),
        );
        if let Some(name) = &user.first_name {
            input
                .vars
                .insert("user_name".into(), serde_json::json!(name));
        }
        outgoing = Outgoing::Email(input);
        next.second = Some(FactorState {
            strategy: "email_code".into(),
            verification_id: Some(issued.row.id.clone()),
            email_id: Some(email.id.clone()),
            status: Some("unverified".into()),
            ..Default::default()
        });
    } else {
        let offered_ids: Vec<String> = available
            .iter()
            .filter(|factor| factor.strategy == "phone_code")
            .filter_map(|factor| factor.phone_number_id.clone())
            .collect();
        let phones: Vec<_> = verified_second_factor_phones_on(&mut tx, &user.id, None)
            .await?
            .into_iter()
            .filter(|phone| offered_ids.contains(&phone.id))
            .collect();
        let phone = match &body.phone_number_id {
            Some(id) => phones.iter().find(|phone| &phone.id == id),
            None => phones
                .iter()
                .find(|phone| phone.default_second_factor)
                .or_else(|| phones.first()),
        };
        let Some(phone) = phone else {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "No verified phone number for second factor",
            ));
        };
        let issued = issue_verification_on(
            &mut tx,
            &state,
            orbitid_identity::verifications::IssueVerificationInput::new(
                purposes::SIGN_IN_SECOND_FACTOR,
                "phone_code",
                &phone.phone,
                &row.id,
                settings.email.code_lifetime_seconds,
            ),
        )
        .await?;
        outgoing = Outgoing::Sms(
            phone.phone.clone(),
            format!(
                "Your {} verification code is {}",
                settings.application.name,
                issued.code.clone().unwrap_or_default()
            ),
        );
        next.second = Some(FactorState {
            strategy: "phone_code".into(),
            verification_id: Some(issued.row.id.clone()),
            phone_id: Some(phone.id.clone()),
            status: Some("unverified".into()),
            ..Default::default()
        });
    }
    transition_sign_in_on(
        &mut tx,
        &row,
        SignInTransition {
            status: Some("needs_second_factor"),
            state: Some(&next),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    match outgoing {
        Outgoing::Email(input) => {
            let _ = send_email(&state, input).await;
        }
        Outgoing::Sms(phone, text) => {
            let _ = send_sms(&state, &phone, &text).await;
        }
        Outgoing::None => {}
    }
    let fresh = reload(&state, &row.id).await?;
    respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
}
