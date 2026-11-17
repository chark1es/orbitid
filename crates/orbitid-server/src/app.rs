//! Router composition, mirroring `createApp` in the retired TypeScript server.
//!
//! Middleware ordering (outermost first, like Hono's `app.use` order):
//! request logging → error logging → security headers → OIDC CORS → upload cap
//! → CSRF → Frontend API CORS → routes. The Backend API routers are wrapped in
//! `require_secret_key` *before* they are merged, so every route they will ever
//! contain is guarded structurally rather than by a hand-maintained path list.
//!
//! Unknown `/v1/…` paths go through the same secret-key check in the fallback:
//! the TS backend sub-app guards its whole `/v1` mount point, so an
//! unauthenticated request to a path that does not exist is still a 401.

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{middleware, Json, Router};
use orbitid_core::error::{route_not_found, OrbitError};
use orbitid_core::http::{
    check_secret_key, cors, csrf_protection, error_logging, peer_addr, request_logging,
    require_secret_key, security_headers, upload_size_limit,
};
use orbitid_core::AppState;
use serde_json::json;

use crate::dashboard::dashboard_available;
use crate::docs::{docs_asset, docs_index, openapi_json};

/// Builds the complete app. Exposed as a library function so tests can drive it
/// in-process with `tower::ServiceExt::oneshot`.
pub fn build_app(state: AppState) -> Router {
    build_app_impl(state, true)
}

/// The same app without the request-level transaction retry. Test hook: it
/// proves that Layer 1 (the global lock order) removes the deadlocks on its
/// own, with no help from Layer 2.
pub fn build_app_without_retry(state: AppState) -> Router {
    build_app_impl(state, false)
}

fn build_app_impl(state: AppState, retry: bool) -> Router {
    // The Backend API group: bapi (users, orgs, webhooks, …) plus the OIDC
    // backend routes (API keys, M2M). The auth layer is applied to the merged
    // router, so a new backend route cannot be added unguarded.
    let backend = Router::new()
        .merge(orbitid_bapi::backend_router())
        .merge(orbitid_oidc::backend_router())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_secret_key,
        ));

    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .merge(orbitid_credentials::routes::jwks_router())
        .merge(orbitid_oidc::router())
        .merge(orbitid_fapi_auth::router())
        .merge(orbitid_fapi_account::router())
        .merge(orbitid_bapi::router())
        .merge(backend)
        .route("/v1/openapi.json", get(openapi_json))
        .route("/docs", get(docs_index))
        .route("/docs/assets/{*path}", get(docs_asset))
        .fallback(fallback)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state.clone());
    // Innermost: a replay re-executes only the route handler, never the
    // authentication/CSRF/body-cap layers above it.
    let app = if retry {
        app.layer(crate::retry::RetryLayer)
    } else {
        app
    };

    let timeout_state = state.clone();
    app.layer(middleware::from_fn_with_state(
        timeout_state,
        request_timeout,
    ))
    .layer(middleware::from_fn_with_state(
        state.clone(),
        crate::guard::pre_body_auth,
    ))
    .layer(middleware::from_fn_with_state(state.clone(), cors))
    .layer(middleware::from_fn_with_state(
        state.clone(),
        csrf_protection,
    ))
    .layer(middleware::from_fn_with_state(
        state.clone(),
        upload_size_limit,
    ))
    .layer(middleware::from_fn(orbitid_oidc::oidc_cors))
    .layer(middleware::from_fn_with_state(
        state.clone(),
        security_headers,
    ))
    .layer(middleware::from_fn(error_logging))
    .layer(middleware::from_fn(request_logging))
}

/// Caps how long a handler may run before the server answers 408. The TS
/// server relies on Node's `requestTimeout`; axum needs an explicit layer.
async fn request_timeout(
    State(state): State<AppState>,
    request: Request,
    next: middleware::Next,
) -> Response {
    let timeout_ms = state.env.request_timeout_ms;
    if timeout_ms == 0 {
        return next.run(request).await;
    }
    match tokio::time::timeout(Duration::from_millis(timeout_ms), next.run(request)).await {
        Ok(response) => response,
        Err(_) => OrbitError::new(
            StatusCode::REQUEST_TIMEOUT,
            "request_timeout",
            "The request took too long to complete",
        )
        .into_response(),
    }
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // Cheap and dependency-free on purpose: a load balancer probes it often.
    Json(json!({
        "status": "ok",
        "publishable_key": state.publishable_key,
        "database": "postgres",
        "database_driver": "postgres",
    }))
}

/// Readiness: proves this replica can reach the shared database. Returns 503
/// until the pool can answer a trivial query, so a rolling deploy does not send
/// traffic to a replica that cannot serve it.
async fn ready(State(state): State<AppState>) -> Response {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "status": "ready", "database": "postgres" })),
        )
            .into_response(),
        Err(error) => {
            tracing::warn!(error = %error, "readiness probe failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "unavailable", "database": "postgres" })),
            )
                .into_response()
        }
    }
}

/// Unknown routes: JSON 404 for the API, the dashboard SPA for everything else
/// (when a build exists), exactly like `dashboardHandler` + `app.notFound`.
async fn fallback(State(state): State<AppState>, request: Request) -> Response {
    let raw_path = request.uri().path().to_string();
    // Path-bearing issuers can put the well-known segment at any depth; the
    // static router covers one prefix segment, so the rest lands here.
    if request.method() == Method::GET && orbitid_oidc::is_discovery_path(&raw_path) {
        return orbitid_oidc::routes::well_known::discovery_response(&state, request.headers())
            .await;
    }
    let is_v1 = raw_path == "/v1" || raw_path.starts_with("/v1/");
    if request.method() != Method::GET {
        return if is_v1 {
            let headers = request.headers().clone();
            let query = request.uri().query().map(str::to_string);
            let peer = peer_addr(request.extensions());
            guarded_not_found(&state, &headers, query.as_deref(), peer).await
        } else {
            route_not_found().into_response()
        };
    }
    // The TS backend sub-app guards its whole `/v1` mount point, including
    // paths that match no route.
    if is_v1 {
        let headers = request.headers().clone();
        let query = request.uri().query().map(str::to_string);
        let peer = peer_addr(request.extensions());
        return guarded_not_found(&state, &headers, query.as_deref(), peer).await;
    }
    // The TS dashboard is only mounted when a build exists; without one every
    // unmatched GET is the JSON 404.
    if !dashboard_available(&state) {
        return route_not_found().into_response();
    }
    // The TS handler decodes the pathname and answers 400 for a malformed escape
    // instead of serving the SPA.
    let path = match percent_encoding::percent_decode_str(&raw_path).decode_utf8() {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => return (StatusCode::BAD_REQUEST, "Bad request").into_response(),
    };
    // Other API prefixes (`/oauth`, `/.well-known`, `/docs`, `/health`) are
    // never the SPA, but they are not part of the secret-key guard either.
    if crate::dashboard::is_api_path(&path) {
        return route_not_found().into_response();
    }
    crate::dashboard::serve(&state, &path).await
}

/// Hono has no 405 response: a path whose method does not match falls through
/// to the backend sub-app (`/v1`) or to `notFound`. Mirror that instead of
/// axum's default 405, so an unauthenticated wrong-method request under `/v1`
/// is the same 401 as the TS server.
async fn method_not_allowed(State(state): State<AppState>, request: Request) -> Response {
    let path = request.uri().path().to_string();
    if path == "/v1" || path.starts_with("/v1/") {
        let headers = request.headers().clone();
        let query = request.uri().query().map(str::to_string);
        let peer = peer_addr(request.extensions());
        return guarded_not_found(&state, &headers, query.as_deref(), peer).await;
    }
    route_not_found().into_response()
}

/// Unmatched `/v1` paths are still part of the Backend API's guarded mount
/// point: the secret key (or operator cookie) is checked before the 404.
async fn guarded_not_found(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    query: Option<&str>,
    peer: Option<SocketAddr>,
) -> Response {
    let query_has_key = orbitid_core::http::query_has_credential(query);
    if query_has_key {
        return OrbitError::unauthorized(
            orbitid_core::error::error_codes::SECRET_KEY_INVALID,
            "Send the secret key in the Authorization header, never in the query string",
        )
        .into_response();
    }
    match check_secret_key(state, headers, peer).await {
        Ok(()) => route_not_found().into_response(),
        Err(error) => error.into_response(),
    }
}

/// A ready-to-serve `TcpListener` address helper (used by tests and `start`).
pub fn bind_address(state: &AppState) -> SocketAddr {
    SocketAddr::from(([0, 0, 0, 0], state.env.port))
}
