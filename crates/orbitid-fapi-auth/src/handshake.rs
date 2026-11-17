//! `GET /v1/client/handshake`: turns a live `__client` cookie into a fresh
//! session token for a hard navigation whose `__session` cookie has expired.
//! Ported from `modules/handshake.ts`.

use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::keys::cookies::HANDSHAKE;
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::{
    active_client_session, find_client, renew_client_cookie_if_due,
};
use orbitid_identity::sessions::{evaluate_session_status, get_session, slide_session_activity};
use orbitid_identity::tokens::{sign_session_token, SignSessionTokenOptions};
use orbitid_identity::users::get_user_by_id;

use crate::util::{client_ip, hit, query_map, with_query, Reply};

/// Marker returned when the request has no usable client session.
pub const HANDSHAKE_SIGNED_OUT: &str = "signed_out";
/// Marker for an infrastructure failure (keep the visitor's cookies).
pub const HANDSHAKE_TRANSIENT: &str = "transient";

fn bad(code: &str, message: &str, param: &str) -> OrbitError {
    OrbitError::bad_request(code, message).with_meta(serde_json::json!({ "param_name": param }))
}

fn home_url(state: &AppState) -> String {
    let settings = state.settings.get();
    if settings.application.home_url.is_empty() {
        state.env.base_url.clone()
    } else {
        settings.application.home_url.clone()
    }
}

/// Shared redirect validator plus the API's own origin.
fn require_redirect_url(state: &AppState, value: Option<&str>) -> Result<String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(bad(
            error_codes::FORM_PARAM_MISSING,
            "redirect_url is required",
            "redirect_url",
        ));
    };
    let base = home_url(state);
    let url = url::Url::parse(value)
        .or_else(|_| url::Url::parse(&base)?.join(value))
        .map_err(|_| {
            bad(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "redirect_url is not a valid URL",
                "redirect_url",
            )
        })?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(bad(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "redirect_url must use http(s)",
            "redirect_url",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "redirect_url must not contain credentials",
            "redirect_url",
        ));
    }
    let origin = url.origin().ascii_serialization();
    if !orbitid_core::http::security::request_origin_allowed(state, &origin) {
        return Err(bad(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "redirect_url origin is not allowed",
            "redirect_url",
        ));
    }
    Ok(url.to_string())
}

pub async fn handshake(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Reply> {
    hit(
        &state,
        &format!("handshake:{}", client_ip(&state, &headers)),
        600,
        60_000,
    )
    .await?;
    let query = query_map(query.as_deref());
    let redirect_url = require_redirect_url(&state, query.get("redirect_url").map(String::as_str))?;
    let mut cookies: Vec<String> = Vec::new();
    let client = find_client(&state, &headers).await?;
    if let Some(client) = &client {
        if let Some(cookie) = renew_client_cookie_if_due(&state, &headers, client).await? {
            cookies.push(cookie);
        }
    }
    let session = match &client {
        Some(client) => active_client_session(&state, client).await?,
        None => None,
    };
    let mut token: Option<String> = None;
    if let Some(session) = &session {
        if session.status == "active" || session.status == "pending" {
            let origin = url::Url::parse(&redirect_url)
                .ok()
                .map(|url| url.origin().ascii_serialization());
            match sign_session_token(
                &state,
                &session.id,
                SignSessionTokenOptions {
                    template: None,
                    azp: origin,
                },
            )
            .await
            {
                Ok(jwt) => token = Some(jwt),
                Err(_) => {
                    let ended = session_is_definitely_ended(&state, &session.id, &session.user_id)
                        .await
                        .unwrap_or(false);
                    if !ended {
                        return Ok(Reply::redirect(with_query(
                            &redirect_url,
                            &[(HANDSHAKE, Some(HANDSHAKE_TRANSIENT))],
                        ))
                        .header("Cache-Control", "no-store")
                        .header("Pragma", "no-cache")
                        .header("Referrer-Policy", "no-referrer")
                        .header("Retry-After", "5")
                        .cookies(cookies));
                    }
                    token = None;
                }
            }
            if token.is_some() {
                let _ = slide_session_activity(&state, session, None).await;
            }
        }
    }
    let marker = token.unwrap_or_else(|| HANDSHAKE_SIGNED_OUT.to_string());
    Ok(Reply::redirect(with_query(
        &redirect_url,
        &[(HANDSHAKE, Some(marker.as_str()))],
    ))
    .header("Cache-Control", "no-store")
    .header("Pragma", "no-cache")
    .header("Referrer-Policy", "no-referrer")
    .cookies(cookies))
}

/// Reads the row again and answers whether the session (or its user) really is gone.
async fn session_is_definitely_ended(
    state: &AppState,
    session_id: &str,
    user_id: &str,
) -> Result<bool> {
    let row = get_session(state, session_id).await?;
    let Some(row) = row else { return Ok(true) };
    if row.user_id != user_id {
        return Ok(true);
    }
    let status = evaluate_session_status(state, &row).await?;
    if status != "active" && status != "pending" {
        return Ok(true);
    }
    match get_user_by_id(state, user_id).await? {
        Some(user) => Ok(user.banned),
        None => Ok(true),
    }
}
