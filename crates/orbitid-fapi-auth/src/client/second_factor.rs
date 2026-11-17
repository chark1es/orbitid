use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::{
    consume_backup_code_on, verified_second_factor_phones_on, verify_totp_once_on,
};
use orbitid_credentials::{user_has_mfa, verified_second_factor_phones};
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::sessions::require_session;
use orbitid_identity::sessions_fapi::mark_session_reverified_on;
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, issue_verification, purposes, verification_json, CodeCheck,
    IssueVerificationInput,
};
use orbitid_platform::mail::send_sms;
use serde_json::Value;

use crate::signin::helpers::{open_client, serialize_client_full};
use crate::util::{hit, Reply};

use super::bodies::{AttemptSecondBody, PrepareSecondBody};
use super::sessions::{respond_verification, user_of_session};

pub async fn prepare_second_factor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PrepareSecondBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let strategy = body.strategy.clone().unwrap_or_default();
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    let user = user_of_session(&state, &row).await?;
    if !user_has_mfa(&state, &user).await? {
        return Err(OrbitError::bad_request(
            error_codes::MFA_NOT_ENABLED,
            "This user has not enabled MFA",
        ));
    }
    let settings = state.settings.get();
    let mut verification = serde_json::json!({
        "status": "unverified",
        "strategy": strategy,
        "attempts": null,
        "expire_at": null,
    });
    if strategy == "phone_code" {
        let phones = verified_second_factor_phones(&state.pool, &user.id, None).await?;
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
                "This user has no verified second-factor phone number",
            ));
        };
        let issued = issue_verification(
            &state,
            IssueVerificationInput::new(
                purposes::REVERIFY_SECOND_FACTOR,
                "phone_code",
                &phone.phone,
                &row.id,
                settings.email.code_lifetime_seconds,
            ),
        )
        .await?;
        let _ = send_sms(
            &state,
            &phone.phone,
            &format!(
                "Your {} verification code is {}",
                settings.application.name,
                issued.code.clone().unwrap_or_default()
            ),
        )
        .await;
        verification = verification_json(Some(&issued.row), None)
            .and_then(|json| serde_json::to_value(json).ok())
            .unwrap_or(Value::Null);
    } else if strategy == "totp" && !user.totp_verified {
        return Err(OrbitError::bad_request(
            error_codes::TOTP_NOT_ENABLED,
            "TOTP is not enabled for this user",
        ));
    } else if strategy == "backup_code"
        && user
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
    let client_json =
        serialize_client_full(&state, &client, client_azp(&headers).as_deref()).await?;
    Ok(Reply::json(serde_json::json!({
        "response": verification,
        "client": client_json,
    }))
    .cookie(cookie))
}

pub async fn attempt_second_factor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AttemptSecondBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let strategy = body.strategy.clone().unwrap_or_default();
    let code = body.code.clone().unwrap_or_default();
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    hit(&state, &format!("reverify_2fa:{}", client.id), 60, 60_000).await?;
    let user = user_of_session(&state, &row).await?;
    // The factor consumption (TOTP step / backup code / phone code) and the
    // session's second-factor mark commit together; a refused phone/email code
    // is committed separately so its attempt counter survives.
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
    let verification: Option<Value> = {
        let incorrect = || {
            OrbitError::unprocessable(
                error_codes::FORM_CODE_INCORRECT,
                "That verification code is incorrect",
            )
            .with_meta(serde_json::json!({ "param_name": "code" }))
        };
        if strategy == "totp" {
            if !verify_totp_once_on(&mut tx, &state, &user, &code).await? {
                return Err(incorrect());
            }
            Some(serde_json::json!({
                "status": "verified",
                "strategy": strategy,
                "attempts": null,
                "expire_at": null,
            }))
        } else if strategy == "backup_code" {
            if !consume_backup_code_on(&mut tx, &user.id, &code).await? {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_CODE_INCORRECT,
                    "That backup code is incorrect or already used",
                )
                .with_meta(serde_json::json!({ "param_name": "code" })));
            }
            Some(serde_json::json!({
                "status": "verified",
                "strategy": strategy,
                "attempts": null,
                "expire_at": null,
            }))
        } else {
            let pending = orbitid_identity::verifications_fapi::get_verification_on(
                &mut tx,
                purposes::REVERIFY_SECOND_FACTOR,
                &row.id,
                None,
            )
            .await?;
            let phones = verified_second_factor_phones_on(&mut tx, &user.id, None).await?;
            let eligible = pending
                .as_ref()
                .map(|pending| phones.iter().any(|phone| phone.phone == pending.identifier))
                .unwrap_or(false);
            if !eligible {
                return Err(incorrect());
            }
            let claimed =
                match check_code_on(&mut tx, &state, pending.as_ref(), Some(&code)).await? {
                    CodeCheck::Verified(row) => row,
                    // The attempt counter is a write that must survive.
                    CodeCheck::Refused(refusal) => {
                        return Err(commit_code_refusal(tx, refusal).await?);
                    }
                };
            verification_json(Some(&claimed), None).and_then(|json| serde_json::to_value(json).ok())
        }
    };
    let updated = mark_session_reverified_on(&mut tx, &row.id, "second_factor").await?;
    tx.commit().await?;
    respond_verification(
        &state,
        &headers,
        &client,
        &updated,
        verification.unwrap_or(Value::Null),
        cookie.into_iter().collect(),
    )
    .await
}
