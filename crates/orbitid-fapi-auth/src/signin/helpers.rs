//! Closures shared by the sign-in route groups: state loading, client
//! responses and factor completion. Ported from `modules/sign-in/helpers.ts`.

use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{ClientRow, SignInRow, UserRow};
use orbitid_core::resources::{ClientJson, SignInJson, SignUpJson};
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::{
    client_azp, client_cookie, get_or_create_client, inflight_sign_in, inflight_sign_up,
    serialize_client_with,
};
use orbitid_identity::sessions::{get_session, send_new_sign_in_email};
use orbitid_identity::trusted_devices::{
    apply_trusted_device_cookie, read_trusted_device_token, TrustedDeviceCookie,
};
use orbitid_identity::users::{get_user_by_id, record_failed_attempt, reset_failed_attempts_on};
use orbitid_identity::verifications::check_code;

use crate::signin::complete::{after_first_factor, CompleteOptions};
use crate::signin::core::{
    as_sign_in_state, assert_sign_in_allowed, build_sign_in_json, compute_first_factors,
    save_sign_in_state_on, transition_sign_in, SignInTransition,
};
use crate::state::SignInState;
use crate::util::{client_ip, header, Reply};

/// `getOrCreateClient` plus the cookie it may have minted.
pub async fn open_client(
    state: &AppState,
    headers: &HeaderMap,
    method: &str,
    path: &str,
) -> Result<(ClientRow, Option<String>)> {
    get_or_create_client(state, headers, method, path).await
}

pub fn azp(headers: &HeaderMap) -> Option<String> {
    client_azp(headers)
}

/// Full client projection including any in-flight sign-in/sign-up.
pub async fn serialize_client_full(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
) -> Result<ClientJson> {
    let sign_in_row = inflight_sign_in(state, &client.id).await?;
    let sign_up_row = inflight_sign_up(state, &client.id).await?;
    let sign_in: Option<SignInJson> = match &sign_in_row {
        Some(row) => Some(build_sign_in_json(state, row).await?),
        None => None,
    };
    let sign_up: Option<SignUpJson> = match &sign_up_row {
        Some(row) => Some(crate::signup::core::build_sign_up_json(state, row).await?),
        None => None,
    };
    serialize_client_with(state, client, azp, true, sign_in, sign_up).await
}

/// `{ response: SignInJSON, client: ClientJSON }`.
pub async fn respond_sign_in(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
    row: &SignInRow,
    cookies: Vec<String>,
) -> Result<Reply> {
    let response = build_sign_in_json(state, row).await?;
    let client_json = serialize_client_full(state, client, azp).await?;
    Ok(Reply::json(serde_json::json!({
        "response": response,
        "client": client_json,
    }))
    .cookies(cookies))
}

pub async fn respond_sign_up(
    state: &AppState,
    client: &ClientRow,
    azp: Option<&str>,
    row: &orbitid_core::models::SignUpRow,
    cookies: Vec<String>,
) -> Result<Reply> {
    let response = crate::signup::core::build_sign_up_json(state, row).await?;
    let client_json = serialize_client_full(state, client, azp).await?;
    Ok(Reply::json(serde_json::json!({
        "response": response,
        "client": client_json,
    }))
    .cookies(cookies))
}

pub fn completion_options(headers: &HeaderMap, state: &AppState) -> CompleteOptions {
    CompleteOptions {
        ip: Some(client_ip(state, headers)),
        user_agent: header(headers, "user-agent"),
        second_factor: false,
        rotate_client_token: true,
        method: None,
    }
}

/// Pushes the rotated `__client` cookie when session creation rotated it.
pub fn apply_client_token(
    headers: &HeaderMap,
    state: &AppState,
    cookies: &mut Vec<String>,
    token: Option<String>,
) {
    if let Some(token) = token {
        cookies.push(client_cookie(headers, state, &token));
    }
}

pub fn apply_trusted_device(
    state: &AppState,
    cookies: &mut Vec<String>,
    result: &TrustedDeviceCookie,
) {
    if result.token.is_none() && !result.clear {
        return;
    }
    let mut map = HeaderMap::new();
    apply_trusted_device_cookie(&mut map, state, result);
    for value in map.get_all(axum::http::header::SET_COOKIE) {
        if let Ok(value) = value.to_str() {
            cookies.push(value.to_string());
        }
    }
}

pub async fn load_sign_in(state: &AppState, client_id: &str, id: &str) -> Result<SignInRow> {
    let row = sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-in not found")
        })?;
    if row.client_id != client_id {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Sign-in not found",
        ));
    }
    Ok(row)
}

pub async fn reload(state: &AppState, id: &str) -> Result<SignInRow> {
    crate::signin::core::reload_sign_in(state, id).await
}

/// Abandons every still-open sign-in for the client.
pub async fn abandon_previous(state: &AppState, client_id: &str) -> Result<()> {
    for status in [
        "needs_identifier",
        "needs_first_factor",
        "needs_second_factor",
        "needs_new_password",
    ] {
        crate::signin::complete::abandon_sign_ins_with_status(state, client_id, status).await?;
    }
    Ok(())
}

pub async fn user_for_row(state: &AppState, row: &SignInRow) -> Result<UserRow> {
    let Some(user_id) = &row.user_id else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Sign-in has no user",
        ));
    };
    get_user_by_id(state, user_id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))
}

/// `checkCode` with a failed-attempt record on a wrong code.
pub async fn check_sign_in_code(
    state: &AppState,
    user: &UserRow,
    verification: Option<&orbitid_core::models::VerificationRow>,
    code: Option<&str>,
) -> Result<orbitid_core::models::VerificationRow> {
    match check_code(state, verification, code).await {
        Ok(row) => Ok(row),
        Err(error) => {
            if error.code == error_codes::FORM_CODE_INCORRECT {
                record_failed_attempt(state, &user.id).await?;
            }
            Err(error)
        }
    }
}

pub async fn notify_session(state: &AppState, user: &UserRow, session_id: &str) -> Result<()> {
    if let Some(session) = get_session(state, session_id).await? {
        send_new_sign_in_email(state, user, &session, orbitid_core::http::now()).await?;
    }
    Ok(())
}

/// A first factor the instance switched off (or the user cannot use) is refused.
pub async fn assert_first_factor_enabled(
    state: &AppState,
    user: Option<&UserRow>,
    strategy: &str,
) -> Result<()> {
    if strategy == "passkey" {
        let passkeys = state.settings.get().attributes.passkey.clone();
        if !passkeys.enabled || !passkeys.used_for_first_factor {
            return Err(OrbitError::bad_request(
                error_codes::STRATEGY_FOR_USER_INVALID,
                "Sign-in with passkeys is not enabled",
            )
            .with_meta(serde_json::json!({ "param_name": "strategy" })));
        }
        return Ok(());
    }
    let Some(user) = user else { return Ok(()) };
    if !matches!(
        strategy,
        "password" | "email_code" | "email_link" | "phone_code"
    ) {
        return Ok(());
    }
    let allowed = compute_first_factors(state, user, false).await?;
    if !allowed.iter().any(|factor| factor.strategy == strategy) {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            format!("Sign-in with \"{strategy}\" is not enabled for this account"),
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    }
    Ok(())
}

/// Constant-work password check against a dummy hash.
pub async fn spend_password_check(hash: Option<&str>, password: Option<&str>) -> bool {
    match hash {
        None => {
            let dummy = crate::signin::shared::dummy_password_hash().await;
            orbitid_credentials::verify_password(&dummy, password.unwrap_or("not-the-password"))
                .await;
            false
        }
        Some(hash) => orbitid_credentials::verify_password(hash, password.unwrap_or("")).await,
    }
}

/// Persists the first factor, advances the state machine and returns the
/// resulting status. The caller re-reads the row before responding.
pub async fn after_first(
    state: &AppState,
    headers: &HeaderMap,
    row: &SignInRow,
    user: &UserRow,
    cookies: &mut Vec<String>,
) -> Result<crate::signin::complete::AfterFirstFactorResult> {
    let options = completion_options(headers, state);
    let result = after_first_factor(
        state,
        row,
        user,
        &options,
        read_trusted_device_token(headers).as_deref(),
    )
    .await?;
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
    Ok(result)
}

pub async fn attempt_password(
    state: &AppState,
    headers: &HeaderMap,
    row: &SignInRow,
    password: Option<&str>,
    cookies: &mut Vec<String>,
) -> Result<()> {
    let user = user_for_row(state, row).await?;
    assert_sign_in_allowed(&user)?;
    assert_first_factor_enabled(state, Some(&user), "password").await?;
    let Some(hash) = user.password_hash.clone() else {
        spend_password_check(None, password).await;
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            "This account does not use a password",
        )
        .with_meta(serde_json::json!({ "param_name": "strategy" })));
    };
    let Some(password) = password.filter(|value| !value.is_empty()) else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "password is missing",
        )
        .with_meta(serde_json::json!({ "param_name": "password" })));
    };
    if !orbitid_credentials::verify_password(&hash, password).await {
        // Its own committed transaction: the failure persists although the
        // attempt is refused.
        record_failed_attempt(state, &user.id).await?;
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PASSWORD_INCORRECT,
            "Password is incorrect",
        )
        .with_meta(serde_json::json!({
            "param_name": "password",
            "session_id": row.id,
        })));
    }
    // The factor verification, the attempt transition, any session creation and
    // the trusted-device redemption commit as one transaction.
    let factors =
        crate::signin::complete::second_factor_options_for(state, &user, &as_sign_in_state(row))
            .await?;
    let enrolled = !crate::signin::complete::all_second_factors(state, &user)
        .await?
        .is_empty();
    let mut tx = state.pool.begin().await?;
    // Rank 2 → 3 before any write: lock order is client, user, sign_ins,
    // sessions. `reset_failed_attempts_on` writes `users`, so it must not run
    // before the client lock.
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &row.client_id, &user.id).await?;
    reset_failed_attempts_on(&mut tx, &user.id).await?;
    let mut next = as_sign_in_state(row);
    next.first = Some(crate::state::FactorState::new("password").status("verified"));
    let saved = save_sign_in_state_on(&mut tx, row, &next).await?;
    let options = completion_options(headers, state);
    let result = crate::signin::core::after_first_factor_on(
        &mut tx,
        state,
        &saved,
        &user,
        &options,
        read_trusted_device_token(headers).as_deref(),
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
        notify_session(state, &user, session_id).await?;
    }
    Ok(())
}

/// Starts the enterprise SSO redirect for a sign-in row.
pub async fn start_enterprise(
    state: &AppState,
    row: &SignInRow,
    connection_id: &str,
    identifier: &str,
    current: &SignInState,
) -> Result<()> {
    let mut url = match url::Url::parse(&format!(
        "{}/v1/client/enterprise/start",
        state.env.base_url.trim_end_matches('/')
    )) {
        Ok(url) => url,
        Err(_) => return Err(OrbitError::internal("invalid base URL")),
    };
    let settings = state.settings.get();
    let redirect_url = current
        .redirect_url
        .clone()
        .unwrap_or_else(|| settings.application.home_url.clone());
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("connection_id", connection_id);
        query.append_pair("identifier", identifier);
        query.append_pair("sign_in_id", &row.id);
        query.append_pair("client_id", &row.client_id);
        query.append_pair("action", "sign_in");
        query.append_pair("redirect_url", &redirect_url);
        if let Some(action_complete) = &current.action_complete_redirect_url {
            query.append_pair("action_complete_redirect_url", action_complete);
        }
    }
    let mut next = current.clone();
    next.first = Some(crate::state::FactorState {
        strategy: "enterprise_sso".into(),
        status: Some("unverified".into()),
        external_verification_redirect_url: Some(url.to_string()),
        ..Default::default()
    });
    next.enterprise_connection_id = Some(connection_id.to_string());
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&next),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}
