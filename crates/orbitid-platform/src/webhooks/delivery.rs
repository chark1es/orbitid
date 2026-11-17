//! Delivery of due webhook events: one attempt per row, with the documented
//! retry backoff. Row claiming uses `FOR UPDATE SKIP LOCKED`, so several replicas
//! can run the worker at once without double-sending.
//!
//! A claim writes a fresh `next_attempt_at` value (now + lease) that doubles as
//! this attempt's ownership token: the completion update is conditional on that
//! exact value, so a worker whose lease expired while it was delivering cannot
//! overwrite the result another replica recorded after re-claiming the row.
//! Rows are claimed shortly before they are sent, in bounded parallel batches,
//! so one slow endpoint cannot let the leases of its neighbours expire.

use orbitid_core::error::Result;
use orbitid_core::models::{WebhookDeliveryRow, WebhookEndpointRow, WebhookEventRow};
use orbitid_core::safe_fetch::{safe_fetch, SafeFetchOptions};
use orbitid_core::state::AppState;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, USER_AGENT};
use tokio::task::JoinSet;

use super::signing::{sign_webhook, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS};

pub const DELIVERY_TIMEOUT_MS: u64 = 10_000;
/// While an attempt is in flight the row is parked this far in the future so a
/// second worker cannot double-send. Comfortably longer than a delivery
/// (`DELIVERY_TIMEOUT_MS`) plus the batch scheduling around it.
const CLAIM_WINDOW_MS: i64 = 60_000;
/// How many deliveries one worker sends at the same time. A batch is claimed
/// immediately before it is sent, so a claim window only has to cover one
/// timeout, never the whole queue.
const MAX_CONCURRENCY: i64 = 8;
const RESPONSE_BODY_LIMIT: usize = 2048;

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Delivers up to `limit` due pending deliveries, in parallel batches. Returns
/// the number of deliveries attempted.
pub async fn deliver_due(state: &AppState, limit: Option<i64>) -> Result<usize> {
    let limit = limit.unwrap_or(20).max(0);
    let mut attempted = 0usize;
    while (attempted as i64) < limit {
        let batch_size = (limit - attempted as i64).min(MAX_CONCURRENCY);
        let now = orbitid_core::http::now();
        let claimed = claim(state, batch_size, now, now + CLAIM_WINDOW_MS).await?;
        if claimed.is_empty() {
            break;
        }
        let full_batch = (claimed.len() as i64) == batch_size;
        let batch_attempted = deliver_batch(state, claimed).await?;
        attempted += batch_attempted;
        if !full_batch {
            break;
        }
    }
    Ok(attempted)
}

/// Claims due rows into this worker's lease and returns them with the token in
/// `next_attempt_at`.
async fn claim(
    state: &AppState,
    limit: i64,
    now: i64,
    claim_until: i64,
) -> Result<Vec<WebhookDeliveryRow>> {
    let rows = sqlx::query_as::<_, WebhookDeliveryRow>(
        "WITH candidate AS ( \
             SELECT d.id FROM webhook_deliveries d \
             JOIN webhook_endpoints e ON e.id = d.endpoint_id \
             WHERE d.status = 'pending' AND d.next_attempt_at IS NOT NULL \
               AND d.next_attempt_at <= $1 AND e.disabled = false \
             ORDER BY d.next_attempt_at ASC, d.id ASC \
             LIMIT $2 \
             FOR UPDATE OF d SKIP LOCKED \
         ) \
         UPDATE webhook_deliveries d SET next_attempt_at = $3 \
         FROM candidate c WHERE d.id = c.id \
         RETURNING d.id, d.endpoint_id, d.event_id, d.status, d.attempt, \
                   d.response_code, d.response_body, d.next_attempt_at, d.created_at",
    )
    .bind(now)
    .bind(limit)
    .bind(claim_until)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows)
}

/// Delivers one claimed batch with bounded concurrency; one hanging endpoint
/// only delays its own row, and every completion is scoped to the claim token.
async fn deliver_batch(state: &AppState, claimed: Vec<WebhookDeliveryRow>) -> Result<usize> {
    let mut tasks = JoinSet::new();
    for delivery in claimed {
        let state = state.clone();
        tasks.spawn(async move { attempt_delivery(&state, delivery).await });
    }
    let mut attempted = 0usize;
    let mut first_error = None;
    while let Some(joined) = tasks.join_next().await {
        match joined {
            Ok(Ok(sent)) => attempted += usize::from(sent),
            Ok(Err(error)) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
            Err(error) => {
                tracing::warn!("[webhooks] delivery task failed: {error}");
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(attempted),
    }
}

async fn attempt_delivery(state: &AppState, delivery: WebhookDeliveryRow) -> Result<bool> {
    let Some(event) =
        sqlx::query_as::<_, WebhookEventRow>("SELECT * FROM webhook_events WHERE id = $1")
            .bind(&delivery.event_id)
            .fetch_optional(&state.pool)
            .await?
    else {
        return Ok(false);
    };
    let Some(endpoint) =
        sqlx::query_as::<_, WebhookEndpointRow>("SELECT * FROM webhook_endpoints WHERE id = $1")
            .bind(&delivery.endpoint_id)
            .fetch_optional(&state.pool)
            .await?
    else {
        return Ok(false);
    };
    let attempt = delivery.attempt + 1;
    let timestamp = orbitid_core::http::now() / 1000;
    let body = serde_json::to_string(&event.payload.0).unwrap_or_else(|_| "{}".to_string());
    let signature = sign_webhook(&endpoint.secret, &event.id, timestamp, &body);

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static("OrbitID-Webhooks/1.0"));
    if let Ok(value) = HeaderValue::from_str(&event.id) {
        headers.insert("svix-id", value);
    }
    if let Ok(value) = HeaderValue::from_str(&timestamp.to_string()) {
        headers.insert("svix-timestamp", value);
    }
    if let Ok(value) = HeaderValue::from_str(&signature) {
        headers.insert("svix-signature", value);
    }

    let options = SafeFetchOptions {
        method: Some("POST".to_string()),
        headers,
        body: Some(body.into_bytes()),
        timeout_ms: Some(DELIVERY_TIMEOUT_MS),
        max_redirects: None,
        max_bytes: Some(RESPONSE_BODY_LIMIT * 4),
    };

    let (response_code, response_body, ok) =
        match safe_fetch(Some(state), &endpoint.url, options).await {
            Ok(response) => {
                let ok = response.ok();
                (Some(i64::from(response.status)), response.body, ok)
            }
            Err(error) => (None, format!("Error: {}", error.message), false),
        };

    let retry_delay = WEBHOOK_RETRY_DELAYS_MS
        .get(usize::try_from(attempt - 1).unwrap_or(0))
        .copied();
    let failed = !ok && attempt >= WEBHOOK_MAX_ATTEMPTS;
    let status = if ok {
        "success"
    } else if failed {
        "failed"
    } else {
        "pending"
    };
    let next_attempt_at = if ok || failed {
        None
    } else {
        Some(
            orbitid_core::http::now()
                + retry_delay.unwrap_or(WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.len() - 1]),
        )
    };
    // Only the worker that still owns the lease may record the outcome: a
    // re-claimed row has a different `next_attempt_at`, so this matches nothing
    // and the newer result stands.
    let updated = sqlx::query(
        "UPDATE webhook_deliveries SET attempt = $1, response_code = $2, response_body = $3, \
         status = $4, next_attempt_at = $5 WHERE id = $6 AND next_attempt_at = $7",
    )
    .bind(attempt)
    .bind(response_code)
    .bind(truncate(&response_body, RESPONSE_BODY_LIMIT))
    .bind(status)
    .bind(next_attempt_at)
    .bind(&delivery.id)
    .bind(delivery.next_attempt_at)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        tracing::warn!(
            delivery_id = %delivery.id,
            "[webhooks] delivery lease expired while sending; a newer worker owns the result"
        );
    }
    Ok(true)
}
