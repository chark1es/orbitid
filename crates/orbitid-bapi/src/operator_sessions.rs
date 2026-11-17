//! Dashboard operator sessions, ported from `modules/operator-sessions.ts`.
//!
//! `POST /v1/operator_sessions` trades the secret key for an httpOnly cookie and
//! never echoes the key back. `GET` reports the session's expiry and `DELETE`
//! revokes it. This router is mounted without the Backend API guard.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use orbitid_core::crypto::safe_equal;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::rate_limit::{assert_not_blocked, hit};
use orbitid_core::http::OrbitJson;
use orbitid_core::keys::cookies::OPERATOR;
use orbitid_core::AppState;
use orbitid_identity::operator_session::{
    clear_operator_cookie, find_operator_session, issue_operator_session,
    operator_cookie_origin_allowed, operator_key_refused, revoke_operator_session,
    set_operator_cookie, OPERATOR_KEY_MAX_FAILURES, OPERATOR_KEY_WINDOW_MS,
};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{json_status, request_ip, PeerAddr};

/// The three dashboard session routes (public: no Backend API guard).
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/operator_sessions", post(exchange))
        .route(
            "/v1/operator_sessions/current",
            get(current).delete(sign_out),
        )
}

#[derive(Debug, Deserialize)]
struct ExchangeBody {
    secret_key: String,
}

/// A browser request that will receive a cookie must come from this instance.
/// `Origin: null` (sandboxed frames, some redirects) is never this instance.
fn assert_exchange_origin(state: &AppState, headers: &HeaderMap) -> Result<()> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if origin.trim().eq_ignore_ascii_case("null") {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-site request blocked.",
        ));
    }
    if !operator_cookie_origin_allowed(state, headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Sign in from the dashboard served by this instance.",
        ));
    }
    Ok(())
}

async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
    OrbitJson(body): OrbitJson<ExchangeBody>,
) -> Result<Response> {
    assert_exchange_origin(&state, &headers)?;
    let ip = request_ip(&state, &headers, peer);
    let failure_key = format!("secret_key_failure:{ip}");
    assert_not_blocked(&state, &failure_key, OPERATOR_KEY_MAX_FAILURES).await?;
    if !safe_equal(body.secret_key.trim(), &state.env.secret_key) {
        hit(
            &state,
            &failure_key,
            OPERATOR_KEY_MAX_FAILURES,
            OPERATOR_KEY_WINDOW_MS,
        )
        .await?;
        return Err(operator_key_refused());
    }

    // One session per browser: signing in again replaces the cookie, and
    // abandoning the old one is harmless.
    let _ = revoke_operator_session(&state, &headers).await;
    let (row, token) = issue_operator_session(
        &state,
        header_str(&headers, "user-agent").as_deref(),
        Some(&ip),
    )
    .await?;
    audit(
        &state,
        AuditInput::new("operator_session.created")
            .actor("secret_key")
            .target_type("operator_session")
            .target_id(row.id.clone())
            .ip(ip),
    )
    .await;
    let mut response = json_status(
        StatusCode::CREATED,
        json!({
            "object": "operator_session",
            "id": row.id,
            "expires_at": row.expires_at,
        }),
    );
    set_operator_cookie(response.headers_mut(), &state, &token);
    Ok(response)
}

async fn current(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    if !operator_cookie_origin_allowed(&state, &headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-origin requests cannot use the dashboard session.",
        ));
    }
    let row = find_operator_session(&state, &headers).await?;
    match row {
        Some(row) => Ok(Json(json!({
            "object": "operator_session",
            "id": row.id,
            "expires_at": row.expires_at,
        }))
        .into_response()),
        None => {
            let error = OrbitError::unauthorized(
                error_codes::AUTHENTICATION_INVALID,
                "Your dashboard session ended. Sign in again.",
            );
            let mut response = error.into_response();
            // Drop a cookie that no longer authenticates anything.
            let had_cookie = headers
                .get("cookie")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.contains(OPERATOR))
                .unwrap_or(false);
            if had_cookie {
                clear_operator_cookie(response.headers_mut());
            }
            Ok(response)
        }
    }
}

async fn sign_out(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    if !operator_cookie_origin_allowed(&state, &headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-site request blocked.",
        ));
    }
    let row = find_operator_session(&state, &headers).await?;
    revoke_operator_session(&state, &headers).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_operator_cookie(response.headers_mut());
    if let Some(row) = row {
        audit(
            &state,
            AuditInput::new("operator_session.revoked")
                .actor("secret_key")
                .target_type("operator_session")
                .target_id(row.id)
                .ip(request_ip(&state, &headers, PeerAddr(None))),
        )
        .await;
    }
    Ok(response)
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}
