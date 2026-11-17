//! API keys: Backend API `/v1/api_keys` and Frontend API self-service for users
//! and organizations, ported from `modules/api-keys.ts`.

use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::{OrbitJson, PaginationQuery};
use orbitid_core::state::AppState;

use crate::services::api_keys::{
    create_api_key, delete_api_key, list_api_keys, require_api_key, revoke_api_key,
    serialize_api_key, update_api_key, verify_api_key, CreateApiKeyInput, ListApiKeysOptions,
    UpdateApiKeyInput,
};
use crate::web::query_map;

pub fn backend_router() -> Router<AppState> {
    Router::new()
        .route("/v1/api_keys", get(backend_list).post(backend_create))
        .route("/v1/api_keys/verify", post(backend_verify))
        .route(
            "/v1/api_keys/{id}",
            get(backend_detail)
                .patch(backend_update)
                .delete(backend_delete),
        )
        .route("/v1/api_keys/{id}/revoke", post(backend_revoke))
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct CreateKeyBody {
    name: String,
    subject: String,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    claims: Option<Option<Map<String, Value>>>,
    #[serde(default)]
    seconds_until_expiration: Option<i64>,
    #[serde(default)]
    description: Option<Option<String>>,
    #[serde(default)]
    created_by: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct PatchKeyBody {
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) description: Option<Option<String>>,
    #[serde(default)]
    pub(super) scopes: Option<Vec<String>>,
    #[serde(default)]
    pub(super) claims: Option<Option<Map<String, Value>>>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct RevokeBody {
    #[serde(default)]
    pub(super) revocation_reason: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct VerifyBody {
    secret: String,
}

pub(super) fn unprocessable(param: &str, message: &str) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_VALUE_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

pub(super) fn validate_name(name: &str) -> Result<(), OrbitError> {
    if name.is_empty() || name.chars().count() > 256 {
        return Err(unprocessable(
            "name",
            "name must be between 1 and 256 characters",
        ));
    }
    Ok(())
}

pub(super) fn validate_scopes(scopes: Option<&Vec<String>>) -> Result<(), OrbitError> {
    let Some(scopes) = scopes else { return Ok(()) };
    if scopes.len() > 100 || scopes.iter().any(|scope| scope.is_empty()) {
        return Err(unprocessable(
            "scopes",
            "scopes must contain at most 100 non-empty strings",
        ));
    }
    Ok(())
}

pub(super) fn validate_description(description: Option<&Option<String>>) -> Result<(), OrbitError> {
    if let Some(Some(description)) = description {
        if description.chars().count() > 1024 {
            return Err(unprocessable(
                "description",
                "description must be at most 1024 characters",
            ));
        }
    }
    Ok(())
}

pub(super) fn validate_expiration(seconds: Option<i64>) -> Result<(), OrbitError> {
    if seconds.is_some_and(|seconds| seconds <= 0) {
        return Err(unprocessable(
            "seconds_until_expiration",
            "seconds_until_expiration must be positive",
        ));
    }
    Ok(())
}

async fn backend_create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateKeyBody>,
) -> Result<Response, OrbitError> {
    validate_name(&body.name)?;
    validate_scopes(body.scopes.as_ref())?;
    validate_description(body.description.as_ref())?;
    validate_expiration(body.seconds_until_expiration)?;
    let (row, secret) = create_api_key(
        &state,
        CreateApiKeyInput {
            name: body.name,
            subject: body.subject,
            scopes: body.scopes,
            claims: body.claims.flatten(),
            seconds_until_expiration: body.seconds_until_expiration,
            description: body.description.flatten(),
            created_by: body.created_by.flatten(),
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serialize_api_key(&row, Some(&secret))),
    )
        .into_response())
}

async fn backend_verify(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<VerifyBody>,
) -> Result<Response, OrbitError> {
    let row = verify_api_key(&state, &body.secret).await?;
    Ok(Json(serialize_api_key(&row, None)).into_response())
}

pub(super) fn include_invalid(uri: &Uri) -> bool {
    query_map(uri.query())
        .get("include_invalid")
        .is_some_and(|value| value == "true" || value == "1")
}

async fn backend_list(
    State(state): State<AppState>,
    page: PaginationQuery,
    uri: Uri,
) -> Result<Response, OrbitError> {
    let query = query_map(uri.query());
    let subject = query
        .get("subject")
        .cloned()
        .filter(|value| !value.is_empty());
    let (rows, total) = list_api_keys(
        &state,
        ListApiKeysOptions {
            subject: subject.as_deref(),
            include_invalid: include_invalid(&uri),
            limit: page.limit,
            offset: page.offset,
            order_by: page.order_by.as_deref(),
        },
    )
    .await?;
    Ok(Json(json!({
        "data": rows.iter().map(|row| serialize_api_key(row, None)).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

async fn backend_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_api_key(&state, &id).await?;
    Ok(Json(serialize_api_key(&row, None)).into_response())
}

async fn backend_update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PatchKeyBody>,
) -> Result<Response, OrbitError> {
    let row = require_api_key(&state, &id).await?;
    let patch = patch_from_body(body)?;
    Ok(Json(serialize_api_key(
        &update_api_key(&state, &row, patch).await?,
        None,
    ))
    .into_response())
}

pub(super) fn patch_from_body(body: PatchKeyBody) -> Result<UpdateApiKeyInput, OrbitError> {
    if body.name.is_none()
        && body.description.is_none()
        && body.scopes.is_none()
        && body.claims.is_none()
    {
        return Err(unprocessable("body", "at least one field is required"));
    }
    if let Some(name) = &body.name {
        validate_name(name)?;
    }
    validate_scopes(body.scopes.as_ref())?;
    validate_description(body.description.as_ref())?;
    Ok(UpdateApiKeyInput {
        name: body.name,
        description: body.description,
        scopes: body.scopes,
        claims: body.claims,
    })
}

async fn backend_revoke(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<RevokeBody>,
) -> Result<Response, OrbitError> {
    let row = require_api_key(&state, &id).await?;
    let reason = body.revocation_reason.flatten();
    if let Some(reason) = &reason {
        if reason.chars().count() > 1024 {
            return Err(unprocessable(
                "revocation_reason",
                "revocation_reason must be at most 1024 characters",
            ));
        }
    }
    Ok(Json(serialize_api_key(
        &revoke_api_key(&state, &row, reason.as_deref()).await?,
        None,
    ))
    .into_response())
}

async fn backend_delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_api_key(&state, &id).await?;
    delete_api_key(&state, &row).await?;
    Ok(Json(json!({ "object": "api_key", "id": row.id, "deleted": true })).into_response())
}
