//! Sign-up verifications. Ported from `modules/sign-up.ts`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, issue_verification_on, magic_link_url, purposes, CodeCheck,
    IssueVerificationInput,
};
use orbitid_identity::verifications_fapi::get_verification_on;
use orbitid_platform::captcha::verify_captcha;
use orbitid_platform::mail::{send_email, send_sms, EmailTemplate, SendEmailInput};

use crate::signin::shared::captcha_token;
use crate::signup::core::{
    as_sign_up_fields, as_sign_up_verifications, complete_sign_up_on, compute_requirements,
    email_is_verified, phone_is_verified, save_sign_up_on, SignUpPatch,
};
use crate::signup::helpers::{azp, load_sign_up, open_client, respond};
use crate::state::{SignUpVerifications, VerificationSnapshot};
use crate::util::{client_ip, hit, validate_redirect_url, Reply};

#[derive(Default, serde::Deserialize)]
pub struct PrepareBody {
    pub strategy: Option<String>,
    pub redirect_url: Option<String>,
    pub captcha_token: Option<String>,
}

impl std::fmt::Debug for PrepareBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrepareBody")
            .field("strategy", &self.strategy)
            .field("redirect_url", &self.redirect_url)
            .field("captcha_token", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct AttemptBody {
    pub strategy: Option<String>,
    pub code: Option<String>,
}

pub async fn prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PrepareBody>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ups").await?;
    let cookies: Vec<String> = cookie.into_iter().collect();
    let azp = azp(&headers);
    let row = load_sign_up(&state, &client.id, &id).await?;
    if row.status == "complete" {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ));
    }
    hit(
        &state,
        &format!("sign_up:prepare:{}", client_ip(&state, &headers)),
        30,
        60_000,
    )
    .await?;
    verify_captcha(
        &state,
        captcha_token(body.captcha_token.as_deref(), &headers).as_deref(),
        Some(&client_ip(&state, &headers)),
    )
    .await?;
    let strategy = body.strategy.clone().unwrap_or_else(|| "email_code".into());
    if !["email_code", "email_link", "phone_code"].contains(&strategy.as_str()) {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Strategy \"{strategy}\" is not valid"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }
    let fields = as_sign_up_fields(&row);
    let verifications = as_sign_up_verifications(&row);
    let settings = state.settings.get();
    enum Outgoing {
        Email(SendEmailInput),
        Sms(String, String),
    }
    // The verification issue (which also invalidates the previous live row) and
    // the attempt's snapshot transition commit together; delivery follows.
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
    orbitid_identity::locks::lock_sign_up_on(&mut tx, &row.id).await?;
    let (outgoing, next) = if strategy == "phone_code" {
        let Some(phone) = fields.phone_number.clone() else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "Add a phone number before verifying it",
            )
            .with_meta(serde_json::json!({ "param_name": "phone_number" })));
        };
        let issued = issue_verification_on(
            &mut tx,
            &state,
            IssueVerificationInput::new(
                purposes::SIGN_UP_PHONE,
                "phone_code",
                &phone,
                &row.id,
                settings.email.code_lifetime_seconds,
            ),
        )
        .await?;
        let outgoing = Outgoing::Sms(
            phone.clone(),
            format!(
                "Your {} verification code is {}",
                settings.application.name,
                issued.code.clone().unwrap_or_default()
            ),
        );
        let snapshot = VerificationSnapshot {
            verification_id: Some(issued.row.id.clone()),
            status: "unverified".into(),
            strategy,
            identifier: Some(phone),
            ..Default::default()
        };
        (
            outgoing,
            SignUpVerifications {
                phone_number: Some(snapshot),
                ..verifications
            },
        )
    } else {
        let Some(email) = fields.email_address.clone() else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "Add an email address before verifying it",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        };
        if strategy == "email_link" {
            let redirect =
                validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?
                    .unwrap_or_else(|| settings.application.home_url.clone());
            let mut issue = IssueVerificationInput::new(
                purposes::SIGN_UP_EMAIL,
                "email_link",
                &email,
                &row.id,
                settings.email.link_lifetime_seconds,
            );
            issue.redirect_url = Some(redirect);
            let issued = issue_verification_on(&mut tx, &state, issue).await?;
            let link = magic_link_url(
                &state,
                issued.token.as_deref().unwrap_or_default(),
                &[("sign_up_id", Some(row.id.as_str()))],
            );
            let mut input = SendEmailInput::new(email.clone(), EmailTemplate::MagicLink);
            input.vars.insert("link".into(), serde_json::json!(link));
            input.vars.insert(
                "expires_in_minutes".into(),
                serde_json::json!(
                    (settings.email.link_lifetime_seconds as f64 / 60.0).round() as i64
                ),
            );
            let snapshot = VerificationSnapshot {
                verification_id: Some(issued.row.id.clone()),
                status: "unverified".into(),
                strategy,
                identifier: Some(email),
                ..Default::default()
            };
            (
                Outgoing::Email(input),
                SignUpVerifications {
                    email_address: Some(snapshot),
                    ..verifications
                },
            )
        } else {
            let issued = issue_verification_on(
                &mut tx,
                &state,
                IssueVerificationInput::new(
                    purposes::SIGN_UP_EMAIL,
                    "email_code",
                    &email,
                    &row.id,
                    settings.email.code_lifetime_seconds,
                ),
            )
            .await?;
            let mut input = SendEmailInput::new(email.clone(), EmailTemplate::VerificationCode);
            input.vars.insert(
                "code".into(),
                serde_json::json!(issued.code.clone().unwrap_or_default()),
            );
            input.vars.insert(
                "expires_in_minutes".into(),
                serde_json::json!(
                    (settings.email.code_lifetime_seconds as f64 / 60.0).round() as i64
                ),
            );
            let snapshot = VerificationSnapshot {
                verification_id: Some(issued.row.id.clone()),
                status: "unverified".into(),
                strategy,
                identifier: Some(email),
                ..Default::default()
            };
            (
                Outgoing::Email(input),
                SignUpVerifications {
                    email_address: Some(snapshot),
                    ..verifications
                },
            )
        }
    };
    save_sign_up_on(
        &mut tx,
        &row,
        SignUpPatch {
            verifications: Some(next),
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
    }
    let row = crate::signup::core::reload_sign_up(&state, &row.id).await?;
    respond(&state, &client, azp.as_deref(), &row, cookies).await
}

pub async fn attempt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AttemptBody>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ups").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = azp(&headers);
    let row = load_sign_up(&state, &client.id, &id).await?;
    if row.status == "complete" {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ));
    }
    hit(
        &state,
        &format!("sign_up:attempt:{}", client_ip(&state, &headers)),
        60,
        60_000,
    )
    .await?;
    let verifications = as_sign_up_verifications(&row);
    let strategy = body.strategy.clone().unwrap_or_else(|| "email_code".into());
    let is_phone = strategy == "phone_code";
    let snapshot = if is_phone {
        verifications.phone_number.clone()
    } else {
        verifications.email_address.clone()
    };
    let Some(snapshot) = snapshot else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_CODE_INCORRECT,
            format!(
                "There is no {} verification in progress",
                if is_phone {
                    "phone number"
                } else {
                    "email address"
                }
            ),
        ));
    };
    let purpose = if is_phone {
        purposes::SIGN_UP_PHONE
    } else {
        purposes::SIGN_UP_EMAIL
    };
    let options = crate::signup::routes::completion_options(&state, &headers, true);
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
    // Completion purges other users' unverified claims on this email, and the
    // email may become verified in this very transaction. Lock those owners
    // (rank 3) from a plain read of the snapshot BEFORE the sign-up row (rank 4);
    // the version-checked save below refuses if the row moved meanwhile.
    let owners = match as_sign_up_fields(&row).email_address.as_deref() {
        Some(email) => Some(
            orbitid_identity::users::lock_unverified_claim_owners_on(&mut tx, email, "", &[])
                .await?,
        ),
        None => None,
    };
    orbitid_identity::locks::lock_sign_up_on(&mut tx, &row.id).await?;
    let verification = get_verification_on(&mut tx, purpose, &row.id, None).await?;
    if strategy == "email_link" {
        let clicked = verification
            .as_ref()
            .map(|row| row.verified_at.is_some() || row.consumed_at.is_some())
            .unwrap_or(false);
        if !clicked {
            // Nothing has been written yet. Release the connection — and the
            // client lock it holds — before `respond` serialises through the
            // pool, so the request completes on a one-connection pool.
            tx.rollback().await?;
            return respond(&state, &client, azp.as_deref(), &row, cookies).await;
        }
    } else if let CodeCheck::Refused(refusal) =
        check_code_on(&mut tx, &state, verification.as_ref(), body.code.as_deref()).await?
    {
        // The attempt counter must survive the refusal (a database failure
        // above propagated and rolled back instead).
        return Err(commit_code_refusal(tx, refusal).await?);
    }
    let mut next_snapshot = snapshot.clone();
    next_snapshot.status = "verified".into();
    next_snapshot.strategy = if is_phone {
        "phone_code".into()
    } else {
        snapshot.strategy.clone()
    };
    let next = SignUpVerifications {
        phone_number: if is_phone {
            Some(next_snapshot.clone())
        } else {
            verifications.phone_number.clone()
        },
        email_address: if is_phone {
            verifications.email_address.clone()
        } else {
            Some(next_snapshot)
        },
        ..verifications
    };
    let saved = save_sign_up_on(
        &mut tx,
        &row,
        SignUpPatch {
            verifications: Some(next),
            ..Default::default()
        },
    )
    .await?;
    let fields = as_sign_up_fields(&saved);
    let verifications = as_sign_up_verifications(&saved);
    let requirements = compute_requirements(&state, &fields, &verifications);
    let mut completed = None;
    if requirements.missing_fields.is_empty()
        && requirements.unverified_fields.is_empty()
        && (email_is_verified(&fields, &verifications)
            || phone_is_verified(&fields, &verifications)
            || fields.external_account.is_some())
    {
        completed =
            Some(complete_sign_up_on(&mut tx, &state, &saved, &options, owners.as_deref()).await?);
        if let Some((done, _)) = &completed {
            if let Some(token) = &done.client_token {
                cookies.push(orbitid_identity::client_auth::client_cookie(
                    &headers, &state, token,
                ));
            }
        }
    } else {
        save_sign_up_on(
            &mut tx,
            &saved,
            SignUpPatch {
                status: Some("missing_requirements".into()),
                ..Default::default()
            },
        )
        .await?;
    }
    tx.commit().await?;
    if let Some((done, user_input)) = completed {
        let _ = orbitid_identity::users::after_user_created(&state, &done.user, &user_input).await;
    }
    let row = crate::signup::core::reload_sign_up(&state, &row.id).await?;
    respond(&state, &client, azp.as_deref(), &row, cookies).await
}
