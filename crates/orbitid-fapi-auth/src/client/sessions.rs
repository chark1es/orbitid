use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::SessionRow;
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::{clear_client_cookie, client_azp};
use orbitid_identity::sessions::{
    end_session, evaluate_session_status, require_session, slide_session_activity,
    TouchSessionOptions,
};
use orbitid_identity::sessions_fapi::{end_session_on, touch_session_on};
use orbitid_identity::tokens::{sign_session_token, SignSessionTokenOptions};
use orbitid_identity::users::get_user_by_id;
use serde_json::Value;

use crate::signin::helpers::{open_client, serialize_client_full};
use crate::util::{client_ip, hit, Reply};

use super::bodies::VerifyBody;
use super::*;

pub async fn get(State(state): State<AppState>, headers: HeaderMap) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "GET", "/v1/client").await?;
    let json = serialize_client_full(&state, &client, client_azp(&headers).as_deref()).await?;
    Ok(Reply::json(serde_json::json!({ "response": json, "client": json })).cookie(cookie))
}

pub async fn delete(State(state): State<AppState>, headers: HeaderMap) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "DELETE", "/v1/client").await?;
    // Signing out of every session and clearing the client pointer is one
    // transaction: a failure can never leave a removed session pointed at, and
    // every `session.removed` event commits with its row.
    let mut tx = state.pool.begin().await?;
    // Global lock order: client before its sessions.
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&client.id)
        .fetch_optional(&mut *tx)
        .await?;
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&client.id)
    .fetch_all(&mut *tx)
    .await?;
    for row in rows {
        if row.status == "active" || row.status == "pending" {
            end_session_on(&mut tx, &state, &row, "removed").await?;
        }
    }
    sqlx::query("UPDATE clients SET last_active_session_id = NULL, updated_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now())
        .bind(&client.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let fresh =
        sqlx::query_as::<_, orbitid_core::models::ClientRow>("SELECT * FROM clients WHERE id = $1")
            .bind(&client.id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Client not found")
            })?;
    let json = serialize_client_full(&state, &fresh, client_azp(&headers).as_deref()).await?;
    let mut headers_out = HeaderMap::new();
    clear_client_cookie(&mut headers_out, &state);
    let clear = headers_out
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>();
    Ok(
        Reply::json(serde_json::json!({ "response": json, "client": json }))
            .cookie(cookie)
            .cookies(clear),
    )
}

pub(super) async fn session_json(
    state: &AppState,
    row: &SessionRow,
    last_token: Option<String>,
) -> Result<Value> {
    let json = orbitid_identity::serializers::serialize_session(
        state,
        row,
        orbitid_identity::serializers::SessionSerializeOptions {
            with_user: true,
            last_token,
        },
    )
    .await?;
    serde_json::to_value(json).map_err(|error| OrbitError::internal(error.to_string()))
}

pub async fn sessions(State(state): State<AppState>, headers: HeaderMap) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "GET", "/v1/client/sessions").await?;
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT * FROM sessions WHERE client_id = $1 ORDER BY created_at DESC",
    )
    .bind(&client.id)
    .fetch_all(&state.pool)
    .await?;
    let azp = client_azp(&headers);
    let mut response = Vec::new();
    for stored in rows {
        let status = evaluate_session_status(&state, &stored).await?;
        if status == "expired" {
            continue;
        }
        let mut row = stored;
        row.status = status.clone();
        let token = if status == "active" || status == "pending" {
            sign_session_token(
                &state,
                &row.id,
                SignSessionTokenOptions {
                    template: None,
                    azp: azp.clone(),
                },
            )
            .await
            .ok()
        } else {
            None
        };
        response.push(session_json(&state, &row, token).await?);
    }
    Ok(Reply::json(serde_json::json!({ "response": response })).cookie(cookie))
}

async fn respond_with_session(
    state: &AppState,
    headers: &HeaderMap,
    client: &orbitid_core::models::ClientRow,
    row: &SessionRow,
    cookies: Vec<String>,
) -> Result<Reply> {
    let json = serialize_client_full(state, client, client_azp(headers).as_deref()).await?;
    Ok(Reply::json(serde_json::json!({
        "response": session_json(state, row, None).await?,
        "client": json,
    }))
    .cookies(cookies))
}

/// Pre-body guard for `/v1/client/sessions/:id/...` POSTs. The TypeScript
/// handler creates/reuses the client and loads the session before parsing the
/// body, so an unauthenticated request with a malformed body is a 404/401 and a
/// new `__client` cookie is still delivered. Returns that cookie line, if any.
pub async fn guard_session_auth(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
) -> Result<Option<String>> {
    let (client, cookie) = open_client(state, headers, "POST", "/v1/client/sessions").await?;
    if let Some(id) = session_id_from_path(path) {
        if let Err(error) = require_session(state, &client.id, id).await {
            // The client was (or already is) issued before the session check, so
            // the error still carries the `__client` cookie, like the TS path.
            let error = match cookie.as_deref() {
                Some(cookie) => error.with_cookie(cookie),
                None => error,
            };
            return Err(error);
        }
    }
    Ok(cookie)
}

fn session_id_from_path(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/v1/client/sessions/")?;
    rest.split('/').next().filter(|part| !part.is_empty())
}

pub async fn touch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<TouchBody>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    let organization_id = match body.active_organization_id {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(value)) => Some(Some(value)),
        Some(_) => {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "active_organization_id must be a string",
            )
            .with_meta(serde_json::json!({ "param_name": "active_organization_id" })))
        }
    };
    // Only the session row is written in this transaction. The throttled
    // user-activity write runs after the commit as a single autocommit
    // statement (below), so a token refresh never serializes every browser of
    // the same user and cannot deadlock against a ban.
    let mut tx = state.pool.begin().await?;
    let updated = touch_session_on(
        &mut tx,
        &state,
        &row,
        TouchSessionOptions {
            organization_id,
            ip: Some(client_ip(&state, &headers)),
            user_agent: headers
                .get("user-agent")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        },
    )
    .await?;
    tx.commit().await?;
    let _ = orbitid_identity::sessions_fapi::touch_user_activity_after_commit(
        &state,
        &row.user_id,
        updated.last_active_at,
    )
    .await;
    respond_with_session(
        &state,
        &headers,
        &client,
        &updated,
        cookie.into_iter().collect(),
    )
    .await
}

async fn end(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    status: &str,
    method_path: &str,
) -> Result<Reply> {
    let (client, cookie) = open_client(state, headers, "POST", method_path).await?;
    let row = require_session(state, &client.id, id).await?;
    let updated = end_session(state, &row, status).await?;
    respond_with_session(
        state,
        headers,
        &client,
        &updated,
        cookie.into_iter().collect(),
    )
    .await
}

pub async fn end_current(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Reply> {
    end(&state, &headers, &id, "ended", "/v1/client/sessions").await
}

pub async fn remove_current(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Reply> {
    end(&state, &headers, &id, "removed", "/v1/client/sessions").await
}

async fn mint_token(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
    template: Option<String>,
) -> Result<Reply> {
    let (client, cookie) = open_client(state, headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(state, &client.id, id).await?;
    hit(state, &format!("session_token:{}", client.id), 600, 60_000).await?;
    slide_session_activity(state, &row, None).await?;
    let jwt = sign_session_token(
        state,
        &row.id,
        SignSessionTokenOptions {
            template,
            azp: client_azp(headers),
        },
    )
    .await?;
    Ok(Reply::json(serde_json::json!({ "jwt": jwt })).cookie(cookie))
}

pub async fn tokens(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<TokenBody>,
) -> Result<Reply> {
    mint_token(&state, &headers, &id, body.template).await
}

pub async fn tokens_template(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, template)): Path<(String, String)>,
) -> Result<Reply> {
    mint_token(&state, &headers, &id, Some(template)).await
}

fn verification_ages(row: &SessionRow) -> Value {
    let age = |value: Option<i64>| -> Option<i64> {
        value.map(|value| (orbitid_core::http::now() - value) / 60_000)
    };
    serde_json::json!({
        "first_factor": age(row.first_factor_verified_at),
        "second_factor": age(row.second_factor_verified_at),
    })
}

pub async fn verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Reply> {
    let (client, cookie) = open_client(&state, &headers, "GET", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    Ok(Reply::json(serde_json::json!({ "response": verification_ages(&row) })).cookie(cookie))
}

pub(super) async fn user_of_session(
    state: &AppState,
    row: &SessionRow,
) -> Result<orbitid_core::models::UserRow> {
    let user = get_user_by_id(state, &row.user_id).await?.ok_or_else(|| {
        OrbitError::unauthorized(error_codes::AUTHENTICATION_INVALID, "Not signed in")
    })?;
    if user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        ));
    }
    Ok(user)
}

pub(super) async fn respond_verification(
    state: &AppState,
    headers: &HeaderMap,
    client: &orbitid_core::models::ClientRow,
    row: &SessionRow,
    verification: Value,
    cookies: Vec<String>,
) -> Result<Reply> {
    let mut session = session_json(state, row, None).await?;
    if let Some(object) = session.as_object_mut() {
        object.insert("verification".into(), verification);
    }
    let client_json = serialize_client_full(state, client, client_azp(headers).as_deref()).await?;
    Ok(Reply::json(serde_json::json!({
        "response": session,
        "client": client_json,
    }))
    .cookies(cookies))
}

pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<VerifyBody>,
) -> Result<Reply> {
    body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sessions").await?;
    let row = require_session(&state, &client.id, &id).await?;
    respond_verification(
        &state,
        &headers,
        &client,
        &row,
        serde_json::json!({
            "status": "unverified",
            "strategy": "first_factor",
            "attempts": null,
            "expire_at": null,
        }),
        cookie.into_iter().collect(),
    )
    .await
}
