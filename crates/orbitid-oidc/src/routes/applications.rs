//! OAuth application management routes, ported from `modules/oidc/applications.ts`.
//!
//! The TypeScript router guards `/v1/oauth_applications` itself (the route is
//! not part of the `backend` group), so this router applies
//! `require_secret_key` internally and `orbitid-server` mounts it publicly.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::{OrbitJson, PaginationQuery};
use orbitid_core::state::AppState;

use crate::services::oidc::applications::{
    create_application, delete_application, list_applications, require_application,
    rotate_client_secret, serialize_application, update_application, valid_groups_claim,
    CreateApplicationInput, UpdateApplicationInput,
};
use crate::services::oidc::shared::{
    LIFETIME_BOUNDS_ACCESS, LIFETIME_BOUNDS_ID, LIFETIME_BOUNDS_REFRESH,
};

/// Secret-key guard for `/v1/oauth_applications`.
///
/// The TypeScript router applies `requireSecretKey` itself. In axum a
/// `from_fn` middleware cannot read `AppState` before `.with_state` is called,
/// so this extractor calls the same core check the server's backend middleware
/// uses (query-string refusal, bearer key, operator-session cookie hook and the
/// distributed failure budget).
struct SecretKeyGuard;

impl FromRequestParts<AppState> for SecretKeyGuard {
    type Rejection = OrbitError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, OrbitError> {
        if orbitid_core::http::query_has_credential(parts.uri.query()) {
            return Err(OrbitError::unauthorized(
                error_codes::SECRET_KEY_INVALID,
                "Send the secret key in the Authorization header, never in the query string",
            ));
        }
        let peer = orbitid_core::http::peer_addr(&parts.extensions);
        orbitid_core::http::check_secret_key(state, &parts.headers, peer).await?;
        Ok(Self)
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/oauth_applications", get(list).post(create))
        .route(
            "/v1/oauth_applications/{id}",
            get(detail).patch(update).delete(remove),
        )
        .route(
            "/v1/oauth_applications/{id}/rotate_secret",
            post(rotate_secret),
        )
}

fn unprocessable(param: &str, message: &str) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_VALUE_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

fn check_name(name: &str) -> Result<(), OrbitError> {
    if name.is_empty() || name.chars().count() > 256 {
        return Err(unprocessable(
            "name",
            "name must be between 1 and 256 characters",
        ));
    }
    Ok(())
}

fn check_urls(values: Option<&Vec<String>>, param: &str) -> Result<(), OrbitError> {
    let Some(values) = values else { return Ok(()) };
    if values.len() > 50 {
        return Err(unprocessable(param, "at most 50 entries are allowed"));
    }
    for value in values {
        if url::Url::parse(value).is_err() {
            return Err(unprocessable(param, "must be a valid URL"));
        }
    }
    Ok(())
}

fn check_lifetime(value: Option<i64>, bounds: (i64, i64), param: &str) -> Result<(), OrbitError> {
    if let Some(value) = value {
        if value < bounds.0 || value > bounds.1 {
            return Err(unprocessable(
                param,
                &format!("must be between {} and {}", bounds.0, bounds.1),
            ));
        }
    }
    Ok(())
}

fn check_groups_claim(value: Option<&String>) -> Result<(), OrbitError> {
    if let Some(value) = value {
        if !valid_groups_claim(value) {
            return Err(unprocessable(
                "groups_claim",
                "groups_claim must be one of none, organizations, roles, all",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct CreateApplicationBody {
    name: String,
    #[serde(default)]
    redirect_uris: Option<Vec<String>>,
    #[serde(default)]
    post_logout_redirect_uris: Option<Vec<String>>,
    #[serde(default)]
    scopes: Option<String>,
    #[serde(default)]
    public: Option<bool>,
    #[serde(default)]
    consent_screen_enabled: Option<bool>,
    #[serde(default)]
    pkce_required: Option<bool>,
    #[serde(default)]
    access_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    refresh_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    id_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    groups_claim: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    OrbitJson(body): OrbitJson<CreateApplicationBody>,
) -> Result<Response, OrbitError> {
    check_name(&body.name)?;
    check_urls(body.redirect_uris.as_ref(), "redirect_uris")?;
    check_urls(
        body.post_logout_redirect_uris.as_ref(),
        "post_logout_redirect_uris",
    )?;
    check_lifetime(
        body.access_token_lifetime_seconds,
        LIFETIME_BOUNDS_ACCESS,
        "access_token_lifetime_seconds",
    )?;
    check_lifetime(
        body.refresh_token_lifetime_seconds,
        LIFETIME_BOUNDS_REFRESH,
        "refresh_token_lifetime_seconds",
    )?;
    check_lifetime(
        body.id_token_lifetime_seconds,
        LIFETIME_BOUNDS_ID,
        "id_token_lifetime_seconds",
    )?;
    check_groups_claim(body.groups_claim.as_ref())?;
    let (row, client_secret) = create_application(
        &state,
        CreateApplicationInput {
            name: body.name,
            redirect_uris: body.redirect_uris,
            post_logout_redirect_uris: body.post_logout_redirect_uris,
            scopes: body.scopes,
            is_public: body.public,
            consent_screen_enabled: body.consent_screen_enabled,
            pkce_required: body.pkce_required,
            access_token_lifetime_seconds: body.access_token_lifetime_seconds,
            refresh_token_lifetime_seconds: body.refresh_token_lifetime_seconds,
            id_token_lifetime_seconds: body.id_token_lifetime_seconds,
            groups_claim: body.groups_claim,
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serialize_application(&row, client_secret.as_deref())),
    )
        .into_response())
}

async fn list(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    page: PaginationQuery,
) -> Result<Response, OrbitError> {
    let rows = list_applications(&state, page.limit, page.offset).await?;
    let total = crate::services::oidc::applications::count_applications(&state).await?;
    Ok(Json(json!({
        "data": rows.iter().map(|row| serialize_application(row, None)).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

async fn detail(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_application(&state, &id).await?;
    Ok(Json(serialize_application(&row, None)).into_response())
}

#[derive(Debug, Default, Deserialize)]
struct UpdateApplicationBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    redirect_uris: Option<Vec<String>>,
    #[serde(default)]
    post_logout_redirect_uris: Option<Vec<String>>,
    #[serde(default)]
    scopes: Option<String>,
    #[serde(default)]
    consent_screen_enabled: Option<bool>,
    #[serde(default)]
    pkce_required: Option<bool>,
    #[serde(default)]
    access_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    refresh_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    id_token_lifetime_seconds: Option<i64>,
    #[serde(default)]
    groups_claim: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    axum::extract::Path(id): axum::extract::Path<String>,
    OrbitJson(body): OrbitJson<UpdateApplicationBody>,
) -> Result<Response, OrbitError> {
    let row = require_application(&state, &id).await?;
    let empty = body.name.is_none()
        && body.redirect_uris.is_none()
        && body.post_logout_redirect_uris.is_none()
        && body.scopes.is_none()
        && body.consent_screen_enabled.is_none()
        && body.pkce_required.is_none()
        && body.access_token_lifetime_seconds.is_none()
        && body.refresh_token_lifetime_seconds.is_none()
        && body.id_token_lifetime_seconds.is_none()
        && body.groups_claim.is_none();
    if empty {
        return Err(unprocessable("body", "at least one field is required"));
    }
    if let Some(name) = &body.name {
        check_name(name)?;
    }
    check_urls(body.redirect_uris.as_ref(), "redirect_uris")?;
    check_urls(
        body.post_logout_redirect_uris.as_ref(),
        "post_logout_redirect_uris",
    )?;
    check_lifetime(
        body.access_token_lifetime_seconds,
        LIFETIME_BOUNDS_ACCESS,
        "access_token_lifetime_seconds",
    )?;
    check_lifetime(
        body.refresh_token_lifetime_seconds,
        LIFETIME_BOUNDS_REFRESH,
        "refresh_token_lifetime_seconds",
    )?;
    check_lifetime(
        body.id_token_lifetime_seconds,
        LIFETIME_BOUNDS_ID,
        "id_token_lifetime_seconds",
    )?;
    check_groups_claim(body.groups_claim.as_ref())?;
    let updated = update_application(
        &state,
        &row,
        UpdateApplicationInput {
            name: body.name,
            redirect_uris: body.redirect_uris,
            post_logout_redirect_uris: body.post_logout_redirect_uris,
            scopes: body.scopes,
            consent_screen_enabled: body.consent_screen_enabled,
            pkce_required: body.pkce_required,
            access_token_lifetime_seconds: body.access_token_lifetime_seconds,
            refresh_token_lifetime_seconds: body.refresh_token_lifetime_seconds,
            id_token_lifetime_seconds: body.id_token_lifetime_seconds,
            groups_claim: body.groups_claim,
        },
    )
    .await?;
    Ok(Json(serialize_application(&updated, None)).into_response())
}

async fn remove(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_application(&state, &id).await?;
    delete_application(&state, &row).await?;
    Ok(Json(json!({
        "object": "oauth_application",
        "id": row.id,
        "deleted": true,
    }))
    .into_response())
}

async fn rotate_secret(
    State(state): State<AppState>,
    _guard: SecretKeyGuard,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_application(&state, &id).await?;
    let (updated, client_secret) = rotate_client_secret(&state, &row).await?;
    Ok(Json(serialize_application(&updated, Some(&client_secret))).into_response())
}
