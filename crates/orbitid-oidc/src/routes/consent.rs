//! OAuth consent routes: the consent screen data and the consent decision.
//! Ported from `modules/oidc/discovery.ts`.

use axum::extract::State;
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_identity::machine_auth::resolve_caller;

use crate::services::oidc::applications::{
    assert_redirect_uri, assert_scopes_allowed, get_application_by_client_id, ApplicationRow,
};
use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::shared::{parse_scopes, scope_description, HandlerResult};
use crate::services::oidc::tokens::{
    issue_authorization_code_on, record_consent_on, stored_consent,
};
use crate::web::{query_map, url_with};

use super::discovery::query_value;

fn application_json(app_row: &ApplicationRow) -> serde_json::Value {
    json!({
        "id": app_row.id,
        "client_id": app_row.client_id,
        "name": app_row.name,
        "logo_url": null,
        "public": app_row.is_public,
    })
}

fn scope_json(scopes: &[String]) -> Vec<serde_json::Value> {
    scopes
        .iter()
        .map(|scope| json!({ "scope": scope, "description": scope_description(scope) }))
        .collect()
}

fn application_not_found() -> OrbitError {
    OrbitError::not_found(
        error_codes::RESOURCE_NOT_FOUND,
        "OAuth application not found",
    )
}

fn access_denied_redirect(redirect_uri: &str, state_param: Option<&str>) -> Response {
    axum::Json(json!({
        "redirect_url": url_with(
            redirect_uri,
            &[
                ("error", Some("access_denied")),
                ("error_description", Some("The user is not allowed to use this application")),
                ("state", state_param),
            ],
        )
    }))
    .into_response()
}

fn authentication_required() -> OrbitError {
    OrbitError::unauthorized(
        error_codes::AUTHENTICATION_INVALID,
        "Authentication invalid. Please sign in again.",
    )
}

pub(crate) async fn consent_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> HandlerResult<Response> {
    let caller = resolve_caller(&state, &headers)
        .await?
        .ok_or_else(authentication_required)?;
    let user_id = caller.user_id.clone().ok_or_else(authentication_required)?;
    let query = query_map(uri.query());
    let client_id = query_value(&query, "client_id").unwrap_or_default();
    let app_row = get_application_by_client_id(&state, &client_id)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "OAuth application not found",
            )
        })?;
    // A user who may not use an organization's application is told the same as
    // for an unknown client: the consent screen never shows it to them.
    if !orbitid_identity::app_access::user_may_use_application(
        &state.pool,
        &app_row.id,
        app_row.organization_id.as_deref(),
        &user_id,
    )
    .await?
    {
        return Err(application_not_found().into());
    }
    let requested = parse_scopes(&query_value(&query, "scope").unwrap_or_else(|| "openid".into()));
    let previously_approved = stored_consent(&state, &app_row.id, &user_id).await?;
    Ok(axum::Json(json!({
        "client": application_json(&app_row),
        "scopes": scope_json(&requested),
        "previously_approved": previously_approved.unwrap_or_default(),
        "redirect_url": query_value(&query, "redirect_url"),
    }))
    .into_response())
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct ConsentBody {
    client_id: String,
    approve: bool,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    code_challenge: Option<String>,
    #[serde(default)]
    code_challenge_method: Option<String>,
}

pub(crate) async fn consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<ConsentBody>,
) -> HandlerResult<Response> {
    let caller = resolve_caller(&state, &headers)
        .await?
        .ok_or_else(authentication_required)?;
    let user_id = caller.user_id.clone().ok_or_else(authentication_required)?;
    let app_row = match get_application_by_client_id(&state, &body.client_id).await? {
        Some(row) => row,
        None => {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "OAuth application not found",
            )
            .into())
        }
    };
    let redirect_uri = assert_redirect_uri(&app_row, body.redirect_uri.as_deref())?;
    let state_param = body.state.as_deref().filter(|value| !value.is_empty());

    let scopes = match assert_scopes_allowed(
        &app_row,
        &body
            .scopes
            .filter(|scopes| !scopes.is_empty())
            .unwrap_or_else(|| parse_scopes(body.scope.as_deref().unwrap_or("openid"))),
    ) {
        Ok(scopes) => scopes,
        Err(error) => {
            return Ok(axum::Json(json!({
                "redirect_url": url_with(
                    &redirect_uri,
                    &[
                        ("error", Some("invalid_scope")),
                        ("error_description", Some(&error.description)),
                        ("state", state_param),
                    ],
                )
            }))
            .into_response())
        }
    };

    if !body.approve {
        return Ok(axum::Json(json!({
            "redirect_url": url_with(
                &redirect_uri,
                &[
                    ("error", Some("access_denied")),
                    ("error_description", Some("The user denied the request")),
                    ("state", state_param),
                ],
            )
        }))
        .into_response());
    }
    // The consent record and the authorization code it authorizes commit
    // together: a failure can never store consent without issuing a code (or
    // issue a code whose consent was not persisted).
    let mut tx = state.pool.begin().await?;
    // Rank 3, then the application row `FOR SHARE` (between ranks 10 and 11),
    // then the consent row: the access check is serialized with membership
    // removal (user lock) and owner changes (application lock), and the
    // application is locked before any of its child rows (application deletion
    // locks it first and cascades into consents).
    orbitid_identity::locks::key_share_user_on(&mut tx, &user_id).await?;
    if !orbitid_identity::app_access::user_may_use_application_on(&mut tx, &app_row.id, &user_id)
        .await?
    {
        tx.rollback().await.ok();
        return Ok(access_denied_redirect(&redirect_uri, state_param));
    }
    // `record_consent_on` re-checks the user under its key-share before the
    // consent row, and the code insert below references the same user.
    record_consent_on(&mut tx, &app_row.id, &user_id, &scopes).await?;
    let code = issue_authorization_code_on(
        &mut tx,
        &state,
        crate::services::oidc::tokens::IssueCodeInput {
            application: &app_row,
            user_id: &user_id,
            scopes: &scopes,
            redirect_uri: &redirect_uri,
            code_challenge: body
                .code_challenge
                .as_deref()
                .filter(|value| !value.is_empty()),
            code_challenge_method: body
                .code_challenge_method
                .as_deref()
                .filter(|value| !value.is_empty()),
            nonce: body.nonce.as_deref().filter(|value| !value.is_empty()),
            session_id: caller.session_id.as_deref(),
        },
    )
    .await?;
    tx.commit().await?;
    let issuer = issuer_for(&state, &headers);
    Ok(axum::Json(json!({
        "redirect_url": url_with(
            &redirect_uri,
            &[
                ("code", Some(&code)),
                ("state", state_param),
                ("iss", Some(&issuer)),
            ],
        )
    }))
    .into_response())
}
