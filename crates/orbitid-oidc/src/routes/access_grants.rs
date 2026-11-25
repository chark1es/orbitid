//! Backend API for per-user access to organization-owned OAuth applications.
//!
//! Mounted in [`crate::backend_router`], which `orbitid-server` wraps with
//! `require_secret_key` (secret key or dashboard session). There is no Frontend
//! API counterpart: only operators grant cross-organization access.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::{OrbitJson, PaginationQuery};
use orbitid_core::state::AppState;
use orbitid_platform::audit::{audit, AuditInput};

use crate::services::oidc::access_grants::{
    grant_application_access, list_application_access_grants, list_user_access_grants,
    revoke_application_access, serialize_access_grant, user_exists,
};
use crate::services::oidc::applications::require_application;

pub fn backend_router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/oauth_applications/{id}/access_grants",
            get(list_for_application).post(create),
        )
        .route(
            "/v1/oauth_applications/{id}/access_grants/{user_id}",
            delete(remove),
        )
        .route(
            "/v1/users/{id}/oauth_application_access_grants",
            get(list_for_user),
        )
}

fn user_not_found() -> OrbitError {
    OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found")
}

async fn list_for_application(
    State(state): State<AppState>,
    Path(id): Path<String>,
    page: PaginationQuery,
) -> Result<Response, OrbitError> {
    let application = require_application(&state, &id).await?;
    let (rows, total) =
        list_application_access_grants(&state, &application.id, page.limit, page.offset).await?;
    Ok(Json(json!({
        "data": rows.iter().map(serialize_access_grant).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

async fn list_for_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    page: PaginationQuery,
) -> Result<Response, OrbitError> {
    if !user_exists(&state, &id).await? {
        return Err(user_not_found());
    }
    let (rows, total) = list_user_access_grants(&state, &id, page.limit, page.offset).await?;
    Ok(Json(json!({
        "data": rows.iter().map(serialize_access_grant).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    user_id: String,
}

async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response, OrbitError> {
    let application = require_application(&state, &id).await?;
    if application.organization_id.is_none() {
        // Re-checked under the application lock by the service; this answers
        // before the user lookup.
        return Err(crate::services::oidc::access_grants::instance_wide_grant_refused());
    }
    if body.user_id.trim().is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "user_id must not be empty",
        )
        .with_meta(json!({ "param_name": "user_id" })));
    }
    let (row, created) = grant_application_access(&state, &application.id, &body.user_id).await?;
    if created {
        audit(
            &state,
            AuditInput::new("oauth_application_access_grant.created")
                .actor(orbitid_identity::admin::AUDIT_ACTOR)
                .target_type("oauth_application")
                .target_id(application.id.clone())
                .metadata(json!({
                    "user_id": row.user_id,
                    "organization_id": application.organization_id,
                })),
        )
        .await;
    }
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(serialize_access_grant(&row))).into_response())
}

async fn remove(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
) -> Result<Response, OrbitError> {
    let application = require_application(&state, &id).await?;
    let Some((row, revoked_grants)) =
        revoke_application_access(&state, &application.id, &user_id).await?
    else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Access grant not found",
        ));
    };
    audit(
        &state,
        AuditInput::new("oauth_application_access_grant.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("oauth_application")
            .target_id(application.id.clone())
            .metadata(json!({
                "user_id": row.user_id,
                "organization_id": application.organization_id,
                "revoked_grants": revoked_grants,
            })),
    )
    .await;
    Ok(Json(json!({
        "object": "oauth_application_access_grant",
        "application_id": row.application_id,
        "user_id": row.user_id,
        "deleted": true,
    }))
    .into_response())
}
