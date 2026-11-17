//! RP-initiated logout (`GET|POST /oauth/end_session`), ported from
//! `modules/oidc/logout.ts`.

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;

use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::logout::{end_session_at_provider, LogoutInput};
use crate::services::oidc::shared::HandlerResult;
use crate::web::query_map;

pub fn router() -> Router<AppState> {
    Router::new().route("/oauth/end_session", get(logout_get).post(logout_post))
}

#[derive(Debug, Default, Deserialize)]
#[allow(dead_code)] // schema parity: accepted and ignored, like the TypeScript schema.
struct LogoutParams {
    #[serde(default)]
    id_token_hint: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    post_logout_redirect_uri: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    logout_hint: Option<String>,
    #[serde(default)]
    ui_locales: Option<String>,
}

async fn finish(
    state: &AppState,
    headers: &HeaderMap,
    params: LogoutParams,
) -> HandlerResult<Response> {
    let result = end_session_at_provider(
        state,
        LogoutInput {
            id_token_hint: params.id_token_hint,
            client_id: params.client_id,
            post_logout_redirect_uri: params.post_logout_redirect_uri,
            state: params.state,
            issuer: Some(issuer_for(state, headers)),
        },
    )
    .await?;
    let mut response = crate::web::redirect(&result.redirect_to);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response.into_response())
}

async fn logout_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> HandlerResult<Response> {
    let query = query_map(uri.query());
    let get = |key: &str| query.get(key).cloned().filter(|value| !value.is_empty());
    finish(
        &state,
        &headers,
        LogoutParams {
            id_token_hint: get("id_token_hint"),
            client_id: get("client_id"),
            post_logout_redirect_uri: get("post_logout_redirect_uri"),
            state: get("state"),
            logout_hint: get("logout_hint"),
            ui_locales: get("ui_locales"),
        },
    )
    .await
}

async fn logout_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(params): OrbitJson<LogoutParams>,
) -> HandlerResult<Response> {
    finish(&state, &headers, params).await
}
