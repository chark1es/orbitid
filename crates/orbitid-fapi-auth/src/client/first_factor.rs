use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_credentials::verified_second_factor_phones;
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::sessions::require_session;
use orbitid_identity::sessions_fapi::mark_session_reverified_on;
use orbitid_identity::users::{list_emails, record_failed_attempt};
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, issue_verification, purposes, verification_json, CodeCheck,
    IssueVerificationInput,
};
use orbitid_platform::mail::{send_email, send_sms, EmailTemplate, SendEmailInput};
use serde_json::Value;

use crate::signin::helpers::{open_client, serialize_client_full};
use crate::util::{hit, Reply};

use super::bodies::{AttemptFirstBody, PrepareFirstBody};
use super::sessions::{respond_verification, user_of_session};

pub async fn prepare_first_factor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PrepareFirstBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    hit(
        &state,
        &format!("reverify_prepare:{}", client.id),
        30,
        60_000,
    )
    .await?;
    let user = user_of_session(&state, &row).await?;
    let strategy = body.strategy.clone().unwrap_or_else(|| "email_code".into());
    let settings = state.settings.get();
    let verification: Option<Value> = if strategy == "email_code" {
        let emails: Vec<_> = list_emails(&state, &user.id)
            .await?
            .into_iter()
            .filter(|email| email.verified)
            .collect();
        let email = match &body.email_address_id {
            Some(id) => emails.iter().find(|email| &email.id == id),
            None => emails.first(),
        };
        let Some(email) = email else {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "This user has no verified email address",
            ));
        };
        let issued = issue_verification(
            &state,
            IssueVerificationInput::new(
                purposes::REVERIFY_FIRST_FACTOR,
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
        let _ = send_email(&state, input).await;
        verification_json(Some(&issued.row), None).and_then(|json| serde_json::to_value(json).ok())
    } else if strategy == "phone_code" {
        let phones = verified_second_factor_phones(&state.pool, &user.id, None).await?;
        let phone = match &body.phone_number_id {
            Some(id) => phones.iter().find(|phone| &phone.id == id),
            None => phones.first(),
        };
        let Some(phone) = phone else {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "This user has no verified phone number",
            ));
        };
        let issued = issue_verification(
            &state,
            IssueVerificationInput::new(
                purposes::REVERIFY_FIRST_FACTOR,
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
        verification_json(Some(&issued.row), None).and_then(|json| serde_json::to_value(json).ok())
    } else {
        if user.password_hash.is_none() {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "This user has no password",
            ));
        }
        Some(serde_json::json!({
            "status": "unverified",
            "strategy": "password",
            "attempts": null,
            "expire_at": null,
        }))
    };
    let client_json =
        serialize_client_full(&state, &client, client_azp(&headers).as_deref()).await?;
    Ok(Reply::json(serde_json::json!({
        "response": verification,
        "client": client_json,
    }))
    .cookie(cookie))
}

pub async fn attempt_first_factor(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AttemptFirstBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    hit(
        &state,
        &format!("reverify_attempt:{}", client.id),
        60,
        60_000,
    )
    .await?;
    let user = user_of_session(&state, &row).await?;
    let strategy = body.strategy.clone().unwrap_or_else(|| "email_code".into());
    // The code/password check and the session's reverification mark commit
    // together. A refused attempt is committed separately (see below) so its
    // counter is never rolled back with the failure.
    let (verification, updated): (Option<Value>, _) = if strategy == "password" {
        let ok = match (&user.password_hash, body.password.as_deref()) {
            (Some(hash), Some(password)) => {
                orbitid_credentials::verify_password(hash, password).await
            }
            _ => false,
        };
        if !ok {
            // Its own transaction: the failure must persist even though this
            // request is refused.
            record_failed_attempt(&state, &user.id).await?;
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PASSWORD_INCORRECT,
                "Password is incorrect",
            )
            .with_meta(serde_json::json!({ "param_name": "password" })));
        }
        let mut tx = state.pool.begin().await?;
        orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
        orbitid_identity::users::reset_failed_attempts_on(&mut tx, &user.id).await?;
        let updated = mark_session_reverified_on(&mut tx, &row.id, "first_factor").await?;
        tx.commit().await?;
        (
            Some(serde_json::json!({
                "status": "verified",
                "strategy": "password",
                "attempts": null,
                "expire_at": null,
            })),
            updated,
        )
    } else {
        let mut tx = state.pool.begin().await?;
        orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
        let pending = orbitid_identity::verifications_fapi::get_verification_on(
            &mut tx,
            purposes::REVERIFY_FIRST_FACTOR,
            &row.id,
            None,
        )
        .await?;
        if let Some(pending) = &pending {
            if pending.strategy != strategy {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_CODE_INCORRECT,
                    "That verification code is incorrect",
                )
                .with_meta(serde_json::json!({ "param_name": "code" })));
            }
        }
        let claimed =
            match check_code_on(&mut tx, &state, pending.as_ref(), body.code.as_deref()).await? {
                CodeCheck::Verified(row) => row,
                // The attempt counter is a write that must survive the refusal.
                CodeCheck::Refused(refusal) => {
                    return Err(commit_code_refusal(tx, refusal).await?);
                }
            };
        let json = verification_json(Some(&claimed), None)
            .and_then(|json| serde_json::to_value(json).ok());
        let updated = mark_session_reverified_on(&mut tx, &row.id, "first_factor").await?;
        tx.commit().await?;
        (json, updated)
    };
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
