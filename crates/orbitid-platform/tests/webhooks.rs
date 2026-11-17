//! Ported webhook delivery/signing tests from `test/admin/webhooks.test.ts`
//! (service-level parts).

mod support;

use orbitid_core::models::WebhookDeliveryRow;
use orbitid_core::testing::test_state;
use orbitid_core::AppState;
use orbitid_platform::webhooks::{
    deliver_due, emit_event, emit_event_on, serialize_webhook_delivery, serialize_webhook_endpoint,
    verify_webhook_signature, VerifyOptions, WebhookVerificationInput, WebhookWorker,
};
use serde_json::json;
use support::start_fake_receiver;

async fn insert_endpoint(
    state: &AppState,
    id: &str,
    url: &str,
    event_types: &[&str],
    disabled: bool,
) -> String {
    let secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw".to_string();
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO webhook_endpoints \
         (id, url, description, event_types, secret, disabled, created_at, updated_at) \
         VALUES ($1, $2, '', $3, $4, $5, $6, $6)",
    )
    .bind(id)
    .bind(url)
    .bind(sqlx::types::Json(
        event_types
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>(),
    ))
    .bind(&secret)
    .bind(disabled)
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("endpoint");
    secret
}

async fn deliveries(state: &AppState) -> Vec<WebhookDeliveryRow> {
    sqlx::query_as::<_, WebhookDeliveryRow>(
        "SELECT * FROM webhook_deliveries ORDER BY created_at, id",
    )
    .fetch_all(&state.pool)
    .await
    .expect("deliveries")
}

async fn force_due(state: &AppState, id: &str) {
    sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now())
        .bind(id)
        .execute(&state.pool)
        .await
        .expect("force due");
}

#[tokio::test]
async fn deliveries_carry_verifiable_headers_and_record_the_response() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    let secret = insert_endpoint(&ctx.state, "we_test", &receiver.url, &[], false).await;

    emit_event(
        &ctx.state,
        "user.created",
        json!({ "object": "user", "id": "user_1" }),
    )
    .await;
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 1);

    let received = receiver.received();
    assert_eq!(received.len(), 1);
    let request = &received[0];
    let message_id = request
        .headers
        .get("svix-id")
        .and_then(|value| value.to_str().ok())
        .expect("svix-id");
    let timestamp = request
        .headers
        .get("svix-timestamp")
        .and_then(|value| value.to_str().ok())
        .expect("svix-timestamp");
    let signature = request
        .headers
        .get("svix-signature")
        .and_then(|value| value.to_str().ok())
        .expect("svix-signature");
    assert_eq!(
        request
            .headers
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/json")
    );
    assert!(verify_webhook_signature(
        &WebhookVerificationInput {
            secret: &secret,
            id: Some(message_id),
            timestamp: Some(timestamp),
            body: &request.body,
            signature: Some(signature),
        },
        VerifyOptions::default(),
    ));

    let payload: serde_json::Value = serde_json::from_str(&request.body).expect("json");
    assert_eq!(payload["object"], "event");
    assert_eq!(payload["type"], "user.created");
    assert_eq!(payload["data"]["id"], "user_1");
    assert_eq!(payload["instance_id"], "default");

    let rows = deliveries(&ctx.state).await;
    assert_eq!(rows.len(), 1);
    let delivery = &rows[0];
    assert_eq!(delivery.status, "success");
    assert_eq!(delivery.attempt, 1);
    assert_eq!(delivery.response_code, Some(200));
    assert!(delivery
        .response_body
        .as_deref()
        .unwrap_or("")
        .contains("\"ok\":true"));
    assert!(delivery.next_attempt_at.is_none());
    let serialized = serialize_webhook_delivery(delivery, "user.created");
    assert_eq!(serialized.object, "webhook_delivery");
    assert_eq!(serialized.event_type, "user.created");
}

#[tokio::test]
async fn retries_use_the_documented_backoff_until_success() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    receiver.enqueue_statuses(&[500u16, 503, 200]);
    insert_endpoint(&ctx.state, "we_retry", &receiver.url, &[], false).await;

    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 1);
    let mut delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "pending");
    assert_eq!(delivery.attempt, 1);
    assert_eq!(delivery.response_code, Some(500));
    let delay = delivery.next_attempt_at.unwrap_or(0) - orbitid_core::http::now();
    assert!((3_000..6_000).contains(&delay), "{delay}");

    force_due(&ctx.state, &delivery.id).await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "pending");
    assert_eq!(delivery.attempt, 2);
    assert_eq!(delivery.response_code, Some(503));
    let delay = delivery.next_attempt_at.unwrap_or(0) - orbitid_core::http::now();
    assert!((290_000..310_000).contains(&delay), "{delay}");

    force_due(&ctx.state, &delivery.id).await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "success");
    assert_eq!(delivery.attempt, 3);
    assert_eq!(delivery.response_code, Some(200));
    assert_eq!(receiver.received().len(), 3);
}

#[tokio::test]
async fn disabled_endpoints_do_not_consume_attempts_and_resume_later() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    receiver.enqueue_statuses(&[500u16, 200]);
    insert_endpoint(&ctx.state, "we_toggle", &receiver.url, &[], false).await;

    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    let mut delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "pending");
    assert_eq!(delivery.attempt, 1);

    sqlx::query("UPDATE webhook_endpoints SET disabled = true WHERE id = 'we_toggle'")
        .execute(&ctx.state.pool)
        .await
        .expect("disable");
    force_due(&ctx.state, &delivery.id).await;
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 0);
    delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "pending");
    assert_eq!(receiver.received().len(), 1);

    sqlx::query("UPDATE webhook_endpoints SET disabled = false WHERE id = 'we_toggle'")
        .execute(&ctx.state.pool)
        .await
        .expect("enable");
    force_due(&ctx.state, &delivery.id).await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "success");
    assert_eq!(delivery.attempt, 2);
    assert_eq!(receiver.received().len(), 2);
}

#[tokio::test]
async fn disabled_endpoints_cannot_starve_an_enabled_delivery() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    insert_endpoint(&ctx.state, "we_enabled", &receiver.url, &[], false).await;

    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO webhook_events (id, type, payload, created_at) VALUES ($1, $2, $3, $4)",
    )
    .bind("evt_starvation")
    .bind("user.created")
    .bind(sqlx::types::Json(json!({
        "id": "evt_starvation", "object": "event", "type": "user.created",
        "data": { "id": "user_x" }, "timestamp": now, "instance_id": "default"
    })))
    .bind(now)
    .execute(&ctx.state.pool)
    .await
    .expect("event");
    for index in 0..20 {
        sqlx::query(
            "INSERT INTO webhook_endpoints \
             (id, url, description, event_types, secret, disabled, created_at, updated_at) \
             VALUES ($1, $2, '', $3, 'whsec_disabled', true, $4, $4)",
        )
        .bind(format!("we_disabled_{index}"))
        .bind(format!("{}?disabled-{index}", receiver.url))
        .bind(sqlx::types::Json(Vec::<String>::new()))
        .bind(now)
        .execute(&ctx.state.pool)
        .await
        .expect("endpoint");
        sqlx::query(
            "INSERT INTO webhook_deliveries \
             (id, endpoint_id, event_id, status, attempt, next_attempt_at, created_at) \
             VALUES ($1, $2, 'evt_starvation', 'pending', 0, $3, $3)",
        )
        .bind(format!("whd_disabled_{index}"))
        .bind(format!("we_disabled_{index}"))
        .bind(now)
        .execute(&ctx.state.pool)
        .await
        .expect("delivery");
    }
    sqlx::query(
        "INSERT INTO webhook_deliveries \
         (id, endpoint_id, event_id, status, attempt, next_attempt_at, created_at) \
         VALUES ('whd_enabled', 'we_enabled', 'evt_starvation', 'pending', 0, $1, $1)",
    )
    .bind(now)
    .execute(&ctx.state.pool)
    .await
    .expect("delivery");

    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 1);
    assert_eq!(receiver.received().len(), 1);
}

#[tokio::test]
async fn gives_up_after_the_retry_schedule_is_exhausted() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    receiver.enqueue_statuses(&[500u16; 7]);
    insert_endpoint(&ctx.state, "we_giveup", &receiver.url, &[], false).await;

    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;
    let mut delivery = deliveries(&ctx.state).await.remove(0);
    for _ in 0..7 {
        force_due(&ctx.state, &delivery.id).await;
        deliver_due(&ctx.state, None).await.expect("deliver");
        delivery = deliveries(&ctx.state).await.remove(0);
    }
    assert_eq!(delivery.status, "failed");
    assert_eq!(delivery.attempt, 7);
    assert_eq!(delivery.response_code, Some(500));
    assert!(delivery.next_attempt_at.is_none());
    assert_eq!(receiver.received().len(), 7);
}

#[tokio::test]
async fn event_subscriptions_and_disabled_endpoints_are_respected() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    insert_endpoint(
        &ctx.state,
        "we_users",
        &receiver.url,
        &["user.created"],
        false,
    )
    .await;
    insert_endpoint(
        &ctx.state,
        "we_sessions",
        &format!("{}?sessions", receiver.url),
        &["session.created"],
        false,
    )
    .await;
    insert_endpoint(
        &ctx.state,
        "we_off",
        &format!("{}?off", receiver.url),
        &[],
        true,
    )
    .await;

    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    let rows = deliveries(&ctx.state).await;
    assert_eq!(rows.len(), 1);
    assert!(rows
        .iter()
        .any(|row| row.endpoint_id == "we_users" && row.status == "success"));
    assert!(rows.iter().all(|row| row.endpoint_id != "we_sessions"));
    assert!(rows.iter().all(|row| row.endpoint_id != "we_off"));
    assert_eq!(receiver.received().len(), 1);

    emit_event(
        &ctx.state,
        "session.created",
        json!({ "object": "session", "id": "sess_1" }),
    )
    .await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    assert_eq!(receiver.received().len(), 2);

    sqlx::query("UPDATE webhook_endpoints SET disabled = true WHERE id = 'we_sessions'")
        .execute(&ctx.state.pool)
        .await
        .expect("disable");
    emit_event(
        &ctx.state,
        "session.created",
        json!({ "object": "session", "id": "sess_2" }),
    )
    .await;
    deliver_due(&ctx.state, None).await.expect("deliver");
    assert_eq!(receiver.received().len(), 2);
}

#[tokio::test]
async fn transport_failures_are_recorded_instead_of_thrown() {
    let ctx = test_state().await;
    insert_endpoint(
        &ctx.state,
        "we_dead",
        "http://127.0.0.1:1/unreachable",
        &[],
        false,
    )
    .await;
    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 1);
    let delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "pending");
    assert_eq!(delivery.attempt, 1);
    assert_eq!(delivery.response_code, None);
    assert!(delivery
        .response_body
        .as_deref()
        .unwrap_or("")
        .starts_with("Error:"));
}

#[tokio::test]
async fn endpoint_serialization_withholds_the_secret_unless_asked() {
    let ctx = test_state().await;
    insert_endpoint(
        &ctx.state,
        "we_serialize",
        "https://hooks.example.test/x",
        &["user.created"],
        false,
    )
    .await;
    let row = sqlx::query_as::<_, orbitid_core::models::WebhookEndpointRow>(
        "SELECT * FROM webhook_endpoints WHERE id = 'we_serialize'",
    )
    .fetch_one(&ctx.state.pool)
    .await
    .expect("row");
    let public = serialize_webhook_endpoint(&row, false);
    assert_eq!(public.object, "webhook_endpoint");
    assert_eq!(public.url, "https://hooks.example.test/x");
    assert_eq!(public.event_types, vec!["user.created".to_string()]);
    assert!(public.secret.is_none());
    assert!(serialize_webhook_endpoint(&row, true).secret.is_some());
}

#[tokio::test]
async fn concurrent_workers_never_double_deliver() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    insert_endpoint(&ctx.state, "we_concurrent", &receiver.url, &[], false).await;
    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;

    let (first, second) =
        tokio::join!(deliver_due(&ctx.state, None), deliver_due(&ctx.state, None));
    let attempted = first.expect("first") + second.expect("second");
    assert_eq!(attempted, 1);
    assert_eq!(receiver.received().len(), 1);
    assert_eq!(deliveries(&ctx.state).await[0].status, "success");
}

#[tokio::test]
async fn the_worker_starts_and_shuts_down_cleanly() {
    let ctx = test_state().await;
    let worker = WebhookWorker::start(ctx.state.clone());
    worker.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_endpoint_does_not_serialise_its_batch() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    // Six deliveries, each taking 400 ms. Sequential delivery needs ~2.4 s;
    // bounded parallel delivery finishes in roughly one delay.
    receiver.enqueue_delays(&[400; 6]);
    insert_endpoint(&ctx.state, "we_slow", &receiver.url, &[], false).await;
    for index in 0..6 {
        emit_event(
            &ctx.state,
            "user.created",
            json!({ "id": format!("user_{index}") }),
        )
        .await;
    }

    let started = std::time::Instant::now();
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 6);
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(1_600),
        "deliveries ran sequentially: {elapsed:?}"
    );
    assert_eq!(receiver.received().len(), 6);
    let rows = deliveries(&ctx.state).await;
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().all(|row| row.status == "success"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_workers_deliver_a_slow_endpoint_exactly_once() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    receiver.enqueue_delays(&[250; 8]);
    insert_endpoint(&ctx.state, "we_slow_once", &receiver.url, &[], false).await;
    for index in 0..8 {
        emit_event(
            &ctx.state,
            "user.created",
            json!({ "id": format!("user_{index}") }),
        )
        .await;
    }

    let (first, second) =
        tokio::join!(deliver_due(&ctx.state, None), deliver_due(&ctx.state, None));
    let attempted = first.expect("first worker") + second.expect("second worker");
    assert_eq!(attempted, 8);
    assert_eq!(receiver.received().len(), 8, "an event was sent twice");
    let rows = deliveries(&ctx.state).await;
    assert_eq!(rows.len(), 8);
    assert!(rows.iter().all(|row| row.status == "success"));
    assert!(rows.iter().all(|row| row.attempt == 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_expired_lease_cannot_overwrite_a_newer_result() {
    let ctx = test_state().await;
    let receiver = start_fake_receiver().await;
    // The first (stale) worker's request is slow and fails; the worker that
    // re-claims the row afterwards answers immediately and succeeds.
    receiver.enqueue_delays(&[1_000, 0]);
    receiver.enqueue_statuses(&[500u16, 200]);
    insert_endpoint(&ctx.state, "we_stale", &receiver.url, &[], false).await;
    emit_event(&ctx.state, "user.created", json!({ "id": "user_1" })).await;

    let stale_state = ctx.state.clone();
    let stale = tokio::spawn(async move { deliver_due(&stale_state, None).await });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while receiver.received().is_empty() {
        assert!(
            std::time::Instant::now() < deadline,
            "the slow worker never sent its request"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    // Simulate the lease expiring while the slow request is in flight, then let
    // a second worker re-claim and record the newer result.
    let delivery = deliveries(&ctx.state).await.remove(0);
    sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 1)
        .bind(&delivery.id)
        .execute(&ctx.state.pool)
        .await
        .expect("expire lease");
    assert_eq!(deliver_due(&ctx.state, None).await.expect("deliver"), 1);
    assert_eq!(
        deliveries(&ctx.state).await[0].status,
        "success",
        "the re-claiming worker's result should be recorded"
    );

    // The stale worker finishes now; its write must be a no-op.
    assert_eq!(stale.await.expect("join").expect("stale worker"), 1);
    let delivery = deliveries(&ctx.state).await.remove(0);
    assert_eq!(delivery.status, "success");
    assert_eq!(delivery.response_code, Some(200));
    assert_eq!(delivery.attempt, 1);
    assert!(delivery.next_attempt_at.is_none());
    assert_eq!(receiver.received().len(), 2);
}

#[tokio::test]
async fn emit_event_on_joins_the_callers_transaction() {
    let ctx = test_state().await;
    insert_endpoint(&ctx.state, "we_tx", "http://localhost:9", &[], false).await;

    // Committed with the caller's transaction: the event and its delivery exist.
    let mut tx = ctx.state.pool.begin().await.expect("begin");
    emit_event_on(
        &mut tx,
        "user.created",
        json!({ "object": "user", "id": "user_tx" }),
    )
    .await
    .expect("emit on the transaction");
    tx.commit().await.expect("commit");

    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events")
        .fetch_one(&ctx.state.pool)
        .await
        .expect("count events");
    assert_eq!(events, 1);
    assert_eq!(deliveries(&ctx.state).await.len(), 1);

    // Rolled back with it: a failed mutation leaves no event behind.
    let mut tx = ctx.state.pool.begin().await.expect("begin");
    emit_event_on(
        &mut tx,
        "user.deleted",
        json!({ "object": "user", "id": "user_tx" }),
    )
    .await
    .expect("emit on the transaction");
    tx.rollback().await.expect("rollback");

    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events")
        .fetch_one(&ctx.state.pool)
        .await
        .expect("count events");
    assert_eq!(events, 1, "a rolled-back event must not be stored");
    assert_eq!(deliveries(&ctx.state).await.len(), 1);
}
