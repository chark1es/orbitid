//! Backend API authentication and unexpected-error logging, ported from
//! the retired TypeScript server and `app.onError`.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::crypto::safe_equal;
use crate::error::{error_codes, OrbitError};
use crate::http::client_ip::{client_ip, peer_addr};
use crate::http::cookies::get_cookie;
use crate::http::rate_limit::{assert_not_blocked, hit};
use crate::http::security::log_safe;
use crate::keys::cookies::OPERATOR;
use crate::state::AppState;

const SECRET_KEY_MAX_FAILURES: i64 = 10;
const SECRET_KEY_WINDOW_MS: i64 = 5 * 60_000;

/// Hook for the dashboard operator-session cookie, implemented by the Backend
/// API layer (which owns the `operator_sessions` table). Core only calls it.
#[async_trait::async_trait]
pub trait OperatorSessionChecker: Send + Sync {
    fn cookie_origin_allowed(&self, state: &AppState, headers: &HeaderMap) -> bool;
    async fn find(&self, state: &AppState, headers: &HeaderMap) -> crate::error::Result<bool>;
}

pub fn query_has_credential(query: Option<&str>) -> bool {
    let Some(query) = query else {
        return false;
    };
    url::form_urlencoded::parse(query.as_bytes()).any(|(key, value)| {
        matches!(key.as_ref(), "secret_key" | "api_key" | "token") && !value.is_empty()
    })
}

/// Backend API auth: `Authorization: Bearer sk_...`, and (through the hook) the
/// dashboard's same-origin operator cookie. Query-string keys are refused.
///
/// The check is exposed separately so the router fallback can apply the same
/// rule to paths under `/v1` that match no route (the TS backend sub-app guards
/// its whole mount point, not just its registered routes).
pub async fn check_secret_key(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<std::net::SocketAddr>,
) -> Result<(), OrbitError> {
    let ip = client_ip(headers, peer, state.env.trust_proxy);
    let failure_key = format!("secret_key_failure:{ip}");

    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    if !token.is_empty() {
        assert_not_blocked(state, &failure_key, SECRET_KEY_MAX_FAILURES).await?;
        if safe_equal(token, &state.env.secret_key) {
            return Ok(());
        }
        hit(
            state,
            &failure_key,
            SECRET_KEY_MAX_FAILURES,
            SECRET_KEY_WINDOW_MS,
        )
        .await?;
        return Err(OrbitError::unauthorized(
            error_codes::SECRET_KEY_INVALID,
            "Invalid secret key",
        ));
    }

    if get_cookie(headers, OPERATOR).is_some() {
        let Some(checker) = state.operator_session_checker() else {
            return Err(OrbitError::unauthorized(
                error_codes::AUTHENTICATION_INVALID,
                "Your dashboard session ended. Sign in again.",
            ));
        };
        if !checker.cookie_origin_allowed(state, headers) {
            return Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "Cross-origin requests cannot use the dashboard session. Send a secret key instead.",
            ));
        }
        if checker.find(state, headers).await? {
            return Ok(());
        }
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Your dashboard session ended. Sign in again.",
        ));
    }

    hit(
        state,
        &failure_key,
        SECRET_KEY_MAX_FAILURES,
        SECRET_KEY_WINDOW_MS,
    )
    .await?;
    Err(OrbitError::unauthorized(
        error_codes::SECRET_KEY_INVALID,
        "Invalid secret key",
    ))
}

pub async fn require_secret_key(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OrbitError> {
    if query_has_credential(request.uri().query()) {
        return Err(OrbitError::unauthorized(
            error_codes::SECRET_KEY_INVALID,
            "Send the secret key in the Authorization header, never in the query string",
        ));
    }
    let peer = peer_addr(request.extensions());
    check_secret_key(&state, request.headers(), peer).await?;
    Ok(next.run(request).await)
}

/// Authentication paths stay silent so a 500 cannot leak provider responses,
/// codes or credentials into the log.
fn is_auth_path(path: &str) -> bool {
    let rest = match path.strip_prefix("/v1/") {
        Some(rest) => rest,
        None => {
            return path
                .strip_prefix("/oauth")
                .is_some_and(|after| after.is_empty() || after.starts_with('/'))
        }
    };
    [
        "client",
        "operator_sessions",
        "oauth_callback",
        "verify",
        "saml",
    ]
    .iter()
    .any(|prefix| rest == *prefix || rest.starts_with(&format!("{prefix}/")))
}

/// Logs unexpected 500s with the response's trace id. `OrbitError`'s
/// `IntoResponse` deliberately does not log because it cannot see the path.
pub async fn error_logging(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    if response.status() == StatusCode::INTERNAL_SERVER_ERROR && !is_auth_path(&path) {
        let trace = response
            .extensions()
            .get::<crate::error::TraceId>()
            .map(|trace| trace.0.clone())
            .unwrap_or_else(|| "unknown".to_string());
        tracing::error!("[{trace}] Unexpected server error");
    }
    response
}

/// Logs one structured line per request: method, path (never the query), status,
/// duration and the response trace id. Headers, cookies and bodies are never
/// logged, so credentials cannot leak into the log.
pub async fn request_logging(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    let trace = response
        .extensions()
        .get::<crate::error::TraceId>()
        .map(|trace| trace.0.clone())
        .unwrap_or_else(|| nanoid::nanoid!(16));
    tracing::info!(
        target: "orbitid::http",
        method = %method,
        path = %log_safe(&path),
        status = response.status().as_u16(),
        duration_ms = started.elapsed().as_millis() as u64,
        trace_id = %trace,
        "request"
    );
    response
}

/// Convenience for handlers that want to log silently-consumed errors.
pub fn internal_response(error: OrbitError) -> Response {
    error.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_credentials_are_detected() {
        assert!(query_has_credential(Some("secret_key=sk_test_x")));
        assert!(query_has_credential(Some("api_key=sk_test_x")));
        assert!(query_has_credential(Some("token=abc")));
        assert!(!query_has_credential(Some("secret_key=")));
        assert!(!query_has_credential(Some("limit=10")));
        assert!(!query_has_credential(None));
    }

    #[test]
    fn auth_paths_are_silent() {
        for path in [
            "/v1/client",
            "/v1/client/me",
            "/v1/operator_sessions",
            "/v1/oauth_callback/google",
            "/v1/verify",
            "/v1/saml/acs",
            "/oauth/token",
        ] {
            assert!(is_auth_path(path), "{path}");
        }
        for path in [
            "/v1/users",
            "/v1/webhooks/endpoints",
            "/health",
            "/oauthish",
        ] {
            assert!(!is_auth_path(path), "{path}");
        }
    }
}
