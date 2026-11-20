//! Dashboard console sessions. Mounted without the Backend API guard.
//!
//! The dashboard is opened by an account, never by the secret key:
//!
//! - `GET /v1/operator_sessions/status` is the dashboard's single boot request:
//!   the console session (if any), the account signed in on this browser (if
//!   any), whether it may open the console, and whether the instance still
//!   needs its owner.
//! - `POST /v1/operator_sessions/setup` creates the owner account on a fresh
//!   instance, signs it in on this browser and opens the console.
//! - `POST /v1/operator_sessions/from_user` opens the console for the account
//!   signed in on this browser, when one of its instance roles grants
//!   `app:sys_dashboard:access`.
//! - `GET /v1/operator_sessions/current` reports the console session and
//!   `DELETE` ends it (and the account's session on this browser).
//!
//! Every route checks the origin first and then a per-address budget (see
//! [`crate::console::limit`]), so another site cannot spend a visitor's budget.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::get_cookie;
use orbitid_core::keys::cookies::{CLIENT, OPERATOR};
use orbitid_core::AppState;
use orbitid_identity::operator_session::{
    clear_operator_cookie, find_operator_session, operator_cookie_origin_allowed,
    operator_session_for_token, revoke_operator_session,
};
use orbitid_platform::audit::{audit, AuditInput};

use crate::console::{limit, SIGN_OUT_BUDGET, STATUS_BUDGET};
use crate::shared::PeerAddr;

/// The dashboard session routes (public: no Backend API guard).
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/operator_sessions/current",
            get(current).delete(sign_out),
        )
        .route("/v1/operator_sessions/status", get(crate::console::status))
        .route("/v1/operator_sessions/setup", post(crate::console::setup))
        .route(
            "/v1/operator_sessions/from_user",
            post(crate::console::from_user),
        )
}

/// A browser request that will receive a cookie must come from this instance.
/// `Origin: null` (sandboxed frames, some redirects) is never this instance.
pub(crate) fn assert_exchange_origin(state: &AppState, headers: &HeaderMap) -> Result<()> {
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

async fn current(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
) -> Result<Response> {
    if !operator_cookie_origin_allowed(&state, &headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-origin requests cannot use the dashboard session.",
        ));
    }
    let row = find_operator_session(&state, &headers).await?;
    // A live console session is not charged: traffic from a shared address
    // must not sign working operators out.
    if row.is_none() {
        limit(&state, &headers, peer, STATUS_BUDGET).await?;
    }
    match row {
        Some(row) => Ok(Json(crate::console::operator_session_json(&row)).into_response()),
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

/// `DELETE /v1/operator_sessions/current[?account=true]`. Ends the console
/// session and the account session behind it. A sign-out that finds something
/// to end is never rate limited; one that finds nothing is charged. `account=true` also signs this
/// browser's account out when no console session is open (the sign-in
/// screen's "Sign out" for an account without console access).
async fn sign_out(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
    query: crate::shared::QueryPairs,
) -> Result<Response> {
    if !operator_cookie_origin_allowed(&state, &headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-site request blocked.",
        ));
    }
    // Nothing to sign out of: answer without spending anyone's budget.
    if !has_cookie(&headers, OPERATOR) && !has_cookie(&headers, CLIENT) {
        let mut response = StatusCode::NO_CONTENT.into_response();
        clear_operator_cookie(response.headers_mut());
        return Ok(response);
    }
    // The row behind the cookie even when it no longer authenticates (expired,
    // access lost): the account session it was opened from still ends. A row
    // already revoked by an earlier sign-out has nothing left to end.
    let row = operator_session_for_token(&state, &headers)
        .await?
        .filter(|row| row.revoked_at.is_none());
    // Signing out of the console signs the account out of this browser too:
    // the dashboard shows the account state, so "Sign out" must end both.
    let mut account_session = row.as_ref().map(|row| row.session_id.clone());
    let account = query
        .0
        .iter()
        .any(|(key, value)| key == "account" && value == "true");
    if account_session.is_none() && account {
        account_session = orbitid_identity::caller::try_resolve_browser_caller(&state, &headers)
            .await?
            .map(|caller| caller.session_id);
    }
    let session = match account_session.as_deref() {
        Some(id) => orbitid_identity::sessions::get_session(&state, id)
            .await?
            .filter(|session| session.status == "active" || session.status == "pending"),
        None => None,
    };
    if row.is_none() && session.is_none() {
        // Only a sign-out that ends something is free. Junk cookies, or a
        // cookie replayed after it was already signed out, are charged, so they
        // cannot use up the budget a real sign-out needs.
        limit(&state, &headers, peer, SIGN_OUT_BUDGET).await?;
        let mut response = StatusCode::NO_CONTENT.into_response();
        clear_operator_cookie(response.headers_mut());
        return Ok(response);
    }
    let ip = crate::shared::request_ip(&state, &headers, peer);
    // The account session ends first, so a failure leaves both in place and a
    // retry can finish the job.
    if let Some(session) = session.as_ref() {
        orbitid_identity::sessions::end_session(&state, session, "ended").await?;
    }
    let revoked = revoke_operator_session(&state, &headers).await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_operator_cookie(response.headers_mut());
    if let (Some(row), true) = (row, revoked) {
        audit(
            &state,
            AuditInput::new("operator_session.revoked")
                .actor(row.user_id)
                .target_type("operator_session")
                .target_id(row.id)
                .ip(ip),
        )
        .await;
    }
    Ok(response)
}

fn has_cookie(headers: &HeaderMap, name: &str) -> bool {
    get_cookie(headers, name).is_some_and(|value| !value.is_empty())
}

pub(crate) fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}
