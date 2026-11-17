//! Request-level retry of transactions aborted by a Postgres deadlock
//! (`40P01`) or serialization failure (`40001`).
//!
//! Layer 1 (`orbitid_identity::locks`) removes the known ordering violations.
//! This is the defence in depth: if a future edit misses one, the client gets a
//! successful response instead of a 409.
//!
//! # Safety
//!
//! The layer sits **inside** authentication, CORS, CSRF and the body cap, so a
//! replay re-executes only the route handler. A request is replayed only when:
//!
//! * the method has a body or a side effect we understand (`POST`, `PATCH`,
//!   `PUT`, `DELETE`),
//! * the response is exactly the 409 `transaction_conflict` produced by a
//!   deadlock/serialization failure (detected by the `RetryableTransactionConflict`
//!   extension, not by parsing JSON),
//! * the body is at most [`REPLAY_BODY_LIMIT`] (uploads stream through
//!   unretried), and the path is not one of the classes that performs an
//!   external effect before its transaction ([`is_external_effect_path`]).
//!
//! Everything with an external effect in this server is either post-commit
//! (mail/SMS, webhook events, verified-email enrolment) or on an excluded path
//! (OAuth code exchange, SAML ACS, enterprise OIDC callback). The request-private
//! memo in [`orbitid_core::http::replay`] carries across attempts: a CAPTCHA
//! token that already succeeded is not submitted again (single-use providers
//! would reject the replay), the rate-limit budget is not debited twice, and the
//! failed-attempt counter is skipped only when an earlier attempt committed it.
//!
//! After the last attempt the 409 is returned unchanged, so clients still see
//! the retryable `transaction_conflict`.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, Response, StatusCode};
use axum::response::IntoResponse;
use orbitid_core::error::{error_codes, OrbitError, RetryableTransactionConflict};
use orbitid_core::http::is_upload_path;
use tower::{Layer, Service};

/// Bodies larger than this are streamed through without retry (uploads are
/// 5 MiB and are excluded by path; ordinary JSON is capped at 1 MiB).
pub const REPLAY_BODY_LIMIT: usize = 1024 * 1024;

/// Total attempts, matching `orbitid_core::db::with_retry`.
pub const MAX_ATTEMPTS: u32 = 3;

/// Routes that perform work outside the database before their transaction:
/// exchanging an OAuth authorization code, verifying a SAML assertion, or
/// calling an enterprise IdP. Replaying them would reuse a one-time code.
pub fn is_external_effect_path(path: &str) -> bool {
    const PREFIXES: [&str; 4] = [
        "/v1/oauth_callback",
        "/v1/client/enterprise",
        "/v1/saml",
        "/v1/client/oauth",
    ];
    PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

/// Whether a request may be buffered and replayed.
fn replayable(method: &Method, path: &str) -> bool {
    if !matches!(
        *method,
        Method::POST | Method::PATCH | Method::PUT | Method::DELETE
    ) {
        return false;
    }
    if is_upload_path(path) || is_external_effect_path(path) {
        return false;
    }
    true
}

fn is_retryable_conflict(response: &Response<Body>) -> bool {
    response.status() == StatusCode::CONFLICT
        && response
            .extensions()
            .get::<RetryableTransactionConflict>()
            .is_some()
}

fn backoff(attempt: u32) -> Duration {
    let jitter = rand_jitter();
    Duration::from_millis(u64::from(attempt) * 2 + jitter)
}

fn rand_jitter() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    // No rand dependency in the server crate; a per-call SipHash of a counter is
    // enough jitter to de-synchronize two replicas/requesters.
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.subsec_nanos() as u64)
            .unwrap_or(0),
    );
    hasher.finish() % 5
}

/// The tower layer. Add it to the router **before** the other `.layer(..)`
/// calls so it is inside authentication and the body cap.
#[derive(Debug, Clone, Default)]
pub struct RetryLayer;

impl<S> Layer<S> for RetryLayer {
    type Service = RetryService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        RetryService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct RetryService<S> {
    inner: S,
}

impl<S> Service<Request<Body>> for RetryService<S>
where
    S: Service<Request<Body>, Response = Response<Body>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    S::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let mut inner = self.inner.clone();
        Box::pin(async move {
            if !replayable(request.method(), request.uri().path()) {
                return inner.call(request).await;
            }
            let (parts, body) = request.into_parts();
            let Ok(bytes) = axum::body::to_bytes(body, REPLAY_BODY_LIMIT).await else {
                return Ok(OrbitError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    error_codes::REQUEST_BODY_INVALID,
                    "Request body is too large",
                )
                .into_response());
            };
            // One request-private memo spans every attempt: a CAPTCHA token that
            // was accepted by the first attempt is not submitted again, and a
            // failed-attempt counter committed by the first attempt is not
            // counted twice.
            orbitid_core::http::replay::request_scope(async move {
                let mut attempt = 0u32;
                loop {
                    attempt += 1;
                    let rebuilt = rebuild(&parts, bytes.clone());
                    let response = if attempt == 1 {
                        inner.call(rebuilt).await?
                    } else {
                        orbitid_core::http::replay::scope(true, inner.call(rebuilt)).await?
                    };
                    if attempt >= MAX_ATTEMPTS || !is_retryable_conflict(&response) {
                        return Ok(response);
                    }
                    tracing::warn!(
                        path = %parts.uri.path(),
                        attempt,
                        "database transaction conflict; replaying the request"
                    );
                    tokio::time::sleep(backoff(attempt)).await;
                }
            })
            .await
        })
    }
}

fn rebuild(parts: &axum::http::request::Parts, body: bytes::Bytes) -> Request<Body> {
    let mut out = Request::new(Body::from(body));
    *out.method_mut() = parts.method.clone();
    *out.uri_mut() = parts.uri.clone();
    *out.version_mut() = parts.version;
    *out.headers_mut() = parts.headers.clone();
    *out.extensions_mut() = parts.extensions.clone();
    out
}
