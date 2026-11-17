//! Token, userinfo, revocation and introspection routes, ported from
//! `modules/oidc/token.ts`.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::Value;

use orbitid_core::error::OrbitError;
use orbitid_core::http::json::parse_request_body;
use orbitid_core::http::{OrbitJson, MAX_JSON_BYTES};
use orbitid_core::state::AppState;

use crate::services::oidc::applications::authenticate_client;
use crate::services::oidc::claims::user_info_claims;
use crate::services::oidc::device::poll_device_code;
use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::refresh::{exchange_refresh_token, RefreshExchangeOptions};
use crate::services::oidc::shared::{
    parse_scopes, HandlerResult, OAuthError, DEVICE_CODE_GRANT_TYPE,
};
use crate::services::oidc::tokens::{
    access_grant_from_token, exchange_authorization_code, introspect_token, revoke_token,
    CodeExchangeInput,
};
use crate::web::query_map;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/token", post(token))
        .route("/oauth/userinfo", get(userinfo).post(userinfo))
        .route("/oauth/revoke", post(revoke))
        .route("/oauth/introspect", post(introspect))
}

#[derive(Debug, Deserialize)]
struct TokenRequest {
    grant_type: String,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    code_verifier: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    device_code: Option<String>,
}

fn device_enabled(state: &AppState) -> bool {
    state
        .settings
        .get()
        .oidc_provider
        .device_authorization_enabled
}

async fn token(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<TokenRequest>,
) -> HandlerResult<Response> {
    let issuer = issuer_for(&state, &headers);
    let app_row = authenticate_client(
        &state,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        body.client_id.as_deref(),
        body.client_secret.as_deref(),
    )
    .await?;
    match body.grant_type.as_str() {
        "authorization_code" => {
            let Some(code) = body.code.as_deref().filter(|value| !value.is_empty()) else {
                return Err(OAuthError::invalid_request("code is required").into());
            };
            let tokens = exchange_authorization_code(
                &state,
                CodeExchangeInput {
                    application: &app_row,
                    code,
                    redirect_uri: body.redirect_uri.as_deref(),
                    code_verifier: body.code_verifier.as_deref(),
                    issuer: Some(&issuer),
                },
            )
            .await?;
            Ok(axum::Json(tokens).into_response())
        }
        "refresh_token" => {
            let Some(refresh_token) = body
                .refresh_token
                .as_deref()
                .filter(|value| !value.is_empty())
            else {
                return Err(OAuthError::invalid_request("refresh_token is required").into());
            };
            let tokens = exchange_refresh_token(
                &state,
                &app_row,
                refresh_token,
                RefreshExchangeOptions {
                    issuer: Some(&issuer),
                    scopes: body.scope.as_deref().map(parse_scopes),
                    hooks: None,
                },
            )
            .await?;
            Ok(axum::Json(tokens).into_response())
        }
        DEVICE_CODE_GRANT_TYPE => {
            if !device_enabled(&state) {
                return Err(OAuthError::bad_request(
                    "unsupported_grant_type",
                    format!("Unsupported grant_type: {}", body.grant_type),
                )
                .into());
            }
            let Some(device_code) = body
                .device_code
                .as_deref()
                .filter(|value| !value.is_empty())
            else {
                return Err(OAuthError::invalid_request("device_code is required").into());
            };
            let result = poll_device_code(&state, &app_row, device_code, Some(&issuer)).await?;
            match result {
                crate::services::oidc::device::DeviceTokenResult::Ok { tokens } => {
                    Ok(axum::Json(tokens).into_response())
                }
                crate::services::oidc::device::DeviceTokenResult::Pending {
                    error,
                    description,
                    interval_seconds,
                } => {
                    let mut response = OAuthError::new(StatusCode::BAD_REQUEST, error, description)
                        .into_response();
                    if let Some(interval) = interval_seconds {
                        if let Ok(value) = HeaderValue::from_str(&interval.to_string()) {
                            response.headers_mut().insert(header::RETRY_AFTER, value);
                        }
                    }
                    Ok(response)
                }
            }
        }
        other => Err(OAuthError::bad_request(
            "unsupported_grant_type",
            format!("Unsupported grant_type: {other}"),
        )
        .into()),
    }
}

/// Bearer token from the header, the query string (GET) or an `access_token`
/// form/JSON field (POST).
async fn presented_access_token(request: Request) -> String {
    let method = request.method().clone();
    let headers = request.headers().clone();
    let uri = request.uri().clone();
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let bearer = match authorization
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("bearer "))
    {
        Some(_) => authorization[7..].trim(),
        None => "",
    };
    if !bearer.is_empty() {
        return bearer.to_string();
    }
    if method == axum::http::Method::GET {
        return query_map(uri.query())
            .get("access_token")
            .cloned()
            .unwrap_or_default();
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.contains("application/json") && !content_type.contains("form") {
        return String::new();
    }
    let (parts, body) = request.into_parts();
    let Ok(Value::Object(map)) = parse_request_body(&parts.headers, body, MAX_JSON_BYTES).await
    else {
        return String::new();
    };
    map.get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

async fn userinfo(State(state): State<AppState>, request: Request) -> HandlerResult<Response> {
    let headers = request.headers().clone();
    let issuer = issuer_for(&state, &headers);
    let bearer = presented_access_token(request).await;
    if bearer.is_empty() {
        return Err(
            OAuthError::unauthorized("invalid_token", "An access token is required").into(),
        );
    }
    let (row, user) = access_grant_from_token(&state, &bearer, Some(&issuer)).await?;
    let claims = user_info_claims(&state, &row, &user).await?;
    Ok(axum::Json(claims).into_response())
}

#[derive(Debug, Deserialize)]
struct RevocationRequest {
    token: String,
    #[serde(default)]
    token_type_hint: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
}

fn validate_token(token: &str) -> Result<(), OrbitError> {
    if token.is_empty() {
        return Err(OrbitError::unprocessable(
            orbitid_core::error::error_codes::FORM_PARAM_VALUE_INVALID,
            "token must not be empty",
        )
        .with_meta(serde_json::json!({ "param_name": "token" })));
    }
    Ok(())
}

fn validate_token_type_hint(hint: Option<&str>) -> Result<(), OrbitError> {
    match hint {
        None | Some("access_token") | Some("refresh_token") => Ok(()),
        Some(_) => Err(OrbitError::unprocessable(
            orbitid_core::error::error_codes::FORM_PARAM_FORMAT_INVALID,
            "token_type_hint must be access_token or refresh_token",
        )
        .with_meta(serde_json::json!({ "param_name": "token_type_hint" }))),
    }
}

async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<RevocationRequest>,
) -> HandlerResult<Response> {
    validate_token(&body.token)?;
    validate_token_type_hint(body.token_type_hint.as_deref())?;
    let app_row = authenticate_client(
        &state,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        body.client_id.as_deref(),
        body.client_secret.as_deref(),
    )
    .await?;
    revoke_token(&state, &app_row, &body.token).await?;
    Ok(StatusCode::OK.into_response())
}

async fn introspect(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<RevocationRequest>,
) -> HandlerResult<Response> {
    validate_token(&body.token)?;
    validate_token_type_hint(body.token_type_hint.as_deref())?;
    let app_row = authenticate_client(
        &state,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        body.client_id.as_deref(),
        body.client_secret.as_deref(),
    )
    .await?;
    // RFC 7662 requires confidential client authentication.
    if app_row.is_public {
        return Err(OAuthError::invalid_client("Public clients cannot introspect tokens").into());
    }
    let issuer = issuer_for(&state, &headers);
    let body = introspect_token(&state, &app_row, &body.token, Some(&issuer)).await?;
    Ok(axum::Json(body).into_response())
}
