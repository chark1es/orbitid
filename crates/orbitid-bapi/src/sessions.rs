//! Backend API sessions and clients.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use orbitid_core::crypto::sha256;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::{ClientRow, SessionRow};
use orbitid_core::resources::ClientJson;
use orbitid_core::state::AppState;
use orbitid_identity::serializers::{
    serialize_session, serialize_sessions, SessionSerializeOptions,
};
use orbitid_identity::sessions::end_session;
use orbitid_identity::tokens::{sign_session_token, verify_session_token, SignSessionTokenOptions};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::shared::{
    fetch_all, fetch_count, json_response, order_clause, paginated, to_value, Bind, QueryPairs,
    Where,
};

const SESSION_ORDER_COLUMNS: &[(&str, &str)] = &[
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
    ("last_active_at", "last_active_at"),
    ("expire_at", "expire_at"),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/sessions", get(list))
        .route("/v1/sessions/{id}", get(read))
        .route("/v1/sessions/{id}/revoke", post(revoke))
        .route("/v1/sessions/{id}/verify", post(refuse_verify))
        .route("/v1/sessions/{id}/tokens", post(mint))
        .route("/v1/sessions/{id}/tokens/{template}", post(mint_template))
        .route("/v1/clients/{id}", get(read_client))
        .route("/v1/clients/verify", post(verify_client))
}

async fn session_or_throw(state: &AppState, id: &str) -> Result<SessionRow> {
    sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found.")
                .with_meta(json!({ "param_name": "session_id" }))
        })
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut filter = Where::new();
    for (param, column) in [
        ("user_id", "user_id"),
        ("client_id", "client_id"),
        ("status", "status"),
    ] {
        if let Some(value) = query.raw(param) {
            filter.equal_text(column, value);
        }
    }
    if query.raw("expired") == Some("false") {
        filter.after("expire_at", now());
    }
    let order = order_clause(
        list.order_by.as_deref(),
        SESSION_ORDER_COLUMNS,
        "-created_at",
    );
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM sessions{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<SessionRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM sessions{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let data = serialize_sessions(&state, &rows, true, &HashMap::new()).await?;
    Ok(json_response(paginated(to_value(data)?, total)))
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = session_or_throw(&state, &id).await?;
    let json = serialize_session(
        &state,
        &row,
        SessionSerializeOptions {
            with_user: true,
            last_token: None,
        },
    )
    .await?;
    Ok(json_response(to_value(json)?))
}

async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = session_or_throw(&state, &id).await?;
    let updated = end_session(&state, &row, "revoked").await?;
    audit(
        &state,
        AuditInput::new("session.revoked")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("session")
            .target_id(row.id.clone())
            .metadata(json!({ "user_id": row.user_id })),
    )
    .await;
    let json = serialize_session(
        &state,
        &updated,
        SessionSerializeOptions {
            with_user: true,
            last_token: None,
        },
    )
    .await?;
    Ok(json_response(to_value(json)?))
}

async fn refuse_verify(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    session_or_throw(&state, &id).await?;
    Err(OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        "The Backend API cannot mark a session as verified: an operator must not assert a factor the user never presented. \
         The browser completes reverification through POST /v1/client/sessions/:id/verify/prepare_* and /attempt_*.",
    ))
}

async fn mint(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    mint_token(state, id, None, headers).await
}

async fn mint_template(
    State(state): State<AppState>,
    Path((id, template)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response> {
    mint_token(state, id, Some(template), headers).await
}

async fn mint_token(
    state: AppState,
    id: String,
    template: Option<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let row = session_or_throw(&state, &id).await?;
    let presented = headers
        .get("x-orbitid-session-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or("");
    if presented.is_empty() {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Minting a session token requires that session's own token in the X-OrbitID-Session-Token header. \
             An operator credential alone must not become a user's session. The browser refreshes its token from \
             POST /v1/client/sessions/:id/tokens, authenticated by its own client cookie.",
        ));
    }
    let claims = verify_session_token(&state, presented, None)
        .await
        .map_err(|_| {
            OrbitError::forbidden(
                error_codes::NOT_ALLOWED_ACCESS,
                "The presented session token is not valid for this session.",
            )
        })?;
    if claims.sid != row.id {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "The presented session token does not belong to this session.",
        ));
    }
    if row.status != "active" {
        return Err(OrbitError::bad_request(
            error_codes::AUTHENTICATION_INVALID,
            "Session is not active.",
        ));
    }
    if let Some(template) = &template {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM jwt_templates WHERE name = $1")
                .bind(template)
                .fetch_optional(&state.pool)
                .await?;
        if existing.is_none() {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "JWT template not found.",
            )
            .with_meta(json!({ "param_name": "template" })));
        }
    }
    let jwt = sign_session_token(
        &state,
        &row.id,
        SignSessionTokenOptions {
            template: template.clone(),
            azp: None,
        },
    )
    .await?;
    Ok(json_response(json!({ "object": "token", "jwt": jwt })))
}

async fn serialize_client(state: &AppState, client: &ClientRow) -> Result<ClientJson> {
    let sessions: Vec<SessionRow> =
        sqlx::query_as("SELECT * FROM sessions WHERE client_id = $1 ORDER BY created_at DESC")
            .bind(&client.id)
            .fetch_all(&state.pool)
            .await?;
    let sessions = serialize_sessions(state, &sessions, true, &HashMap::new()).await?;
    Ok(ClientJson {
        object: "client".into(),
        id: client.id.clone(),
        sessions,
        sign_in: None,
        sign_up: None,
        last_active_session_id: client.last_active_session_id.clone(),
        cookie_expires_at: None,
        created_at: client.created_at,
        updated_at: client.updated_at,
    })
}

async fn read_client(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let client: Option<ClientRow> = sqlx::query_as("SELECT * FROM clients WHERE id = $1")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(client) = client else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Client not found.",
        ));
    };
    Ok(json_response(to_value(
        serialize_client(&state, &client).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct VerifyClientBody {
    token: String,
}

async fn verify_client(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<VerifyClientBody>,
) -> Result<Response> {
    let client: Option<ClientRow> = sqlx::query_as("SELECT * FROM clients WHERE token_hash = $1")
        .bind(sha256(&body.token))
        .fetch_optional(&state.pool)
        .await?;
    let Some(client) = client else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Client not found.",
        ));
    };
    Ok(json_response(to_value(
        serialize_client(&state, &client).await?,
    )?))
}
