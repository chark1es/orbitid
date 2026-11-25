//! First-factor preparation. Ported from `modules/sign-in/first-factor.ts`
//! (the `prepare_first_factor` handler).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{ClientRow, SignInRow};
use orbitid_core::state::AppState;
use orbitid_credentials::passkeys::fapi::{store_passkey_challenge_on, AUTHENTICATION_PURPOSE};
use orbitid_credentials::passkeys::{list_passkeys, relying_party, webauthn};
use orbitid_credentials::CredentialDescriptor;
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::users::{get_user_by_id, primary_email};
use orbitid_identity::verifications::{
    issue_verification_on, magic_link_url, IssueVerificationInput,
};
use orbitid_platform::captcha::verify_captcha;
use orbitid_platform::mail::{send_email, send_sms, EmailTemplate, SendEmailInput};

use crate::signin::core::{
    as_sign_in_state, assert_sign_in_allowed, enterprise_connection_for_email, transition_sign_in,
    transition_sign_in_on, verified_email_of, verified_phone_of, SignInTransition,
};
use crate::signin::helpers::{
    assert_first_factor_enabled, load_sign_in, open_client, reload, respond_sign_in,
    start_enterprise,
};
use crate::signin::shared::{captcha_token, PrepareFirstBody};
use crate::state::{FactorState, SignInState};
use crate::util::{client_ip, hit, oauth_browser_cookie, validate_redirect_url, Reply};

async fn advance(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
    row: &SignInRow,
    next: &SignInState,
    cookies: Vec<String>,
) -> Result<Reply> {
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(next),
            ..Default::default()
        },
    )
    .await?;
    let fresh = reload(state, &row.id).await?;
    respond_sign_in(state, client, azp, &fresh, cookies).await
}

pub async fn prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PrepareFirstBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    let row = load_sign_in(&state, &client.id, &id).await?;
    let mut current = as_sign_in_state(&row);
    let strategy = body
        .strategy
        .clone()
        .or_else(|| current.first.as_ref().map(|first| first.strategy.clone()))
        .unwrap_or_else(|| "password".into());
    if row.status != "needs_first_factor"
        && !(row.status == "needs_identifier" && strategy == "passkey")
    {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in is not waiting for a first factor",
        ));
    }
    hit(
        &state,
        &format!("sign_in:prepare:{}", client_ip(&state, &headers)),
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
    if strategy != "passkey" && crate::signin::decoy::is_decoy(&row) {
        crate::signin::decoy::prepare(&state, &row, &strategy, &body).await?;
        let fresh = reload(&state, &row.id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
    }
    let user = match &row.user_id {
        Some(user_id) => get_user_by_id(&state, user_id).await?,
        None => None,
    };
    if user.is_none() && strategy != "passkey" {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Sign-in has no user",
        ));
    }
    if let Some(user) = &user {
        assert_sign_in_allowed(user)?;
    }
    assert_first_factor_enabled(&state, user.as_ref(), &strategy).await?;
    let email = match &body.email_address_id {
        Some(email_id) => {
            sqlx::query_as::<_, orbitid_core::models::EmailAddressRow>(
                "SELECT * FROM email_addresses WHERE id = $1",
            )
            .bind(email_id)
            .fetch_optional(&state.pool)
            .await?
        }
        None => match &user {
            Some(user) => verified_email_of(&state, user).await?,
            None => None,
        },
    };
    let phone = match &body.phone_number_id {
        Some(phone_id) => {
            sqlx::query_as::<_, orbitid_core::models::PhoneNumberRow>(
                "SELECT * FROM phone_numbers WHERE id = $1",
            )
            .bind(phone_id)
            .fetch_optional(&state.pool)
            .await?
        }
        None => match &user {
            Some(user) => verified_phone_of(&state, user).await?,
            None => None,
        },
    };
    if let (Some(email), Some(user)) = (&email, &user) {
        if email.user_id.as_deref() != Some(user.id.as_str()) {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Email address not found",
            ));
        }
    }
    if let (Some(phone), Some(user)) = (&phone, &user) {
        if phone.user_id.as_deref() != Some(user.id.as_str()) {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Phone number not found",
            ));
        }
    }
    let settings = state.settings.get();
    let target_email = match (&email, &user) {
        (Some(email), _) => Some(email.clone()),
        (None, Some(user)) => primary_email(&state, user).await?,
        (None, None) => None,
    };

    match strategy.as_str() {
        "password" => {
            current.first = Some(FactorState::new("password").status("unverified"));
            advance(&state, &client, azp.as_deref(), &row, &current, cookies).await
        }
        "email_code" | "reset_password_email_code" => {
            let Some(target_email) = target_email.filter(|email| email.verified) else {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "This account has no verified email address",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            };
            let is_reset = strategy.starts_with("reset_password");
            // The verification insert and the attempt's state transition
            // commit together; delivery is post-commit best-effort.
            let mut tx = state.pool.begin().await?;
            orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
            orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
            let issued = issue_verification_on(
                &mut tx,
                &state,
                IssueVerificationInput::new(
                    if is_reset {
                        orbitid_identity::verifications::purposes::RESET_PASSWORD
                    } else {
                        orbitid_identity::verifications::purposes::SIGN_IN_FIRST_FACTOR
                    },
                    "email_code",
                    &target_email.email,
                    &row.id,
                    settings.email.code_lifetime_seconds,
                ),
            )
            .await?;
            current.first = Some(FactorState {
                strategy: strategy.clone(),
                verification_id: Some(issued.row.id.clone()),
                email_id: Some(target_email.id.clone()),
                status: Some("unverified".into()),
                ..Default::default()
            });
            current.requested_reset = is_reset.then_some(true);
            transition_sign_in_on(
                &mut tx,
                &row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&current),
                    ..Default::default()
                },
            )
            .await?;
            tx.commit().await?;
            let mut input = SendEmailInput::new(
                target_email.email.clone(),
                if is_reset {
                    EmailTemplate::ResetPasswordCode
                } else {
                    EmailTemplate::VerificationCode
                },
            );
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
            if let Some(user) = &user {
                if let Some(name) = &user.first_name {
                    input
                        .vars
                        .insert("user_name".into(), serde_json::json!(name));
                }
            }
            let _ = send_email(&state, input).await;
            let fresh = reload(&state, &row.id).await?;
            respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
        }
        "email_link" => {
            let Some(target_email) = target_email.filter(|email| email.verified) else {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "This account has no verified email address",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            };
            let redirect =
                validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?
                    .or_else(|| current.redirect_url.clone());
            let mut issue = IssueVerificationInput::new(
                orbitid_identity::verifications::purposes::SIGN_IN_FIRST_FACTOR,
                "email_link",
                &target_email.email,
                &row.id,
                settings.email.link_lifetime_seconds,
            );
            issue.redirect_url = redirect;
            let mut tx = state.pool.begin().await?;
            orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
            orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
            let issued = issue_verification_on(&mut tx, &state, issue).await?;
            current.first = Some(FactorState {
                strategy: strategy.clone(),
                verification_id: Some(issued.row.id.clone()),
                email_id: Some(target_email.id.clone()),
                status: Some("unverified".into()),
                ..Default::default()
            });
            transition_sign_in_on(
                &mut tx,
                &row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&current),
                    ..Default::default()
                },
            )
            .await?;
            tx.commit().await?;
            let link = magic_link_url(
                &state,
                issued.token.as_deref().unwrap_or_default(),
                &[("sign_in_id", Some(row.id.as_str()))],
            );
            let mut input =
                SendEmailInput::new(target_email.email.clone(), EmailTemplate::MagicLink);
            input.vars.insert("link".into(), serde_json::json!(link));
            input.vars.insert(
                "expires_in_minutes".into(),
                serde_json::json!(
                    (settings.email.link_lifetime_seconds as f64 / 60.0).round() as i64
                ),
            );
            if let Some(user) = &user {
                if let Some(name) = &user.first_name {
                    input
                        .vars
                        .insert("user_name".into(), serde_json::json!(name));
                }
            }
            let _ = send_email(&state, input).await;
            let fresh = reload(&state, &row.id).await?;
            respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
        }
        "phone_code" | "reset_password_phone_code" => {
            let Some(phone) = phone.filter(|phone| phone.verified) else {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "This account has no verified phone number",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            };
            let is_reset = strategy.starts_with("reset_password");
            let mut tx = state.pool.begin().await?;
            orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
            orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
            let issued = issue_verification_on(
                &mut tx,
                &state,
                IssueVerificationInput::new(
                    if is_reset {
                        orbitid_identity::verifications::purposes::RESET_PASSWORD
                    } else {
                        orbitid_identity::verifications::purposes::SIGN_IN_FIRST_FACTOR
                    },
                    "phone_code",
                    &phone.phone,
                    &row.id,
                    settings.email.code_lifetime_seconds,
                ),
            )
            .await?;
            current.first = Some(FactorState {
                strategy: strategy.clone(),
                verification_id: Some(issued.row.id.clone()),
                phone_id: Some(phone.id.clone()),
                status: Some("unverified".into()),
                ..Default::default()
            });
            current.requested_reset = is_reset.then_some(true);
            transition_sign_in_on(
                &mut tx,
                &row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&current),
                    ..Default::default()
                },
            )
            .await?;
            tx.commit().await?;
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
            let fresh = reload(&state, &row.id).await?;
            respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
        }
        "passkey" => {
            let rp = relying_party(&state, headers.get("origin").and_then(|v| v.to_str().ok()))?;
            let allow_credentials = match &user {
                Some(user) => list_passkeys(&state.pool, &user.id)
                    .await?
                    .into_iter()
                    .map(|passkey| CredentialDescriptor {
                        id: passkey.credential_id,
                        key_type: "public-key".into(),
                        transports: passkey.transports.map(|transports| transports.0),
                    })
                    .collect(),
                None => Vec::new(),
            };
            let options = webauthn::request_options(&rp.rp_id, allow_credentials);
            let mut tx = state.pool.begin().await?;
            orbitid_identity::locks::lock_client_on(&mut tx, &row.client_id).await?;
            orbitid_identity::locks::lock_sign_in_on(&mut tx, &row.id).await?;
            store_passkey_challenge_on(
                &mut tx,
                AUTHENTICATION_PURPOSE,
                &row.id,
                &options.challenge,
                serde_json::json!({
                    "rpID": rp.rp_id,
                    "origin": rp.origin,
                    "userId": user.as_ref().map(|user| user.id.clone()),
                }),
            )
            .await?;
            current.first = Some(FactorState {
                strategy: "passkey".into(),
                status: Some("unverified".into()),
                nonce: serde_json::to_string(&options).ok(),
                ..Default::default()
            });
            transition_sign_in_on(
                &mut tx,
                &row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&current),
                    ..Default::default()
                },
            )
            .await?;
            tx.commit().await?;
            let fresh = reload(&state, &row.id).await?;
            respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
        }
        _ if strategy.starts_with("oauth_") => {
            let provider = orbitid_federation::provider_key_from_strategy(&strategy).to_string();
            if !orbitid_federation::is_provider_enabled(&state, &provider) {
                return Err(OrbitError::bad_request(
                    error_codes::OAUTH_PROVIDER_NOT_ENABLED,
                    format!("Social provider \"{provider}\" is not enabled"),
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            }
            let (nonce, browser_hash) = orbitid_federation::bind_browser();
            let authorization = orbitid_federation::create_oauth_authorization(
                &state,
                &provider,
                orbitid_federation::oauth::OAuthFlow {
                    client_id: client.id.clone(),
                    kind: "sign_in".into(),
                    owner_id: Some(row.id.clone()),
                    user_id: None,
                    redirect_url: current
                        .redirect_url
                        .clone()
                        .unwrap_or_else(|| settings.application.home_url.clone()),
                    action_complete_redirect_url: current.action_complete_redirect_url.clone(),
                    additional_scopes: Vec::new(),
                    browser_hash: String::new(),
                },
                browser_hash,
            )
            .await?;
            cookies.push(oauth_browser_cookie(&state, &headers, &nonce));
            current.first = Some(FactorState {
                strategy: strategy.clone(),
                status: Some("unverified".into()),
                external_verification_redirect_url: Some(authorization.url),
                ..Default::default()
            });
            advance(&state, &client, azp.as_deref(), &row, &current, cookies).await
        }
        "enterprise_sso" => {
            let Some(email) = target_email.as_ref().map(|email| email.email.clone()) else {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "This account has no verified email address",
                ));
            };
            let Some(connection) = enterprise_connection_for_email(&state, &email).await? else {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "No enterprise SSO connection matches this account",
                ));
            };
            start_enterprise(
                &state,
                &row,
                &connection.id,
                row.identifier.as_deref().unwrap_or(&email),
                &current,
            )
            .await?;
            let fresh = reload(&state, &row.id).await?;
            respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
        }
        _ => Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Strategy \"{strategy}\" is not valid for this user"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" }))),
    }
}
