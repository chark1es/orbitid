//! Frontend API for the device grant (`/v1/client/oauth/device…`), ported
//! from `modules/oidc/device.ts`.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_identity::machine_auth::require_user_caller;

use crate::services::oidc::device::{
    decide_device_code, device_application, find_device_by_user_code, format_user_code,
    normalize_user_code, DeviceDecision, DeviceDecisionInput,
};
use crate::services::oidc::shared::{parse_scopes, scope_description, HandlerResult};
use crate::web::query_map;

use super::device::{count_device_attempt, device_enabled};
use super::{json_response, Peer};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/oauth/device", get(client_device_info))
        .route(
            "/v1/client/oauth/device/approve",
            post(client_device_approve),
        )
}

async fn client_device_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    uri: Uri,
) -> HandlerResult<Response> {
    if !device_enabled(&state) {
        return Err(
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Route not found").into(),
        );
    }
    require_user_caller(&state, &headers).await?;
    let query = query_map(uri.query());
    let raw = query.get("user_code").cloned().unwrap_or_default();
    let Some(code) = normalize_user_code(&raw) else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "user_code must look like ABCD-EFGH",
        )
        .with_meta(json!({ "param_name": "user_code" }))
        .into());
    };
    count_device_attempt(&state, &headers, peer, &code).await?;
    let Some(row) = find_device_by_user_code(&state, &code).await? else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "That code is not valid",
        )
        .into());
    };
    if row.expires_at <= orbitid_core::http::now() {
        return Err(OrbitError::new(
            StatusCode::GONE,
            error_codes::VERIFICATION_EXPIRED,
            "That code has expired",
        )
        .into());
    }
    let Some(application) = device_application(&state, &row).await? else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "OAuth application not found",
        )
        .into());
    };
    let scopes: Vec<serde_json::Value> = parse_scopes(&row.scopes)
        .into_iter()
        .map(|scope| {
            let description = scope_description(&scope);
            json!({ "scope": scope, "description": description })
        })
        .collect();
    Ok(json_response(
        StatusCode::OK,
        json!({
            "user_code": format_user_code(&row.user_code),
            "status": row.status,
            "expires_at": row.expires_at,
            "client": {
                "id": application.id,
                "client_id": application.client_id,
                "name": application.name,
                "public": application.is_public,
            },
            "scopes": scopes,
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct ApproveBody {
    user_code: String,
    action: String,
}

async fn client_device_approve(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    OrbitJson(body): OrbitJson<ApproveBody>,
) -> HandlerResult<Response> {
    if !device_enabled(&state) {
        return Err(
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Route not found").into(),
        );
    }
    let caller = require_user_caller(&state, &headers).await?;
    let user_id = caller.user_id.clone().unwrap_or_default();
    let Some(code) = normalize_user_code(&body.user_code) else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "user_code must look like ABCD-EFGH",
        )
        .with_meta(json!({ "param_name": "user_code" }))
        .into());
    };
    if body.action != "approve" && body.action != "deny" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "action must be approve or deny",
        )
        .with_meta(json!({ "param_name": "action" }))
        .into());
    }
    count_device_attempt(&state, &headers, peer, &code).await?;
    let approve = body.action == "approve";
    let decision = decide_device_code(
        &state,
        DeviceDecisionInput {
            user_code: &code,
            user_id: &user_id,
            approve,
        },
    )
    .await?;
    match decision {
        DeviceDecision::Ok {
            application,
            scopes,
        } => Ok(json_response(
            StatusCode::OK,
            json!({
                "object": "oauth_device_authorization",
                "user_code": format_user_code(&code),
                "status": if approve { "approved" } else { "denied" },
                "client": {
                    "id": application.id,
                    "client_id": application.client_id,
                    "name": application.name,
                },
                "scopes": scopes,
            }),
        )),
        DeviceDecision::Rejected { reason } => match reason {
            "not_found" => Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "That code is not valid",
            )
            .into()),
            "access_denied" => Err(OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "Your account does not have access to this application",
            )
            .into()),
            "expired" => Err(OrbitError::new(
                StatusCode::GONE,
                error_codes::VERIFICATION_EXPIRED,
                "That code has expired",
            )
            .into()),
            _ => Err(OrbitError::new(
                StatusCode::CONFLICT,
                error_codes::VERIFICATION_FAILED,
                "That code has already been used",
            )
            .into()),
        },
    }
}
