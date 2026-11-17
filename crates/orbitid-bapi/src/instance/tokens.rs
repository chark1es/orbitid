use axum::extract::State;
use axum::response::Response;
use orbitid_core::crypto::{random_token, sha256};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::SigningKeyRow;
use orbitid_core::state::AppState;
use orbitid_credentials::keys::rotate_signing_key;
use orbitid_platform::audit::{audit, list_audit_logs, AuditInput, AuditLogFilters};
use orbitid_platform::stats::instance_stats;
use serde_json::json;

use crate::shared::{json_response, to_value, QueryPairs};

use super::settings::TESTING_TOKEN_TTL_MS;

pub(super) async fn rotate_key(State(state): State<AppState>) -> Result<Response> {
    let kid = rotate_signing_key(&state).await?;
    let key: Option<SigningKeyRow> = sqlx::query_as("SELECT * FROM signing_keys WHERE kid = $1")
        .bind(&kid)
        .fetch_optional(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("instance.signing_key.rotated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default")
            .metadata(json!({ "kid": kid })),
    )
    .await;
    Ok(json_response(json!({
        "object": "signing_key",
        "kid": kid,
        "algorithm": key.as_ref().map(|row| row.alg.clone()).unwrap_or_else(|| "RS256".into()),
        "active": key.map(|row| row.active).unwrap_or(true),
    })))
}

pub(super) async fn create_testing_token(State(state): State<AppState>) -> Result<Response> {
    if !state.settings.get().security.testing_tokens_enabled {
        return Err(OrbitError::bad_request(
            error_codes::NOT_ALLOWED_ACCESS,
            "Testing tokens are disabled on this instance.",
        ));
    }
    let token = format!("tt_{}", random_token(32));
    let now_ms = now();
    let expires_at = now_ms + TESTING_TOKEN_TTL_MS;
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, token_hash, \
         expires_at, created_at) VALUES ($1,'testing_token','testing_token','','',$2,$3,$4)",
    )
    .bind(new_id(id_prefix::VERIFICATION))
    .bind(sha256(&token))
    .bind(expires_at)
    .bind(now_ms)
    .execute(&state.pool)
    .await?;
    audit(
        &state,
        AuditInput::new("testing_token.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default"),
    )
    .await;
    Ok(json_response(json!({
        "object": "testing_token",
        "token": token,
        "expires_at": expires_at,
    })))
}

pub(super) async fn audit_logs(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let numeric = |name: &str| -> Option<i64> {
        query
            .raw(name)
            .and_then(|raw| raw.trim().parse::<f64>().ok())
            .filter(|value| !value.is_nan())
            .map(|value| value as i64)
    };
    let result = list_audit_logs(
        &state,
        &AuditLogFilters {
            limit: list.limit,
            offset: list.offset,
            order_by: list.order_by.clone(),
            actor: query
                .raw("actor")
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            action: query
                .raw("action")
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            target_type: query
                .raw("target_type")
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            target_id: query
                .raw("target_id")
                .filter(|v| !v.is_empty())
                .map(str::to_string),
            after: numeric("after"),
            before: numeric("before"),
        },
    )
    .await?;
    Ok(json_response(to_value(result)?))
}

pub(super) async fn stats(State(state): State<AppState>) -> Result<Response> {
    Ok(json_response(to_value(instance_stats(&state).await?)?))
}
