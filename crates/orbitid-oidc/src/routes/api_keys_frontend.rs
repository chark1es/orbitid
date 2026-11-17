//! Frontend API self-service API keys (`/v1/client/me/api_keys` and
//! `/v1/client/organizations/{orgId}/api_keys`), ported from
//! `modules/api-keys.ts`.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::{OrbitJson, PaginationQuery};
use orbitid_core::state::AppState;
use orbitid_identity::machine_auth::require_user_caller;

use super::api_keys::{
    include_invalid, patch_from_body, validate_description, validate_expiration, validate_name,
    validate_scopes, PatchKeyBody, RevokeBody,
};
use crate::services::api_keys::{
    assert_api_key_ownership, assert_org_api_keys_permission, create_api_key, delete_api_key,
    list_api_keys, require_api_key, revoke_api_key, serialize_api_key, update_api_key,
    CreateApiKeyInput, ListApiKeysOptions,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/me/api_keys", get(user_list).post(user_create))
        .route(
            "/v1/client/me/api_keys/{id}",
            get(user_detail).patch(user_update).delete(user_delete),
        )
        .route("/v1/client/me/api_keys/{id}/revoke", post(user_revoke))
        .route(
            "/v1/client/organizations/{orgId}/api_keys",
            get(org_list).post(org_create),
        )
        .route(
            "/v1/client/organizations/{orgId}/api_keys/{id}",
            get(org_detail).patch(org_update).delete(org_delete),
        )
        .route(
            "/v1/client/organizations/{orgId}/api_keys/{id}/revoke",
            post(org_revoke),
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubjectKind {
    User,
    Organization,
}

#[derive(Debug, Default, Deserialize)]
struct FapiCreateBody {
    name: String,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    claims: Option<Option<Map<String, Value>>>,
    #[serde(default)]
    seconds_until_expiration: Option<i64>,
    #[serde(default)]
    description: Option<Option<String>>,
}

struct Subject {
    subject: String,
    actor_id: String,
    anonymous: bool,
}

async fn resolve_subject(
    state: &AppState,
    headers: &HeaderMap,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Subject, OrbitError> {
    let caller = require_user_caller(state, headers).await?;
    let user_id = caller.user_id.clone().unwrap_or_default();
    match kind {
        SubjectKind::User => {
            let anonymous: Option<bool> =
                sqlx::query_scalar("SELECT is_anonymous FROM users WHERE id = $1")
                    .bind(&user_id)
                    .fetch_optional(&state.pool)
                    .await?;
            Ok(Subject {
                subject: user_id.clone(),
                actor_id: user_id,
                anonymous: anonymous.unwrap_or(false),
            })
        }
        SubjectKind::Organization => {
            let org_id = org_id.unwrap_or_default();
            let exists: Option<String> =
                sqlx::query_scalar("SELECT id FROM organizations WHERE id = $1")
                    .bind(org_id)
                    .fetch_optional(&state.pool)
                    .await?;
            if exists.is_none() {
                return Err(OrbitError::not_found(
                    error_codes::ORGANIZATION_NOT_FOUND,
                    "Organization not found",
                ));
            }
            assert_org_api_keys_permission(state, &user_id, org_id).await?;
            Ok(Subject {
                subject: org_id.to_string(),
                actor_id: user_id,
                anonymous: false,
            })
        }
    }
}

async fn frontend_list(
    state: &AppState,
    headers: &HeaderMap,
    page: PaginationQuery,
    uri: &Uri,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    let (rows, _) = list_api_keys(
        state,
        ListApiKeysOptions {
            subject: Some(&subject.subject),
            include_invalid: include_invalid(uri),
            limit: page.limit,
            offset: page.offset,
            order_by: page.order_by.as_deref(),
        },
    )
    .await?;
    let data: Vec<_> = rows
        .iter()
        .map(|row| serialize_api_key(row, None))
        .collect();
    Ok(Json(json!({ "response": data })).into_response())
}

async fn frontend_create(
    state: &AppState,
    headers: &HeaderMap,
    body: FapiCreateBody,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    // A guest account must attach an identifier before it can own machine credentials.
    if subject.anonymous {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Anonymous accounts cannot create API keys. Add an email address or password first.",
        ));
    }
    validate_name(&body.name)?;
    validate_scopes(body.scopes.as_ref())?;
    validate_description(body.description.as_ref())?;
    validate_expiration(body.seconds_until_expiration)?;
    let (row, secret) = create_api_key(
        state,
        CreateApiKeyInput {
            name: body.name,
            subject: subject.subject,
            scopes: body.scopes,
            claims: body.claims.flatten(),
            seconds_until_expiration: body.seconds_until_expiration,
            description: body.description.flatten(),
            created_by: Some(subject.actor_id),
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "response": serialize_api_key(&row, Some(&secret)) })),
    )
        .into_response())
}

async fn frontend_detail(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    let row = require_api_key(state, id).await?;
    assert_api_key_ownership(&row, &subject.subject)?;
    Ok(Json(json!({ "response": serialize_api_key(&row, None) })).into_response())
}

async fn frontend_update(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    body: PatchKeyBody,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    let row = require_api_key(state, id).await?;
    assert_api_key_ownership(&row, &subject.subject)?;
    let patch = patch_from_body(body)?;
    Ok(Json(json!({
        "response": serialize_api_key(&update_api_key(state, &row, patch).await?, None)
    }))
    .into_response())
}

async fn frontend_revoke(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    body: RevokeBody,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    let row = require_api_key(state, id).await?;
    assert_api_key_ownership(&row, &subject.subject)?;
    let reason = body.revocation_reason.flatten();
    Ok(Json(json!({
        "response": serialize_api_key(&revoke_api_key(state, &row, reason.as_deref()).await?, None)
    }))
    .into_response())
}

async fn frontend_delete(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    kind: SubjectKind,
    org_id: Option<&str>,
) -> Result<Response, OrbitError> {
    let subject = resolve_subject(state, headers, kind, org_id).await?;
    let row = require_api_key(state, id).await?;
    assert_api_key_ownership(&row, &subject.subject)?;
    delete_api_key(state, &row).await?;
    Ok(Json(json!({
        "response": { "object": "api_key", "id": row.id, "deleted": true }
    }))
    .into_response())
}

async fn user_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    page: PaginationQuery,
    uri: Uri,
) -> Result<Response, OrbitError> {
    frontend_list(&state, &headers, page, &uri, SubjectKind::User, None).await
}

async fn user_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<FapiCreateBody>,
) -> Result<Response, OrbitError> {
    frontend_create(&state, &headers, body, SubjectKind::User, None).await
}

async fn user_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    frontend_detail(&state, &headers, &id, SubjectKind::User, None).await
}

async fn user_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PatchKeyBody>,
) -> Result<Response, OrbitError> {
    frontend_update(&state, &headers, &id, body, SubjectKind::User, None).await
}

async fn user_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<RevokeBody>,
) -> Result<Response, OrbitError> {
    frontend_revoke(&state, &headers, &id, body, SubjectKind::User, None).await
}

async fn user_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    frontend_delete(&state, &headers, &id, SubjectKind::User, None).await
}

async fn org_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    page: PaginationQuery,
    uri: Uri,
) -> Result<Response, OrbitError> {
    frontend_list(
        &state,
        &headers,
        page,
        &uri,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}

async fn org_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id): Path<String>,
    OrbitJson(body): OrbitJson<FapiCreateBody>,
) -> Result<Response, OrbitError> {
    frontend_create(
        &state,
        &headers,
        body,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}

async fn org_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, id)): Path<(String, String)>,
) -> Result<Response, OrbitError> {
    frontend_detail(
        &state,
        &headers,
        &id,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}

async fn org_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, id)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<PatchKeyBody>,
) -> Result<Response, OrbitError> {
    frontend_update(
        &state,
        &headers,
        &id,
        body,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}

async fn org_revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, id)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<RevokeBody>,
) -> Result<Response, OrbitError> {
    frontend_revoke(
        &state,
        &headers,
        &id,
        body,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}

async fn org_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id, id)): Path<(String, String)>,
) -> Result<Response, OrbitError> {
    frontend_delete(
        &state,
        &headers,
        &id,
        SubjectKind::Organization,
        Some(&org_id),
    )
    .await
}
