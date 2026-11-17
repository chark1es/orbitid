//! Backend API webhooks (`/v1/webhooks/*`), ported from `modules/webhooks-api.ts`.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::events::WEBHOOK_EVENT_TYPES;
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{WebhookDeliveryRow, WebhookEndpointRow};
use orbitid_core::safe_fetch::assert_public_url;
use orbitid_core::state::AppState;
use orbitid_platform::audit::{audit, AuditInput};
use orbitid_platform::webhooks::{
    deliver_due, generate_webhook_secret, serialize_webhook_delivery, serialize_webhook_endpoint,
};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{
    deleted_object, deserialize_opt_bool, fetch_all, fetch_count, json_response, order_clause,
    paginated, to_value, Bind, QueryPairs,
};

const DELIVERY_ORDER_COLUMNS: &[(&str, &str)] = &[("created_at", "created_at")];
const ENDPOINT_ORDER_COLUMNS: &[(&str, &str)] =
    &[("created_at", "created_at"), ("updated_at", "updated_at")];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/webhooks/event_types", get(event_types))
        .route("/v1/webhooks/endpoints", get(list).post(create))
        .route(
            "/v1/webhooks/endpoints/{id}",
            get(read).patch(update).delete(remove),
        )
        .route("/v1/webhooks/endpoints/{id}/secret", get(secret))
        .route("/v1/webhooks/endpoints/{id}/deliveries", get(deliveries))
        .route("/v1/webhooks/deliveries/{id}/retry", post(retry))
        .route("/v1/webhooks/endpoints/{id}/test", post(test))
}

async fn event_types() -> Response {
    json_response(json!(WEBHOOK_EVENT_TYPES))
}

async fn endpoint_or_throw(state: &AppState, id: &str) -> Result<WebhookEndpointRow> {
    sqlx::query_as::<_, WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Webhook endpoint not found.",
            )
        })
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let order = order_clause(
        list.order_by.as_deref(),
        ENDPOINT_ORDER_COLUMNS,
        "-created_at",
    );
    let rows: Vec<WebhookEndpointRow> = fetch_all(
        &state.pool,
        &format!("SELECT * FROM webhook_endpoints ORDER BY {order} LIMIT $1 OFFSET $2"),
        &[Bind::Int(list.limit), Bind::Int(list.offset)],
    )
    .await?;
    let total = fetch_count(&state.pool, "SELECT count(*) FROM webhook_endpoints", &[]).await?;
    let data = rows
        .iter()
        .map(|row| serialize_webhook_endpoint(row, false))
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

fn validate_url(raw: &str, param: &str) -> Result<String> {
    match url::Url::parse(raw) {
        Ok(url) if url.scheme() == "http" || url.scheme() == "https" => Ok(raw.to_string()),
        _ => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must be a URL"),
        )
        .with_meta(json!({ "param_name": param }))),
    }
}

fn validate_event_types(types: &[String]) -> Result<()> {
    for event_type in types {
        if !WEBHOOK_EVENT_TYPES.contains(&event_type.as_str()) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                format!("{event_type} is not a webhook event type"),
            )
            .with_meta(json!({ "param_name": "event_types" })));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    event_types: Option<Vec<String>>,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let url = validate_url(&body.url, "url")?;
    let description = body.description.unwrap_or_default();
    if description.chars().count() > 500 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "description must be at most 500 characters",
        )
        .with_meta(json!({ "param_name": "description" })));
    }
    let event_types = body.event_types.unwrap_or_default();
    validate_event_types(&event_types)?;
    assert_public_url(Some(&state), &url, "url").await?;
    let now_ms = now();
    let row: WebhookEndpointRow = sqlx::query_as(
        "INSERT INTO webhook_endpoints (id, url, description, event_types, secret, disabled, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,false,$6,$6) RETURNING *",
    )
    .bind(new_id(id_prefix::WEBHOOK))
    .bind(&url)
    .bind(&description)
    .bind(sqlx::types::Json(event_types))
    .bind(generate_webhook_secret())
    .bind(now_ms)
    .fetch_one(&state.pool)
    .await?;
    audit(
        &state,
        AuditInput::new("webhook_endpoint.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("webhook_endpoint")
            .target_id(row.id.clone())
            .metadata(json!({ "url": row.url })),
    )
    .await;
    Ok(json_response(to_value(serialize_webhook_endpoint(
        &row, true,
    ))?))
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = endpoint_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_webhook_endpoint(
        &row, false,
    ))?))
}

async fn secret(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = endpoint_or_throw(&state, &id).await?;
    Ok(json_response(json!({
        "object": "webhook_endpoint_secret",
        "id": row.id,
        "secret": row.secret,
    })))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    url: Option<String>,
    description: Option<String>,
    event_types: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    disabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    rotate_secret: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let existing = endpoint_or_throw(&state, &id).await?;
    let url = match &body.url {
        Some(url) => {
            let url = validate_url(url, "url")?;
            assert_public_url(Some(&state), &url, "url").await?;
            Some(url)
        }
        None => None,
    };
    if let Some(description) = &body.description {
        if description.chars().count() > 500 {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "description must be at most 500 characters",
            )
            .with_meta(json!({ "param_name": "description" })));
        }
    }
    if let Some(types) = &body.event_types {
        validate_event_types(types)?;
    }
    sqlx::query(
        "UPDATE webhook_endpoints SET url = $1, description = $2, event_types = $3, \
         disabled = $4, secret = $5, updated_at = $6 WHERE id = $7",
    )
    .bind(url.as_deref().unwrap_or(&existing.url))
    .bind(body.description.as_deref().unwrap_or(&existing.description))
    .bind(sqlx::types::Json(
        body.event_types
            .clone()
            .unwrap_or_else(|| existing.event_types.0.clone()),
    ))
    .bind(body.disabled.unwrap_or(existing.disabled))
    .bind(if body.rotate_secret == Some(true) {
        generate_webhook_secret()
    } else {
        existing.secret.clone()
    })
    .bind(now())
    .bind(&existing.id)
    .execute(&state.pool)
    .await?;
    let updated = endpoint_or_throw(&state, &existing.id).await?;
    audit(
        &state,
        AuditInput::new("webhook_endpoint.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("webhook_endpoint")
            .target_id(updated.id.clone()),
    )
    .await;
    Ok(json_response(to_value(serialize_webhook_endpoint(
        &updated,
        body.rotate_secret == Some(true),
    ))?))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let existing = endpoint_or_throw(&state, &id).await?;
    sqlx::query("DELETE FROM webhook_endpoints WHERE id = $1")
        .bind(&existing.id)
        .execute(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("webhook_endpoint.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("webhook_endpoint")
            .target_id(existing.id.clone())
            .metadata(json!({ "url": existing.url })),
    )
    .await;
    Ok(json_response(deleted_object(
        "webhook_endpoint",
        &existing.id,
    )))
}

async fn delivery_json(
    state: &AppState,
    rows: &[WebhookDeliveryRow],
) -> Result<Vec<serde_json::Value>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|row| row.event_id.clone()).collect();
    let events: Vec<(String, String)> =
        sqlx::query_as("SELECT id, type FROM webhook_events WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await?;
    let by_id: std::collections::HashMap<String, String> = events.into_iter().collect();
    rows.iter()
        .map(|row| {
            to_value(serialize_webhook_delivery(
                row,
                by_id.get(&row.event_id).map(String::as_str).unwrap_or(""),
            ))
        })
        .collect()
}

async fn deliveries(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let endpoint = endpoint_or_throw(&state, &id).await?;
    let list = query.list()?;
    let mut filter = crate::shared::Where::new();
    filter.equal_text("endpoint_id", &endpoint.id);
    if let Some(status) = query.raw("status") {
        filter.equal_text("status", status);
    }
    let order = order_clause(
        list.order_by.as_deref(),
        DELIVERY_ORDER_COLUMNS,
        "-created_at",
    );
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM webhook_deliveries{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<WebhookDeliveryRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM webhook_deliveries{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    Ok(json_response(paginated(
        serde_json::Value::Array(delivery_json(&state, &rows).await?),
        total,
    )))
}

async fn retry(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row: Option<WebhookDeliveryRow> =
        sqlx::query_as("SELECT * FROM webhook_deliveries WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Webhook delivery not found.",
        ));
    };
    sqlx::query(
        "UPDATE webhook_deliveries SET status = 'pending', attempt = 0, next_attempt_at = $1, \
         response_code = NULL, response_body = NULL WHERE id = $2",
    )
    .bind(now())
    .bind(&row.id)
    .execute(&state.pool)
    .await?;
    audit(
        &state,
        AuditInput::new("webhook_delivery.retried")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("webhook_delivery")
            .target_id(row.id.clone()),
    )
    .await;
    let updated: WebhookDeliveryRow =
        sqlx::query_as("SELECT * FROM webhook_deliveries WHERE id = $1")
            .bind(&row.id)
            .fetch_one(&state.pool)
            .await?;
    let json = delivery_json(&state, std::slice::from_ref(&updated)).await?;
    Ok(json_response(
        json.into_iter().next().unwrap_or(serde_json::Value::Null),
    ))
}

async fn test(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let endpoint = endpoint_or_throw(&state, &id).await?;
    let now_ms = now();
    let event_id = new_id(id_prefix::WEBHOOK_EVENT);
    let event = json!({
        "id": event_id,
        "object": "event",
        "type": "user.created",
        "data": { "object": "webhook_endpoint", "id": endpoint.id, "url": endpoint.url, "test": true },
        "timestamp": now_ms,
        "instance_id": "default",
    });
    // The test event and its delivery row commit together; delivery itself is
    // the worker's post-commit job.
    let delivery = {
        let mut tx = state.pool.begin().await?;
        sqlx::query(
            "INSERT INTO webhook_events (id, type, payload, created_at) \
             VALUES ($1,'user.created',$2,$3)",
        )
        .bind(&event_id)
        .bind(sqlx::types::Json(event))
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        let delivery: WebhookDeliveryRow = sqlx::query_as(
            "INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempt, \
             next_attempt_at, created_at) VALUES ($1,$2,$3,'pending',0,$4,$4) RETURNING *",
        )
        .bind(new_id(id_prefix::DELIVERY))
        .bind(&endpoint.id)
        .bind(&event_id)
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        delivery
    };
    deliver_due(&state, None).await?;
    let updated: WebhookDeliveryRow =
        sqlx::query_as("SELECT * FROM webhook_deliveries WHERE id = $1")
            .bind(&delivery.id)
            .fetch_one(&state.pool)
            .await?;
    let json = delivery_json(&state, std::slice::from_ref(&updated)).await?;
    Ok(json_response(
        json.into_iter().next().unwrap_or(serde_json::Value::Null),
    ))
}
