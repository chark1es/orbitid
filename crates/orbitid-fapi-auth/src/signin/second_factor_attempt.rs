//! Second-factor attempt handling. Ported from
//! `modules/sign-in/second-factor.ts`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::verified_second_factor_phones_on;
use orbitid_credentials::{first_factor_channel, supported_second_factors};
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::trusted_devices::TrustedDeviceCookie;
use orbitid_identity::trusted_devices_fapi::issue_trusted_device_on;
use orbitid_identity::users::{record_failed_attempt, reset_failed_attempts_on};
use orbitid_identity::users_fapi::list_emails_on;
use orbitid_identity::verifications::{check_code_on, commit_code_refusal, purposes, CodeCheck};
use orbitid_identity::verifications_fapi::get_verification_on;

use crate::signin::complete::CompleteOptions;
use crate::signin::core::{
    as_sign_in_state, assert_sign_in_allowed, complete_sign_in_on, save_sign_in_state_on,
};
use crate::signin::helpers::{
    apply_client_token, apply_trusted_device, completion_options, load_sign_in, notify_session,
    open_client, reload, respond_sign_in, user_for_row,
};
use crate::signin::second_factor::factor_options;
use crate::signin::shared::AttemptSecondBody;
use crate::state::FactorState;
use crate::util::{client_ip, hit, Reply};

pub async fn attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AttemptSecondBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    let row = load_sign_in(&state, &client.id, &id).await?;
    hit(
        &state,
        &format!("sign_in:attempt_second:{}", client_ip(&state, &headers)),
        60,
        60_000,
    )
    .await?;
    let user = user_for_row(&state, &row).await?;
    assert_sign_in_allowed(&user)?;
    let current = as_sign_in_state(&row);
    if row.status != "needs_second_factor"
        || current
            .first
            .as_ref()
            .and_then(|first| first.status.as_deref())
            != Some("verified")
    {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "There is no verified first factor to escalate",
        ));
    }
    let strategy = body.strategy.clone().or_else(|| {
        current
            .second
            .as_ref()
            .map(|second| second.strategy.clone())
    });
    let Some(strategy) = strategy else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "No second factor in progress",
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    };
    let options = factor_options(&current);
    let available = supported_second_factors(&state, &user, options.clone()).await?;
    if !available.iter().any(|factor| factor.strategy == strategy) {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Second factor \"{strategy}\" is not available"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }
    // The factor consumption, the attempt's state transition, the session
    // creation and (optionally) the remembered browser commit together. A
    // refused code commits the transaction (so the per-code attempt counter
    // written by `check_code_on` survives) and then records the account
    // failed-attempt counter in its own transaction.
    let mut tx = state.pool.begin().await?;
    // Rank 2 → 3 before the factor verification (which locks `users`) or the
    // session creation (which locks the client again).
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &user.id).await?;
    // Rank 5 before the first verification write (rank 6).
    orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
    let ok = if strategy == "totp" {
        orbitid_credentials::mfa::fapi::verify_totp_once_on(
            &mut tx,
            &state,
            &user,
            body.code.as_deref().unwrap_or(""),
        )
        .await?
    } else if strategy == "backup_code" {
        orbitid_credentials::mfa::fapi::consume_backup_code_on(
            &mut tx,
            &user.id,
            body.code.as_deref().unwrap_or(""),
        )
        .await?
    } else if strategy == "phone_code" {
        let phone_id = current
            .second
            .as_ref()
            .and_then(|second| second.phone_id.clone());
        let same_phone = first_factor_channel(current.first.as_ref().map(|f| f.strategy.as_str()))
            == Some("phone")
            && phone_id
                == current
                    .first
                    .as_ref()
                    .and_then(|first| first.phone_id.clone());
        let phone = match &phone_id {
            Some(id) => verified_second_factor_phones_on(&mut tx, &user.id, None)
                .await?
                .into_iter()
                .find(|phone| &phone.id == id),
            None => None,
        };
        if phone.is_none() || same_phone {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_CODE_INCORRECT,
                "There is no pending verification to check",
            )
            .with_meta(serde_json::json!({ "param_name": "code" })));
        }
        let verification =
            get_verification_on(&mut tx, purposes::SIGN_IN_SECOND_FACTOR, &row.id, None).await?;
        match check_code_on(&mut tx, &state, verification.as_ref(), body.code.as_deref()).await? {
            CodeCheck::Verified(_) => true,
            CodeCheck::Refused(refusal) => {
                // The per-code attempt increment must survive the refusal:
                // commit it (marking the replay memo only after the real
                // commit) before recording the account failure on its own
                // connection.
                let error = commit_code_refusal(tx, refusal).await?;
                if error.code == error_codes::FORM_CODE_INCORRECT {
                    record_failed_attempt(&state, &user.id).await?;
                }
                return Err(error);
            }
        }
    } else if strategy == "email_code" {
        let email_id = current
            .second
            .as_ref()
            .and_then(|second| second.email_id.clone());
        let email = match &email_id {
            Some(id) => list_emails_on(&mut tx, &user.id)
                .await?
                .into_iter()
                .find(|email| &email.id == id && email.verified),
            None => None,
        };
        let verification =
            get_verification_on(&mut tx, purposes::SIGN_IN_SECOND_FACTOR, &row.id, None).await?;
        let same_email = first_factor_channel(current.first.as_ref().map(|f| f.strategy.as_str()))
            == Some("email")
            && email_id
                == current
                    .first
                    .as_ref()
                    .and_then(|first| first.email_id.clone());
        let matches = match (&email, &verification) {
            (Some(email), Some(verification)) => {
                verification.strategy == "email_code" && verification.identifier == email.email
            }
            _ => false,
        };
        if email.is_none() || same_email || !matches {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_CODE_INCORRECT,
                "There is no pending verification to check",
            )
            .with_meta(serde_json::json!({ "param_name": "code" })));
        }
        match check_code_on(&mut tx, &state, verification.as_ref(), body.code.as_deref()).await? {
            CodeCheck::Verified(_) => true,
            CodeCheck::Refused(refusal) => {
                // The per-code attempt increment must survive the refusal:
                // commit it (marking the replay memo only after the real
                // commit) before recording the account failure on its own
                // connection.
                let error = commit_code_refusal(tx, refusal).await?;
                if error.code == error_codes::FORM_CODE_INCORRECT {
                    record_failed_attempt(&state, &user.id).await?;
                }
                return Err(error);
            }
        }
    } else {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Second factor \"{strategy}\" is not valid"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    };
    if !ok {
        // TOTP/backup-code helpers write nothing on a wrong code, but commit
        // the (empty) transaction before the separately-committed counter so
        // the connection is released first.
        tx.commit().await?;
        record_failed_attempt(&state, &user.id).await?;
        return Err(OrbitError::unprocessable(
            error_codes::FORM_CODE_INCORRECT,
            "That verification code is incorrect",
        )
        .with_meta(serde_json::json!({ "param_name": "code" })));
    }
    reset_failed_attempts_on(&mut tx, &user.id).await?;
    let mut next = current.clone();
    let mut second = next
        .second
        .clone()
        .unwrap_or_else(|| FactorState::new(&strategy));
    second.strategy = strategy.clone();
    second.status = Some("verified".into());
    next.second = Some(second);
    let saved = save_sign_in_state_on(&mut tx, &row, &next).await?;
    let complete_options = CompleteOptions {
        second_factor: true,
        ..completion_options(&headers, &state)
    };
    let completed = complete_sign_in_on(&mut tx, &state, &saved, &complete_options).await?;
    let trusted_device = if body.trust_device == Some(true)
        && state.settings.get().session.trusted_devices_enabled
    {
        Some(
            issue_trusted_device_on(
                &mut tx,
                &state,
                &user.id,
                headers
                    .get("user-agent")
                    .and_then(|value| value.to_str().ok()),
                Some(&client_ip(&state, &headers)),
            )
            .await?,
        )
    } else {
        None
    };
    tx.commit().await?;
    apply_client_token(
        &headers,
        &state,
        &mut cookies,
        completed.client_token.clone(),
    );
    if let Some((device, token)) = trusted_device {
        apply_trusted_device(
            &state,
            &mut cookies,
            &TrustedDeviceCookie {
                token: Some(token),
                expires_at: Some(device.expires_at),
                clear: false,
            },
        );
    }
    notify_session(&state, &user, &completed.session_id).await?;
    let fresh = reload(&state, &row.id).await?;
    respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
}
