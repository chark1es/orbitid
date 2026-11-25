//! Create, read, and identifier resolution for a sign-in. Ported from
//! `modules/sign-in/creation.ts`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};
use orbitid_identity::sessions::{get_session, is_session_expired};
use orbitid_identity::users::{
    detect_identifier_type, get_user_by_id, get_user_by_identifier, normalize_email,
    normalize_phone, primary_email, IdentifierType,
};
use orbitid_platform::captcha::verify_captcha;

use crate::signin::core::{
    assert_sign_in_allowed, enterprise_connection_for_email, latest_transferable_sign_in,
    resolve_ticket, transition_sign_in, SignInTransition,
};
use crate::signin::helpers::{
    abandon_previous, attempt_password, load_sign_in, open_client, reload, respond_sign_in,
    start_enterprise,
};
use crate::signin::shared::{captcha_token, CreateBody};
use crate::util::{client_ip, hit, validate_redirect_url, Reply};

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    hit(
        &state,
        &format!("sign_in:create:{}", client_ip(&state, &headers)),
        100,
        60_000,
    )
    .await?;
    verify_captcha(
        &state,
        captcha_token(body.captcha_token.as_deref(), &headers).as_deref(),
        Some(&client_ip(&state, &headers)),
    )
    .await?;
    let settings = state.settings.get();
    if !settings.session.multi_session {
        if let Some(active_id) = &client.last_active_session_id {
            if let Some(active) = get_session(&state, active_id).await? {
                if active.status == "active" && !is_session_expired(&state, &active) {
                    let user = get_user_by_id(&state, &active.user_id).await?;
                    let email = match &user {
                        Some(user) => primary_email(&state, user).await?,
                        None => None,
                    };
                    return Err(OrbitError::bad_request(
                        error_codes::IDENTIFIER_ALREADY_SIGNED_IN,
                        "You are already signed in",
                    )
                    .with_meta(serde_json::json!({
                        "session_id": active.id,
                        "email_addresses": email.map(|email| vec![email.email]).unwrap_or_default(),
                    })));
                }
            }
        }
    }
    if body.transfer == Some(true)
        && body.identifier.is_none()
        && body.strategy.is_none()
        && body.ticket.is_none()
    {
        if let Some(transferable) = latest_transferable_sign_in(&state, &client.id).await? {
            return respond_sign_in(&state, &client, azp.as_deref(), &transferable, cookies).await;
        }
    }
    abandon_previous(&state, &client.id).await?;
    let redirect_url = validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?;
    let action_complete = validate_redirect_url(
        &state,
        body.action_complete_redirect_url.as_deref(),
        "action_complete_redirect_url",
    )?;
    let now = orbitid_core::http::now();
    let id = new_id(id_prefix::SIGN_IN);
    let state_json = crate::state::SignInState {
        redirect_url: redirect_url.clone(),
        action_complete_redirect_url: action_complete.clone(),
        azp: azp.clone(),
        ..Default::default()
    };
    sqlx::query(
        "INSERT INTO sign_ins (id, client_id, status, identifier, state, abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'needs_identifier',$3,$4,$5,$6,$6)",
    )
    .bind(&id)
    .bind(&client.id)
    .bind(body.identifier.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(sqlx::types::Json(serde_json::to_value(&state_json).unwrap_or_default()))
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&state.pool)
    .await?;
    let mut row = reload(&state, &id).await?;

    if let Some(ticket) = body.ticket.as_deref().filter(|value| !value.is_empty()) {
        return Err(resolve_ticket(&state, ticket));
    }

    if let Some(strategy) = body.strategy.as_deref().filter(|s| s.starts_with("oauth_")) {
        let provider = orbitid_federation::provider_key_from_strategy(strategy).to_string();
        if !orbitid_federation::is_provider_enabled(&state, &provider) {
            return Err(OrbitError::bad_request(
                error_codes::OAUTH_PROVIDER_NOT_ENABLED,
                format!("Social provider \"{provider}\" is not enabled"),
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        }
        let home = state.settings.get().application.home_url.clone();
        let (nonce, browser_hash) = orbitid_federation::bind_browser();
        let authorization = orbitid_federation::create_oauth_authorization(
            &state,
            &provider,
            orbitid_federation::oauth::OAuthFlow {
                client_id: client.id.clone(),
                kind: "sign_in".into(),
                owner_id: Some(row.id.clone()),
                user_id: None,
                redirect_url: redirect_url.clone().unwrap_or(home),
                action_complete_redirect_url: action_complete.clone(),
                additional_scopes: Vec::new(),
                browser_hash: String::new(),
            },
            browser_hash,
        )
        .await?;
        cookies.push(crate::util::oauth_browser_cookie(&state, &headers, &nonce));
        let mut next = state_json;
        next.first = Some(crate::state::FactorState {
            strategy: strategy.to_string(),
            status: Some("unverified".into()),
            external_verification_redirect_url: Some(authorization.url),
            ..Default::default()
        });
        transition_sign_in(
            &state,
            &row,
            SignInTransition {
                status: Some("needs_first_factor"),
                state: Some(&next),
                ..Default::default()
            },
        )
        .await?;
        row = reload(&state, &id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
    }

    if body.strategy.as_deref() == Some("enterprise_sso") {
        let Some(identifier) = body
            .identifier
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "identifier is missing",
            )
            .with_meta(serde_json::json!({ "param_name": "identifier" })));
        };
        let found = get_user_by_identifier(&state, identifier).await?;
        let email = match &found {
            Some((user, kind)) => {
                if *kind == IdentifierType::EmailAddress {
                    Some(identifier.to_string())
                } else {
                    primary_email(&state, user).await?.map(|email| email.email)
                }
            }
            None => (detect_identifier_type(identifier) == IdentifierType::EmailAddress)
                .then(|| identifier.to_string()),
        };
        let connection = match email {
            Some(email) => {
                enterprise_connection_for_email(&state, &normalize_email(&email)).await?
            }
            None => None,
        };
        let Some(connection) = connection else {
            if found.is_some() {
                return Err(OrbitError::bad_request(
                    error_codes::STRATEGY_FOR_USER_INVALID,
                    "No enterprise SSO connection matches this account",
                )
                .with_meta(serde_json::json!({ "param_name": "strategy" })));
            }
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_NOT_FOUND,
                "Couldn't find your account",
            )
            .with_meta(serde_json::json!({ "param_name": "identifier" })));
        };
        transition_sign_in(
            &state,
            &row,
            SignInTransition {
                user_id: found.as_ref().map(|(user, _)| user.id.as_str()),
                identifier: Some(identifier),
                ..Default::default()
            },
        )
        .await?;
        row = reload(&state, &id).await?;
        start_enterprise(&state, &row, &connection.id, identifier, &state_json).await?;
        row = reload(&state, &id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
    }

    let Some(identifier) = body.identifier.as_deref().filter(|value| !value.is_empty()) else {
        if body.strategy.as_deref() == Some("passkey") {
            crate::signin::helpers::assert_first_factor_enabled(&state, None, "passkey").await?;
            let mut next = state_json;
            next.first = Some(crate::state::FactorState {
                strategy: "passkey".into(),
                status: Some("unverified".into()),
                ..Default::default()
            });
            transition_sign_in(
                &state,
                &row,
                SignInTransition {
                    status: Some("needs_first_factor"),
                    state: Some(&next),
                    ..Default::default()
                },
            )
            .await?;
            row = reload(&state, &id).await?;
        }
        return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
    };

    let identifier = identifier.trim().to_string();
    let kind = detect_identifier_type(&identifier);
    assert_identifiers_allowed(
        &state,
        &IdentifiersToCheck {
            emails: if kind == IdentifierType::EmailAddress {
                vec![normalize_email(&identifier)]
            } else {
                Vec::new()
            },
            phones: if kind == IdentifierType::PhoneNumber {
                normalize_phone(&identifier).into_iter().collect()
            } else {
                Vec::new()
            },
            invitation_ticket: None,
        },
        true,
    )
    .await?;

    if kind == IdentifierType::EmailAddress {
        if let Some(connection) =
            enterprise_connection_for_email(&state, &normalize_email(&identifier)).await?
        {
            transition_sign_in(
                &state,
                &row,
                SignInTransition {
                    identifier: Some(&identifier),
                    ..Default::default()
                },
            )
            .await?;
            row = reload(&state, &id).await?;
            start_enterprise(&state, &row, &connection.id, &identifier, &state_json).await?;
            row = reload(&state, &id).await?;
            return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
        }
    }

    let found = get_user_by_identifier(&state, &identifier).await?;
    let Some((user, _)) = found else {
        if let Some(password) = body.password.as_deref().filter(|value| !value.is_empty()) {
            crate::signin::helpers::spend_password_check(None, Some(password)).await;
        }
        if state.settings.get().security.enumeration_protection {
            // Answer like an account that exists: a password sent along fails as a wrong one would.
            if body
                .password
                .as_deref()
                .is_some_and(|value| !value.is_empty())
                && body
                    .strategy
                    .as_deref()
                    .is_none_or(|strategy| strategy == "password")
            {
                return Err(crate::signin::decoy::password_incorrect(&row));
            }
            crate::signin::decoy::start(
                &state,
                &row,
                &identifier,
                state_json,
                body.strategy.as_deref(),
            )
            .await?;
            row = reload(&state, &id).await?;
            return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
        }
        let primary = OrbitError::unprocessable(
            error_codes::FORM_IDENTIFIER_NOT_FOUND,
            "Couldn't find your account",
        )
        .with_meta(serde_json::json!({ "param_name": "identifier" }));
        let second = OrbitError::unprocessable(
            error_codes::FORM_IDENTIFIER_NOT_FOUND,
            "Sign up to create an account",
        )
        .with_meta(serde_json::json!({ "param_name": "identifier" }));
        return Err(primary.with_items(vec![
            OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_NOT_FOUND,
                "Couldn't find your account",
            )
            .with_meta(serde_json::json!({ "param_name": "identifier" }))
            .to_item(),
            second.to_item(),
        ]));
    };
    assert_sign_in_allowed(&user)?;
    transition_sign_in(
        &state,
        &row,
        SignInTransition {
            user_id: Some(&user.id),
            identifier: Some(&identifier),
            ..Default::default()
        },
    )
    .await?;
    row = reload(&state, &id).await?;

    if kind == IdentifierType::EmailAddress {
        if let Some(connection) =
            enterprise_connection_for_email(&state, &normalize_email(&identifier)).await?
        {
            start_enterprise(&state, &row, &connection.id, &identifier, &state_json).await?;
            row = reload(&state, &id).await?;
            return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
        }
    }

    if body
        .password
        .as_deref()
        .filter(|value| !value.is_empty())
        .is_some()
        && body
            .strategy
            .as_deref()
            .map(|strategy| strategy == "password")
            .unwrap_or(true)
    {
        attempt_password(
            &state,
            &headers,
            &row,
            body.password.as_deref(),
            &mut cookies,
        )
        .await?;
        row = reload(&state, &id).await?;
        return respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await;
    }

    if let Some(strategy) = body.strategy.as_deref() {
        if ![
            "password",
            "email_code",
            "email_link",
            "phone_code",
            "passkey",
            "reset_password_email_code",
            "reset_password_phone_code",
        ]
        .contains(&strategy)
        {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                format!("Strategy \"{strategy}\" is not valid for this user"),
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        }
    }

    let requested_reset = matches!(
        body.strategy.as_deref(),
        Some("reset_password_email_code") | Some("reset_password_phone_code")
    );
    let mut next = state_json;
    next.requested_reset = requested_reset.then_some(true);
    next.first = body
        .strategy
        .as_ref()
        .map(|strategy| crate::state::FactorState::new(strategy).status("unverified"));
    transition_sign_in(
        &state,
        &row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&next),
            ..Default::default()
        },
    )
    .await?;
    row = reload(&state, &id).await?;
    respond_sign_in(&state, &client, azp.as_deref(), &row, cookies).await
}

pub async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "GET", "/v1/client/sign_ins").await?;
    let row = load_sign_in(&state, &client.id, &id).await?;
    let azp = client_azp(&headers);
    respond_sign_in(
        &state,
        &client,
        azp.as_deref(),
        &row,
        cookie.into_iter().collect(),
    )
    .await
}
