//! First-factor attempts and password reset authorization. Ported from
//! `modules/sign-in/first-factor.ts` (`attempt_first_factor`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_credentials::passkeys::{finish_passkey_authentication, FinishAuthenticationInput};
use orbitid_credentials::AuthenticationResponseJson;
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::trusted_devices::TrustedDeviceCookie;
use orbitid_identity::users::{get_user_by_id, reset_failed_attempts_on};
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, get_verification, get_verification_by_id, purposes,
    CodeCheck,
};
use orbitid_identity::verifications_fapi::get_verification_on;

use crate::signin::core::{
    after_first_factor_on, as_sign_in_state, assert_sign_in_allowed, save_sign_in_state_on,
    transition_sign_in_on, SignInTransition,
};
use crate::signin::helpers::{
    apply_client_token, apply_trusted_device, assert_first_factor_enabled, attempt_password,
    completion_options, load_sign_in, notify_session, open_client, reload, respond_sign_in,
};
use crate::signin::recovery::recovery_factor_from_verification;
use crate::signin::shared::AttemptFirstBody;
use crate::state::{FactorState, SignInState};
use crate::util::{client_ip, hit, Reply};

/// Strategies that carry their own credential and need no prepare step.
const PREPARATION_FREE: [&str; 1] = ["password"];

fn state_gate(status: &str, strategy: Option<&str>) -> bool {
    status == "needs_first_factor" || (status == "needs_identifier" && strategy == Some("passkey"))
}

/// Saves a verified first factor and runs the completion decision (including
/// session creation) in one transaction.
async fn advance_after_first_atomic(
    state: &AppState,
    headers: &HeaderMap,
    row: &orbitid_core::models::SignInRow,
    user: &orbitid_core::models::UserRow,
    next: &SignInState,
    cookies: &mut Vec<String>,
) -> Result<()> {
    let factors =
        crate::signin::complete::second_factor_options_for(state, user, &as_sign_in_state(row))
            .await?;
    let enrolled = !crate::signin::complete::all_second_factors(state, user)
        .await?
        .is_empty();
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &user.id).await?;
    let saved = save_sign_in_state_on(&mut tx, row, next).await?;
    let options = completion_options(headers, state);
    let result = after_first_factor_on(
        &mut tx,
        state,
        &saved,
        user,
        &options,
        orbitid_identity::trusted_devices::read_trusted_device_token(headers).as_deref(),
        &factors,
        enrolled,
    )
    .await?;
    tx.commit().await?;
    apply_client_token(headers, state, cookies, result.client_token.clone());
    apply_trusted_device(
        state,
        cookies,
        &TrustedDeviceCookie {
            token: result.trusted_device_token.clone(),
            expires_at: result.trusted_device_expires_at,
            clear: result.clear_trusted_device,
        },
    );
    if let Some(session_id) = &result.session_id {
        notify_session(state, user, session_id).await?;
    }
    Ok(())
}

pub async fn attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AttemptFirstBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    let row = load_sign_in(&state, &client.id, &id).await?;
    let current = as_sign_in_state(&row);
    let strategy = match body.strategy.clone() {
        Some(strategy) => Some(strategy),
        None => current.first.as_ref().map(|first| first.strategy.clone()),
    };
    if !state_gate(&row.status, strategy.as_deref()) {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in is not waiting for a first factor",
        ));
    }
    hit(
        &state,
        &format!("sign_in:attempt:{}", client_ip(&state, &headers)),
        60,
        60_000,
    )
    .await?;
    let Some(strategy) = strategy else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "No first-factor strategy in progress",
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    };
    let prepared_strategy = current.first.as_ref().map(|first| first.strategy.clone());
    if let Some(named) = body.strategy.as_deref() {
        if let Some(prepared) = prepared_strategy.as_deref() {
            if named != prepared && !PREPARATION_FREE.contains(&named) {
                return Err(OrbitError::bad_request(
                    error_codes::CLIENT_STATE_INVALID,
                    "The attempted strategy does not match the first factor that was prepared",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            }
        }
    }
    let existing_user = match &row.user_id {
        Some(user_id) => get_user_by_id(&state, user_id).await?,
        None => None,
    };
    if strategy != "passkey" {
        let Some(user) = &existing_user else {
            return Err(OrbitError::bad_request(
                error_codes::CLIENT_STATE_INVALID,
                "Sign-in has no user",
            ));
        };
        assert_sign_in_allowed(user)?;
    }
    assert_first_factor_enabled(&state, existing_user.as_ref(), &strategy).await?;

    if strategy == "password" {
        attempt_password(
            &state,
            &headers,
            &row,
            body.password.as_deref(),
            &mut cookies,
        )
        .await?;
        let fresh = reload(&state, &row.id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
    }
    if strategy.starts_with("oauth_") || strategy == "enterprise_sso" || strategy == "ticket" {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            format!("Strategy \"{strategy}\" is completed through its redirect flow"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }

    if strategy == "passkey" {
        let Some(credential) = body.public_key_credential.clone() else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "public_key_credential is missing",
            )
            .with_meta(serde_json::json!({ "param_name": "public_key_credential" })));
        };
        let credential: AuthenticationResponseJson =
            serde_json::from_value(credential).map_err(|_| {
                OrbitError::unprocessable(
                    error_codes::PASSKEY_AUTHENTICATION_FAILURE,
                    "That passkey could not be verified",
                )
            })?;
        let (authed, _) = finish_passkey_authentication(
            &state,
            FinishAuthenticationInput {
                owner_id: row.id.clone(),
                credential,
            },
        )
        .await?;
        if let Some(existing) = &existing_user {
            if authed.id != existing.id {
                return Err(OrbitError::bad_request(
                    error_codes::PASSKEY_AUTHENTICATION_FAILURE,
                    "That passkey belongs to another account",
                ));
            }
        }
        assert_sign_in_allowed(&authed)?;
        let factors =
            crate::signin::complete::second_factor_options_for(&state, &authed, &current).await?;
        let enrolled = !crate::signin::complete::all_second_factors(&state, &authed)
            .await?
            .is_empty();
        let mut tx = state.pool.begin().await?;
        orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &authed.id)
            .await?;
        let fresh = transition_sign_in_on(
            &mut tx,
            &row,
            SignInTransition {
                user_id: Some(&authed.id),
                identifier: row
                    .identifier
                    .clone()
                    .or_else(|| authed.username.clone())
                    .as_deref(),
                ..Default::default()
            },
        )
        .await?;
        let mut next = as_sign_in_state(&fresh);
        next.first = Some(FactorState::new("passkey").status("verified"));
        let saved = save_sign_in_state_on(&mut tx, &fresh, &next).await?;
        let result = after_first_factor_on(
            &mut tx,
            &state,
            &saved,
            &authed,
            &completion_options(&headers, &state),
            orbitid_identity::trusted_devices::read_trusted_device_token(&headers).as_deref(),
            &factors,
            enrolled,
        )
        .await?;
        tx.commit().await?;
        apply_client_token(&headers, &state, &mut cookies, result.client_token.clone());
        apply_trusted_device(
            &state,
            &mut cookies,
            &TrustedDeviceCookie {
                token: result.trusted_device_token.clone(),
                expires_at: result.trusted_device_expires_at,
                clear: result.clear_trusted_device,
            },
        );
        if let Some(session_id) = &result.session_id {
            notify_session(&state, &authed, session_id).await?;
        }
        let final_row = reload(&state, &row.id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &final_row, cookies).await;
    }

    let Some(user) = existing_user else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Sign-in has no user",
        ));
    };

    if strategy == "email_link" {
        let verification = if current
            .first
            .as_ref()
            .and_then(|f| f.verification_id.clone())
            .is_some()
        {
            get_verification(&state, purposes::SIGN_IN_FIRST_FACTOR, &row.id, None).await?
        } else {
            None
        };
        let clicked = verification
            .as_ref()
            .map(|row| row.verified_at.is_some() || row.consumed_at.is_some())
            .unwrap_or(false);
        if !clicked {
            // Cross-device polling: the link has not been clicked yet.
            let fresh = reload(&state, &row.id).await?;
            return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
        }
        let mut next = current.clone();
        let mut first = next
            .first
            .clone()
            .unwrap_or_else(|| FactorState::new("email_link"));
        first.status = Some("verified".into());
        next.first = Some(first);
        advance_after_first_atomic(&state, &headers, &row, &user, &next, &mut cookies).await?;
        let fresh = reload(&state, &row.id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
    }

    if strategy == "reset_password_email_code" || strategy == "reset_password_phone_code" {
        let prepared = current.first.clone();
        let expected = if strategy == "reset_password_email_code" {
            "email_code"
        } else {
            "phone_code"
        };
        let verification = match prepared
            .as_ref()
            .and_then(|first| first.verification_id.clone())
        {
            Some(id) => get_verification_by_id(&state, &id).await?,
            None => None,
        };
        let verification = match (&prepared, verification) {
            (Some(prepared), Some(verification))
                if prepared.strategy == strategy
                    && verification.purpose == purposes::RESET_PASSWORD
                    && verification.owner_id == row.id
                    && verification.strategy == expected
                    && verification.consumed_at.is_none() =>
            {
                verification
            }
            _ => {
                return Err(OrbitError::bad_request(
                    error_codes::CLIENT_STATE_INVALID,
                    "No matching password recovery is in progress",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            }
        };
        let Some(recovery) =
            recovery_factor_from_verification(&state, &user, &verification).await?
        else {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "This account no longer has the recovery identifier",
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        };
        let mut next = current.clone();
        next.first = Some(FactorState {
            strategy: recovery.strategy.clone(),
            status: Some("verified".into()),
            verification_id: Some(verification.id.clone()),
            email_id: recovery.email_id.clone(),
            phone_id: recovery.phone_id.clone(),
            ..Default::default()
        });
        next.reset_password = Some(crate::state::ResetPasswordState {
            verified: true,
            strategy: recovery.strategy.clone(),
        });
        let mut tx = state.pool.begin().await?;
        orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &user.id)
            .await?;
        // Rank 5 before the first verification write (rank 6).
        orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
        if let CodeCheck::Refused(refusal) =
            check_code_on(&mut tx, &state, Some(&verification), body.code.as_deref()).await?
        {
            return Err(commit_code_refusal(tx, refusal).await?);
        }
        transition_sign_in_on(
            &mut tx,
            &row,
            SignInTransition {
                status: Some("needs_new_password"),
                state: Some(&next),
                ..Default::default()
            },
        )
        .await?;
        tx.commit().await?;
        let fresh = reload(&state, &row.id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
    }

    if strategy != "email_code" && strategy != "phone_code" {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Strategy \"{strategy}\" is not valid for this user"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }
    let factors =
        crate::signin::complete::second_factor_options_for(&state, &user, &current).await?;
    let enrolled = !crate::signin::complete::all_second_factors(&state, &user)
        .await?
        .is_empty();
    let next = verified_state(&current, &strategy);
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &user.id).await?;
    orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
    let verification =
        get_verification_on(&mut tx, purposes::SIGN_IN_FIRST_FACTOR, &row.id, None).await?;
    if let CodeCheck::Refused(refusal) =
        check_code_on(&mut tx, &state, verification.as_ref(), body.code.as_deref()).await?
    {
        // The attempt counter must survive the refusal.
        return Err(commit_code_refusal(tx, refusal).await?);
    }
    reset_failed_attempts_on(&mut tx, &user.id).await?;
    let saved = save_sign_in_state_on(&mut tx, &row, &next).await?;
    let result = after_first_factor_on(
        &mut tx,
        &state,
        &saved,
        &user,
        &completion_options(&headers, &state),
        orbitid_identity::trusted_devices::read_trusted_device_token(&headers).as_deref(),
        &factors,
        enrolled,
    )
    .await?;
    tx.commit().await?;
    apply_client_token(&headers, &state, &mut cookies, result.client_token.clone());
    apply_trusted_device(
        &state,
        &mut cookies,
        &TrustedDeviceCookie {
            token: result.trusted_device_token.clone(),
            expires_at: result.trusted_device_expires_at,
            clear: result.clear_trusted_device,
        },
    );
    if let Some(session_id) = &result.session_id {
        notify_session(&state, &user, session_id).await?;
    }
    let fresh = reload(&state, &row.id).await?;
    respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
}

fn verified_state(current: &SignInState, strategy: &str) -> SignInState {
    let mut next = current.clone();
    let mut first = next
        .first
        .clone()
        .unwrap_or_else(|| FactorState::new(strategy));
    first.strategy = strategy.to_string();
    first.status = Some("verified".into());
    next.first = Some(first);
    next
}
