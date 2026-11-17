//! `/v1/client/sign_ups` create/read/patch. Ported from `modules/sign-up.ts`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::state::AppState;
use orbitid_identity::restrictions::redeem_ticket;
use orbitid_identity::users::normalize_email;
use orbitid_platform::captcha::verify_captcha;

use crate::signin::core::{
    clear_transfer_profile, latest_transferable_sign_in, read_transfer_profile,
};
use crate::signin::shared::captcha_token;
use crate::signup::core::{
    apply_external_profile, as_sign_up_fields, as_sign_up_verifications,
    assert_sign_up_identifiers, complete_sign_up_on, maybe_complete_sign_up,
    save_and_maybe_complete_on, save_sign_up, CompleteSignUpOptions, SignUpIdentifierOptions,
    SignUpPatch,
};
use crate::signup::helpers::{
    abandon_previous, apply_body_fields, azp, load_sign_up, open_client, respond, validate_legal,
    CreateBody, UpdateBody,
};
use crate::state::{SignUpFields, SignUpVerifications, VerificationSnapshot};
use crate::util::{client_ip, hit, validate_redirect_url, Reply};

fn update_from_create(body: &CreateBody) -> UpdateBody {
    UpdateBody {
        email_address: body.email_address.clone().map(serde_json::Value::String),
        phone_number: body.phone_number.clone().map(serde_json::Value::String),
        username: body.username.clone().map(serde_json::Value::String),
        first_name: body.first_name.clone().map(serde_json::Value::String),
        last_name: body.last_name.clone().map(serde_json::Value::String),
        password: body.password.clone().map(serde_json::Value::String),
        external_id: body.external_id.clone(),
        ..Default::default()
    }
}

pub(crate) fn completion_options(
    state: &AppState,
    headers: &HeaderMap,
    rotate: bool,
) -> CompleteSignUpOptions {
    CompleteSignUpOptions {
        ip: Some(client_ip(state, headers)),
        user_agent: headers
            .get("user-agent")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string),
        rotate_client_token: rotate,
    }
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ups").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = azp(&headers);
    hit(
        &state,
        &format!("sign_up:create:{}", client_ip(&state, &headers)),
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
    abandon_previous(&state, &client.id).await?;
    let redirect_url = validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?;
    let action_complete = validate_redirect_url(
        &state,
        body.action_complete_redirect_url.as_deref(),
        "action_complete_redirect_url",
    )?;
    let now = orbitid_core::http::now();
    let id = new_id(id_prefix::SIGN_UP);
    sqlx::query(
        "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, \
         abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'missing_requirements','{}'::jsonb,$3,'{}'::jsonb,$4,$5,$5)",
    )
    .bind(&id)
    .bind(&client.id)
    .bind(sqlx::types::Json(
        body.unsafe_metadata
            .clone()
            .unwrap_or_else(|| serde_json::json!({})),
    ))
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&state.pool)
    .await?;
    let mut row = crate::signup::core::reload_sign_up(&state, &id).await?;

    if body.strategy.as_deref() == Some("anonymous") {
        let settings = state.settings.get();
        if !settings.anonymous.enabled {
            return Err(OrbitError::forbidden(
                error_codes::SIGN_UP_RESTRICTED,
                "Anonymous accounts are disabled on this instance",
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        }
        if settings.sign_up.mode != orbitid_core::settings::types::SignUpMode::Public {
            return Err(OrbitError::unprocessable(
                error_codes::SIGN_UP_RESTRICTED,
                "Anonymous accounts are only available when sign-ups are public",
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        }
        validate_legal(&state, body.legal_accepted)?;
        hit(
            &state,
            &format!("sign_up:anonymous:{}", client_ip(&state, &headers)),
            10,
            60 * 60_000,
        )
        .await?;
        // The anonymous fields and the completion (user + session + events)
        // commit as one transaction.
        let mut tx = state.pool.begin().await?;
        let saved = crate::signup::core::save_sign_up_on(
            &mut tx,
            &row,
            SignUpPatch {
                fields: Some(SignUpFields {
                    anonymous: Some(true),
                    legal_accepted_at: (body.legal_accepted == Some(true)).then_some(now),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;
        let (completed, user_input) = complete_sign_up_on(
            &mut tx,
            &state,
            &saved,
            &completion_options(&state, &headers, true),
            // Anonymous: the row has no email, so there are no owners to lock; `Some(&[])`
            // keeps the standalone rank-3 lock from ever running after this rank-4 save.
            Some(&[]),
        )
        .await?;
        tx.commit().await?;
        let _ =
            orbitid_identity::users::after_user_created(&state, &completed.user, &user_input).await;
        if let Some(token) = completed.client_token {
            cookies.push(orbitid_identity::client_auth::client_cookie(
                &headers, &state, &token,
            ));
        }
        row = crate::signup::core::reload_sign_up(&state, &row.id).await?;
        return respond(&state, &client, azp.as_deref(), &row, cookies).await;
    }

    if let Some(strategy) = body.strategy.as_deref().filter(|s| s.starts_with("oauth_")) {
        validate_legal(&state, body.legal_accepted)?;
        let update = update_from_create(&body);
        let mut fields = apply_body_fields(&state, &SignUpFields::default(), &update).await?;
        if body.legal_accepted == Some(true) {
            fields.legal_accepted_at = Some(now);
        }
        row = save_sign_up(
            &state,
            &row,
            SignUpPatch {
                fields: Some(fields),
                ..Default::default()
            },
        )
        .await?;
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
                kind: "sign_up".into(),
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
        row = save_sign_up(
            &state,
            &row,
            SignUpPatch {
                verifications: Some(SignUpVerifications {
                    external_account: Some(VerificationSnapshot {
                        status: "unverified".into(),
                        strategy: format!("from_oauth_{provider}"),
                        external_verification_redirect_url: Some(authorization.url),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;
        return respond(&state, &client, azp.as_deref(), &row, cookies).await;
    }
    if body.transfer == Some(true) {
        let sign_in = latest_transferable_sign_in(&state, &client.id).await?;
        let profile = sign_in
            .as_ref()
            .and_then(|sign_in| read_transfer_profile(&state, sign_in));
        let (Some(sign_in), Some(profile)) = (sign_in, profile) else {
            return Err(OrbitError::bad_request(
                error_codes::CLIENT_STATE_INVALID,
                "There is no transferable sign-in to continue",
            ));
        };
        row = save_sign_up(
            &state,
            &row,
            SignUpPatch {
                fields: Some(SignUpFields::default()),
                ..Default::default()
            },
        )
        .await?;
        let updated = apply_external_profile(&state, &row, &profile).await?;
        let updated = if body.legal_accepted == Some(true) {
            let mut fields = as_sign_up_fields(&updated);
            fields.legal_accepted_at = Some(now);
            save_sign_up(
                &state,
                &updated,
                SignUpPatch {
                    fields: Some(fields),
                    ..Default::default()
                },
            )
            .await?
        } else {
            updated
        };
        assert_sign_up_identifiers(
            &state,
            &as_sign_up_fields(&updated),
            &SignUpIdentifierOptions::default(),
        )
        .await?;
        clear_transfer_profile(&state, &sign_in).await?;
        let completed = maybe_complete_sign_up(
            &state,
            &updated,
            &completion_options(&state, &headers, true),
        )
        .await?;
        if let Some(completed) = completed {
            if let Some(token) = completed.client_token {
                cookies.push(orbitid_identity::client_auth::client_cookie(
                    &headers, &state, &token,
                ));
            }
        }
        row = crate::signup::core::reload_sign_up(&state, &row.id).await?;
        return respond(&state, &client, azp.as_deref(), &row, cookies).await;
    }

    let mut invitation_email: Option<String> = None;
    let ticket = body.ticket.as_deref().filter(|value| !value.is_empty());
    if let Some(ticket) = ticket {
        let grant = redeem_ticket(&state, ticket).await?;
        if grant.kind != "invitation" {
            return Err(OrbitError::unprocessable(
                error_codes::TICKET_INVALID,
                "This ticket can only be used to sign in",
            ));
        }
        let email = normalize_email(&grant.email);
        invitation_email = Some(email.clone());
        row = save_sign_up(
            &state,
            &row,
            SignUpPatch {
                invitation_id: Some(Some(grant.invitation_id.clone())),
                fields: Some(SignUpFields {
                    email_address: Some(email),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;
    }

    validate_legal(&state, body.legal_accepted)?;
    let update = update_from_create(&body);
    let mut fields = apply_body_fields(&state, &as_sign_up_fields(&row), &update).await?;
    if let Some(invitation_email) = &invitation_email {
        if fields.email_address.as_deref() != Some(invitation_email.as_str()) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                "The email address must match the invitation",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
    }
    if body.legal_accepted == Some(true) {
        fields.legal_accepted_at = Some(now);
    }
    if fields.email_address.is_some() || fields.phone_number.is_some() {
        assert_sign_up_identifiers(
            &state,
            &fields,
            &SignUpIdentifierOptions {
                ticket: ticket.is_some(),
                invitation_ticket: ticket.map(str::to_string),
                verified_email: false,
            },
        )
        .await?;
    }
    // The fields snapshot, the completion decision and any user/session
    // creation are one transaction (and one CAS).
    let mut tx = state.pool.begin().await?;
    let (saved, completed) = save_and_maybe_complete_on(
        &mut tx,
        &state,
        &row,
        SignUpPatch {
            fields: Some(fields),
            ..Default::default()
        },
        &completion_options(&state, &headers, true),
    )
    .await?;
    tx.commit().await?;
    if let Some((completed, user_input)) = completed {
        let _ =
            orbitid_identity::users::after_user_created(&state, &completed.user, &user_input).await;
        if let Some(token) = completed.client_token {
            cookies.push(orbitid_identity::client_auth::client_cookie(
                &headers, &state, &token,
            ));
        }
    }
    row = crate::signup::core::reload_sign_up(&state, &saved.id).await?;
    respond(&state, &client, azp.as_deref(), &row, cookies).await
}

pub async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "GET", "/v1/client/sign_ups").await?;
    let row = load_sign_up(&state, &client.id, &id).await?;
    let azp = azp(&headers);
    respond(
        &state,
        &client,
        azp.as_deref(),
        &row,
        cookie.into_iter().collect(),
    )
    .await
}

pub async fn patch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Reply> {
    let body = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "PATCH", "/v1/client/sign_ups").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = azp(&headers);
    let row = load_sign_up(&state, &client.id, &id).await?;
    if row.status == "complete" {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ));
    }
    let existing_legal = as_sign_up_fields(&row).legal_accepted_at.is_some();
    validate_legal(
        &state,
        body.legal_accepted.or(existing_legal.then_some(true)),
    )?;
    let mut fields = apply_body_fields(&state, &as_sign_up_fields(&row), &body).await?;
    if body.legal_accepted == Some(true) {
        fields.legal_accepted_at = Some(orbitid_core::http::now());
    }
    let identifier_changed = matches!(body.email_address, Some(serde_json::Value::String(_)))
        || matches!(body.phone_number, Some(serde_json::Value::String(_)));
    let mut verifications = as_sign_up_verifications(&row);
    if identifier_changed {
        assert_sign_up_identifiers(&state, &fields, &SignUpIdentifierOptions::default()).await?;
        if matches!(body.email_address, Some(serde_json::Value::String(_))) {
            verifications.email_address = None;
        }
        if matches!(body.phone_number, Some(serde_json::Value::String(_))) {
            verifications.phone_number = None;
        }
    }
    // Fields and verification clearing are one atomic write: a request that
    // changes the email must never persist the new address without also
    // clearing the old verification (or vice versa).
    let mut tx = state.pool.begin().await?;
    let (_updated, completed) = save_and_maybe_complete_on(
        &mut tx,
        &state,
        &row,
        SignUpPatch {
            fields: Some(fields),
            verifications: identifier_changed.then_some(verifications),
            unsafe_metadata: crate::signup::helpers::as_metadata(&body.unsafe_metadata)
                .or_else(|| Some(crate::signup::core::metadata_object(&row.unsafe_metadata.0))),
            ..Default::default()
        },
        &completion_options(&state, &headers, true),
    )
    .await?;
    tx.commit().await?;
    if let Some((completed, user_input)) = completed {
        let _ =
            orbitid_identity::users::after_user_created(&state, &completed.user, &user_input).await;
        if let Some(token) = completed.client_token {
            cookies.push(orbitid_identity::client_auth::client_cookie(
                &headers, &state, &token,
            ));
        }
    }
    let row = crate::signup::core::reload_sign_up(&state, &row.id).await?;
    respond(&state, &client, azp.as_deref(), &row, cookies).await
}
