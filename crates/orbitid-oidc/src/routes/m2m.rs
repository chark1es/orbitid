//! `/v1/m2m/*` (backend secret-key guarded) plus machine-secret token minting,
//! ported from `modules/m2m.ts` and `modules/oidc/machine.ts`.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Map, Value};

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::{OrbitJson, PaginationQuery};
use orbitid_core::state::AppState;

use crate::services::m2m::{
    add_machine_scope, authenticate_machine_secret, create_machine, delete_machine,
    issue_machine_token, list_machine_tokens, list_machines, require_machine,
    require_machine_token, revoke_machine_token, rotate_machine_secret, serialize_machine,
    serialize_machine_token, update_machine, verify_machine_token, CreateMachineInput,
    IssueTokenInput, TokenFormat, UpdateMachineInput,
};
use crate::web::query_map;

/// Backend routes (`/v1/m2m`), without the secret-key guard.
pub fn backend_router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/m2m/machines",
            get(list_machines_route).post(create_machine_route),
        )
        .route(
            "/v1/m2m/machines/{id}",
            get(machine_detail)
                .patch(update_machine_route)
                .delete(delete_machine_route),
        )
        .route("/v1/m2m/machines/{id}/secret/rotate", post(rotate_secret))
        .route("/v1/m2m/machines/{id}/scopes", post(add_scope))
        .route(
            "/v1/m2m/tokens",
            get(list_tokens_route).post(issue_token_route),
        )
        .route("/v1/m2m/tokens/verify", post(verify_token_route))
        .route("/v1/m2m/tokens/{id}/revoke", post(revoke_token_route))
}

pub(super) fn opt_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    let value = Option::<Value>::deserialize(deserializer)?;
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected an integer")),
        Some(Value::String(raw)) => raw
            .parse::<i64>()
            .map(Some)
            .map_err(|_| serde::de::Error::custom("expected an integer")),
        Some(_) => Err(serde::de::Error::custom("expected an integer")),
    }
}

fn unprocessable(param: &str, message: &str) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_VALUE_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

fn validate_machine_name(name: &str) -> Result<(), OrbitError> {
    if name.is_empty() || name.chars().count() > 256 {
        return Err(unprocessable(
            "name",
            "name must be between 1 and 256 characters",
        ));
    }
    Ok(())
}

fn validate_scoped(values: Option<&Vec<String>>) -> Result<(), OrbitError> {
    let Some(values) = values else { return Ok(()) };
    if values.len() > 100 || values.iter().any(|value| value.is_empty()) {
        return Err(unprocessable(
            "scoped_machines",
            "scoped_machines must contain at most 100 non-empty strings",
        ));
    }
    Ok(())
}

fn validate_ttl(ttl: Option<i64>) -> Result<(), OrbitError> {
    if let Some(ttl) = ttl {
        if ttl <= 0 || ttl > 60 * 60 * 24 * 365 {
            return Err(unprocessable(
                "default_token_ttl",
                "default_token_ttl must be a positive duration of at most one year",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
struct CreateMachineBody {
    name: String,
    #[serde(default)]
    scoped_machines: Option<Vec<String>>,
    #[serde(default)]
    default_token_ttl: Option<i64>,
}

async fn create_machine_route(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateMachineBody>,
) -> Result<Response, OrbitError> {
    validate_machine_name(&body.name)?;
    validate_scoped(body.scoped_machines.as_ref())?;
    validate_ttl(body.default_token_ttl)?;
    let (row, secret) = create_machine(
        &state,
        CreateMachineInput {
            name: body.name,
            scoped_machines: body.scoped_machines,
            default_token_ttl: body.default_token_ttl,
        },
    )
    .await?;
    let mut value = serde_json::to_value(serialize_machine(&row))
        .map_err(|error| OrbitError::internal(error.to_string()))?;
    if let Value::Object(map) = &mut value {
        map.insert("secret".into(), Value::String(secret));
    }
    Ok((StatusCode::CREATED, Json(value)).into_response())
}

async fn list_machines_route(
    State(state): State<AppState>,
    page: PaginationQuery,
) -> Result<Response, OrbitError> {
    let (rows, total) = list_machines(&state, page.limit, page.offset).await?;
    Ok(Json(json!({
        "data": rows.iter().map(serialize_machine).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

async fn machine_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_machine(&state, &id).await?;
    Ok(Json(serialize_machine(&row)).into_response())
}

#[derive(Debug, Default, Deserialize)]
struct PatchMachineBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    scoped_machines: Option<Vec<String>>,
    #[serde(default)]
    default_token_ttl: Option<i64>,
}

async fn update_machine_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PatchMachineBody>,
) -> Result<Response, OrbitError> {
    let row = require_machine(&state, &id).await?;
    if body.name.is_none() && body.scoped_machines.is_none() && body.default_token_ttl.is_none() {
        return Err(unprocessable("body", "at least one field is required"));
    }
    if let Some(name) = &body.name {
        validate_machine_name(name)?;
    }
    validate_scoped(body.scoped_machines.as_ref())?;
    validate_ttl(body.default_token_ttl)?;
    let updated = update_machine(
        &state,
        &row,
        UpdateMachineInput {
            name: body.name,
            scoped_machines: body.scoped_machines,
            default_token_ttl: body.default_token_ttl,
        },
    )
    .await?;
    Ok(Json(serialize_machine(&updated)).into_response())
}

async fn delete_machine_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_machine(&state, &id).await?;
    delete_machine(&state, &row).await?;
    Ok(Json(json!({ "object": "machine", "id": row.id, "deleted": true })).into_response())
}

async fn rotate_secret(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_machine(&state, &id).await?;
    let (updated, secret) = rotate_machine_secret(&state, &row).await?;
    let mut value = serde_json::to_value(serialize_machine(&updated))
        .map_err(|error| OrbitError::internal(error.to_string()))?;
    if let Value::Object(map) = &mut value {
        map.insert("secret".into(), Value::String(secret));
    }
    Ok(Json(value).into_response())
}

#[derive(Debug, Default, Deserialize)]
struct AddScopeBody {
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    scoped_machine_id: Option<String>,
}

async fn add_scope(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<AddScopeBody>,
) -> Result<Response, OrbitError> {
    let row = require_machine(&state, &id).await?;
    let Some(scoped_id) = body.scoped_machine_id.or(body.machine_id) else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "machine_id is missing",
        )
        .with_meta(json!({ "param_name": "machine_id" })));
    };
    let updated = add_machine_scope(&state, &row, &scoped_id).await?;
    Ok(Json(serialize_machine(&updated)).into_response())
}

pub(super) fn parse_claims(value: Option<Value>) -> Result<Option<Map<String, Value>>, OrbitError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(Value::String(raw)) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .map(Some)
            .ok_or_else(|| {
                OrbitError::bad_request(
                    error_codes::REQUEST_BODY_INVALID,
                    "claims must be a JSON object",
                )
            }),
        Some(_) => Err(OrbitError::bad_request(
            error_codes::REQUEST_BODY_INVALID,
            "claims must be a JSON object",
        )),
    }
}

pub(super) fn token_format(value: Option<&str>) -> Result<TokenFormat, OrbitError> {
    match value {
        None | Some("opaque") => Ok(TokenFormat::Opaque),
        Some("jwt") => Ok(TokenFormat::Jwt),
        Some(_) => Err(unprocessable(
            "token_format",
            "token_format must be opaque or jwt",
        )),
    }
}

#[derive(Debug, Default, Deserialize)]
struct IssueTokenBody {
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    machine_secret: Option<String>,
    #[serde(default, deserialize_with = "opt_i64")]
    seconds_until_expiration: Option<i64>,
    #[serde(default)]
    claims: Option<Value>,
    #[serde(default)]
    token_format: Option<String>,
}

async fn resolve_token_machine(
    state: &AppState,
    headers: &HeaderMap,
    body: &IssueTokenBody,
) -> Result<orbitid_core::models::MachineRow, OrbitError> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    let invalid =
        || OrbitError::unauthorized(error_codes::AUTHORIZATION_INVALID, "Invalid machine secret");
    if bearer.starts_with("mk_") {
        let Some(machine) = authenticate_machine_secret(state, &bearer).await? else {
            return Err(invalid());
        };
        if body
            .machine_id
            .as_deref()
            .is_some_and(|id| id != machine.id)
        {
            return Err(OrbitError::unauthorized(
                error_codes::AUTHORIZATION_INVALID,
                "Machine secret does not match machine_id",
            ));
        }
        return Ok(machine);
    }
    if let Some(secret) = body
        .machine_secret
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let Some(machine) = authenticate_machine_secret(state, secret).await? else {
            return Err(invalid());
        };
        if body
            .machine_id
            .as_deref()
            .is_some_and(|id| id != machine.id)
        {
            return Err(OrbitError::unauthorized(
                error_codes::AUTHORIZATION_INVALID,
                "Machine secret does not match machine_id",
            ));
        }
        return Ok(machine);
    }
    let Some(machine_id) = body.machine_id.as_deref() else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "machine_id is missing",
        )
        .with_meta(json!({ "param_name": "machine_id" })));
    };
    require_machine(state, machine_id).await
}

async fn issue_token_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<IssueTokenBody>,
) -> Result<Response, OrbitError> {
    let machine = resolve_token_machine(&state, &headers, &body).await?;
    let format = token_format(body.token_format.as_deref())?;
    let claims = parse_claims(body.claims.clone())?;
    let (row, token) = issue_machine_token(
        &state,
        &machine,
        IssueTokenInput {
            seconds_until_expiration: body.seconds_until_expiration,
            claims,
            token_format: Some(format),
        },
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(serialize_machine_token(&row, Some(&token))),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
struct VerifyBody {
    token: String,
}

async fn verify_token_route(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<VerifyBody>,
) -> Result<Response, OrbitError> {
    let (row, machine) = verify_machine_token(&state, &body.token).await?;
    let mut value = serde_json::to_value(serialize_machine_token(&row, None))
        .map_err(|error| OrbitError::internal(error.to_string()))?;
    if let Value::Object(map) = &mut value {
        map.insert("valid".into(), Value::Bool(true));
        map.insert(
            "machine".into(),
            serde_json::to_value(serialize_machine(&machine))
                .map_err(|error| OrbitError::internal(error.to_string()))?,
        );
    }
    Ok(Json(value).into_response())
}

async fn list_tokens_route(
    State(state): State<AppState>,
    page: PaginationQuery,
    uri: Uri,
) -> Result<Response, OrbitError> {
    let query = query_map(uri.query());
    let machine_id = query
        .get("machine_id")
        .cloned()
        .filter(|value| !value.is_empty());
    let (rows, total) = list_machine_tokens(
        &state,
        machine_id.as_deref(),
        page.limit,
        page.offset,
        page.order_by.as_deref(),
    )
    .await?;
    Ok(Json(json!({
        "data": rows.iter().map(|row| serialize_machine_token(row, None)).collect::<Vec<_>>(),
        "total_count": total,
    }))
    .into_response())
}

async fn revoke_token_route(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, OrbitError> {
    let row = require_machine_token(&state, &id).await?;
    Ok(Json(serialize_machine_token(
        &revoke_machine_token(&state, &row).await?,
        None,
    ))
    .into_response())
}
