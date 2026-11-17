//! Webhooks: persist events, fan out deliveries, deliver with retries
//! (Svix-compatible signatures). Ported from
//! the retired TypeScript server.

mod delivery;
mod signing;
mod worker;

pub use delivery::{deliver_due, DELIVERY_TIMEOUT_MS};
pub use signing::{
    generate_webhook_secret, sign_webhook, verify_webhook_signature, VerifyOptions,
    WebhookVerificationInput, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS,
};
pub use worker::{WebhookWorker, WEBHOOK_WORKER_INTERVAL_MS};

use orbitid_core::events::WebhookEvent;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{WebhookDeliveryRow, WebhookEndpointRow};
use orbitid_core::resources::{WebhookDeliveryJson, WebhookEndpointJson};
use orbitid_core::state::AppState;
use serde_json::Value;

/// Wire resource for an endpoint (the secret is only included on creation/rotation).
pub fn serialize_webhook_endpoint(
    row: &WebhookEndpointRow,
    with_secret: bool,
) -> WebhookEndpointJson {
    WebhookEndpointJson {
        object: "webhook_endpoint".to_string(),
        id: row.id.clone(),
        url: row.url.clone(),
        description: row.description.clone(),
        event_types: row.event_types.0.clone(),
        disabled: row.disabled,
        secret: if with_secret {
            Some(row.secret.clone())
        } else {
            None
        },
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn serialize_webhook_delivery(
    row: &WebhookDeliveryRow,
    event_type: &str,
) -> WebhookDeliveryJson {
    WebhookDeliveryJson {
        object: "webhook_delivery".to_string(),
        id: row.id.clone(),
        endpoint_id: row.endpoint_id.clone(),
        event_id: row.event_id.clone(),
        event_type: event_type.to_string(),
        status: row.status.clone(),
        attempt: row.attempt,
        response_code: row.response_code,
        response_body: row.response_body.clone(),
        next_attempt_at: row.next_attempt_at,
        created_at: row.created_at,
    }
}

/// Builds the event envelope + pending deliveries for every enabled endpoint
/// subscribed to `event_type`, on the pool in its own implicit transaction.
/// MUST NOT throw: a webhook failure never breaks the mutation that produced
/// the event.
///
/// This is a best-effort write: if the caller's state change has already
/// committed, the event cannot be rolled back with it. Use [`emit_event_on`]
/// with the caller's transaction when the event must be atomic with the change
/// it announces — an event written that way *does* roll back with a rolled-back
/// change.
pub async fn emit_event(state: &AppState, event_type: &str, data: Value) {
    if let Err(error) = try_emit_event(state, event_type, data).await {
        tracing::error!("[webhooks] failed to emit {event_type}: {error}");
    }
}

/// Persists the event on a caller-owned connection, so a mutation and the event
/// that announces it can commit in the same transaction.
pub async fn emit_event_on(
    conn: &mut sqlx::PgConnection,
    event_type: &str,
    data: Value,
) -> orbitid_core::Result<()> {
    write_event(conn, event_type, data).await
}

async fn try_emit_event(
    state: &AppState,
    event_type: &str,
    data: Value,
) -> orbitid_core::Result<()> {
    let mut conn = state.pool.acquire().await?;
    write_event(&mut conn, event_type, data).await
}

async fn write_event(
    conn: &mut sqlx::PgConnection,
    event_type: &str,
    data: Value,
) -> orbitid_core::Result<()> {
    let now = orbitid_core::http::now();
    let event_id = new_id(id_prefix::WEBHOOK_EVENT);
    let envelope = WebhookEvent::new(
        event_id.clone(),
        event_type.to_string(),
        data,
        now,
        "default".to_string(),
    );
    let payload = serde_json::to_value(&envelope)
        .map_err(|error| orbitid_core::OrbitError::internal(error.to_string()))?;
    // Ordinary (not row-level) mapping: an outbox failure is never a reason to
    // skip a user inside the enrollment worker's per-user savepoint.
    sqlx::query(
        "INSERT INTO webhook_events (id, type, payload, created_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&event_id)
    .bind(event_type)
    .bind(sqlx::types::Json(payload))
    .bind(now)
    .execute(&mut *conn)
    .await?;

    let endpoints = sqlx::query_as::<_, WebhookEndpointRow>(
        "SELECT * FROM webhook_endpoints WHERE disabled = false",
    )
    .fetch_all(&mut *conn)
    .await?;
    for endpoint in endpoints {
        let types = &endpoint.event_types.0;
        if !types.is_empty() && !types.iter().any(|value| value == event_type) {
            continue;
        }
        sqlx::query(
            "INSERT INTO webhook_deliveries \
             (id, endpoint_id, event_id, status, attempt, next_attempt_at, created_at) \
             VALUES ($1, $2, $3, 'pending', 0, $4, $4)",
        )
        .bind(new_id(id_prefix::DELIVERY))
        .bind(&endpoint.id)
        .bind(&event_id)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}
