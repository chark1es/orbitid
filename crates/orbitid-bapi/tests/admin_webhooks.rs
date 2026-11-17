//! Ported from the retired TypeScript test suite (HTTP parts).
//! Svix signing unit tests live in `orbitid-platform`.

mod common;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use orbitid_platform::webhooks::{
    deliver_due, verify_webhook_signature, VerifyOptions, WebhookVerificationInput,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use common::setup;

#[derive(Clone, Default)]
struct Received {
    id: String,
    timestamp: String,
    signature: String,
    content_type: String,
    body: String,
}

#[derive(Default)]
struct HookState {
    received: Vec<Received>,
    respond: VecDeque<u16>,
}

struct HookServer {
    port: u16,
    state: Arc<Mutex<HookState>>,
}

impl HookServer {
    async fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let state = Arc::new(Mutex::new(HookState::default()));
        let shared = state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let shared = shared.clone();
                tokio::spawn(async move {
                    let mut buffer = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                        if let Some(position) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
                            break position + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    while buffer.len() < header_end + content_length {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        buffer.extend_from_slice(&chunk[..read]);
                    }
                    let body = String::from_utf8_lossy(
                        &buffer[header_end..(header_end + content_length).min(buffer.len())],
                    )
                    .to_string();
                    let header = |name: &str| {
                        headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case(name)
                                    .then(|| value.trim().to_string())
                            })
                            .unwrap_or_default()
                    };
                    let id = header("svix-id");
                    let status = if id.is_empty() {
                        404
                    } else {
                        let mut state = shared.lock().expect("hook state");
                        state.received.push(Received {
                            id,
                            timestamp: header("svix-timestamp"),
                            signature: header("svix-signature"),
                            content_type: header("content-type"),
                            body: body.clone(),
                        });
                        state.respond.pop_front().unwrap_or(200)
                    };
                    let payload = format!("{{\"ok\":{},\"echoed\":{}}}", status == 200, body.len());
                    let response = format!(
                        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        Self { port, state }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/hook", self.port)
    }

    fn respond_with(&self, statuses: Vec<u16>) {
        self.state
            .lock()
            .expect("hook state")
            .respond
            .extend(statuses);
    }

    fn received(&self) -> Vec<Received> {
        self.state.lock().expect("hook state").received.clone()
    }
}

async fn create_user(harness: &common::Harness, body: Value) -> Value {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut body = body;
    let object = body.as_object_mut().expect("object body");
    if !object.contains_key("email_address") {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        object.insert(
            "email_address".into(),
            json!([format!("hook-{n}@example.com")]),
        );
    }
    if !object.contains_key("password") {
        object.insert("password".into(), json!("Sup3r-secret!"));
    }
    let response = harness.post("/v1/users", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

async fn force_due(harness: &common::Harness, delivery_id: &str) {
    sqlx::query("UPDATE webhook_deliveries SET next_attempt_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now())
        .bind(delivery_id)
        .execute(&harness.state().pool)
        .await
        .expect("force due");
}

async fn deliveries(harness: &common::Harness, endpoint_id: &str) -> Vec<Value> {
    let response = harness
        .get(&format!("/v1/webhooks/endpoints/{endpoint_id}/deliveries"))
        .await;
    response.value()["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[tokio::test]
async fn delivers_events_with_verifiable_headers_and_records_the_response() {
    let harness = setup().await;
    let server = HookServer::start().await;
    let created = harness
        .post(
            "/v1/webhooks/endpoints",
            json!({ "url": server.url(), "description": "tests" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let endpoint = created.value();
    let secret = endpoint["secret"].as_str().expect("secret").to_string();
    assert!(secret.starts_with("whsec_"));
    assert_eq!(endpoint["event_types"], json!([]));

    let user = create_user(&harness, json!({ "email_address": ["hooked@example.com"] })).await;
    let attempted = deliver_due(harness.state(), None).await.expect("deliver");
    assert_eq!(attempted, 1);

    let received = server.received();
    assert_eq!(received.len(), 1);
    let request = &received[0];
    assert_eq!(request.content_type, "application/json");
    assert!(verify_webhook_signature(
        &WebhookVerificationInput {
            secret: &secret,
            id: Some(&request.id),
            timestamp: Some(&request.timestamp),
            body: &request.body,
            signature: Some(&request.signature),
        },
        VerifyOptions::default(),
    ));
    let payload: Value = serde_json::from_str(&request.body).expect("payload");
    assert_eq!(payload["object"], json!("event"));
    assert_eq!(payload["type"], json!("user.created"));
    assert_eq!(payload["data"]["id"], user["id"]);

    let endpoint_id = endpoint["id"].as_str().unwrap();
    let rows = deliveries(&harness, endpoint_id).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["object"], json!("webhook_delivery"));
    assert_eq!(rows[0]["event_id"], json!(request.id));
    assert_eq!(rows[0]["event_type"], json!("user.created"));
    assert_eq!(rows[0]["status"], json!("success"));
    assert_eq!(rows[0]["attempt"], json!(1));
    assert_eq!(rows[0]["response_code"], json!(200));
    assert!(rows[0]["response_body"]
        .as_str()
        .unwrap_or_default()
        .contains("\"ok\":true"));
    assert_eq!(rows[0]["next_attempt_at"], Value::Null);
}

#[tokio::test]
async fn retries_failures_with_the_documented_backoff() {
    let harness = setup().await;
    let server = HookServer::start().await;
    server.respond_with(vec![500, 503, 200]);
    let endpoint = harness
        .post("/v1/webhooks/endpoints", json!({ "url": server.url() }))
        .await
        .value();

    create_user(&harness, json!({})).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    let endpoint_id = endpoint["id"].as_str().unwrap();
    let rows = deliveries(&harness, endpoint_id).await;
    let mut delivery = rows[0].clone();
    assert_eq!(delivery["status"], json!("pending"));
    assert_eq!(delivery["attempt"], json!(1));
    assert_eq!(delivery["response_code"], json!(500));
    let delay = delivery["next_attempt_at"].as_i64().unwrap() - orbitid_core::http::now();
    assert!((3_000..6_000).contains(&delay), "{delay}");

    force_due(&harness, delivery["id"].as_str().unwrap()).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    delivery = deliveries(&harness, endpoint_id).await[0].clone();
    assert_eq!(delivery["status"], json!("pending"));
    assert_eq!(delivery["attempt"], json!(2));
    assert_eq!(delivery["response_code"], json!(503));
    let delay = delivery["next_attempt_at"].as_i64().unwrap() - orbitid_core::http::now();
    assert!((290_000..310_000).contains(&delay), "{delay}");

    force_due(&harness, delivery["id"].as_str().unwrap()).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    delivery = deliveries(&harness, endpoint_id).await[0].clone();
    assert_eq!(delivery["status"], json!("success"));
    assert_eq!(delivery["attempt"], json!(3));
    assert_eq!(delivery["response_code"], json!(200));
    assert_eq!(server.received().len(), 3);
}

#[tokio::test]
async fn stops_queued_deliveries_while_an_endpoint_is_disabled() {
    let harness = setup().await;
    let server = HookServer::start().await;
    server.respond_with(vec![500]);
    let endpoint = harness
        .post("/v1/webhooks/endpoints", json!({ "url": server.url() }))
        .await
        .value();
    create_user(&harness, json!({})).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    let endpoint_id = endpoint["id"].as_str().unwrap();
    let mut delivery = deliveries(&harness, endpoint_id).await[0].clone();
    assert_eq!(delivery["status"], json!("pending"));
    assert_eq!(delivery["attempt"], json!(1));
    assert_eq!(server.received().len(), 1);

    harness
        .patch(
            &format!("/v1/webhooks/endpoints/{endpoint_id}"),
            json!({ "disabled": true }),
        )
        .await;
    harness
        .post_empty(&format!(
            "/v1/webhooks/deliveries/{}/retry",
            delivery["id"].as_str().unwrap()
        ))
        .await;
    force_due(&harness, delivery["id"].as_str().unwrap()).await;
    assert_eq!(
        deliver_due(harness.state(), None).await.expect("deliver"),
        0
    );
    delivery = deliveries(&harness, endpoint_id).await[0].clone();
    assert_eq!(server.received().len(), 1);
    assert_eq!(delivery["status"], json!("pending"));
    assert_eq!(delivery["attempt"], json!(0));
    assert_eq!(delivery["response_code"], Value::Null);

    harness
        .patch(
            &format!("/v1/webhooks/endpoints/{endpoint_id}"),
            json!({ "disabled": false }),
        )
        .await;
    deliver_due(harness.state(), None).await.expect("deliver");
    delivery = deliveries(&harness, endpoint_id).await[0].clone();
    assert_eq!(server.received().len(), 2);
    assert_eq!(delivery["status"], json!("success"));
    assert_eq!(delivery["attempt"], json!(1));
}

#[tokio::test]
async fn sends_a_sample_event_from_the_test_endpoint() {
    let harness = setup().await;
    let server = HookServer::start().await;
    let endpoint = harness
        .post("/v1/webhooks/endpoints", json!({ "url": server.url() }))
        .await
        .value();
    let delivery = harness
        .post_empty(&format!(
            "/v1/webhooks/endpoints/{}/test",
            endpoint["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(delivery.status, StatusCode::OK, "{}", delivery.text());
    assert_eq!(delivery.value()["status"], json!("success"));
    assert_eq!(delivery.value()["event_type"], json!("user.created"));
    let received = server.received();
    assert_eq!(received.len(), 1);
    let payload: Value = serde_json::from_str(&received[0].body).expect("payload");
    assert_eq!(payload["data"]["test"], json!(true));
    assert_eq!(payload["data"]["id"], endpoint["id"]);
}

#[tokio::test]
async fn records_transport_failures_instead_of_throwing() {
    let harness = setup().await;
    harness
        .post(
            "/v1/webhooks/endpoints",
            json!({ "url": "http://127.0.0.1:1/unreachable" }),
        )
        .await;
    create_user(&harness, json!({})).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, endpoint_id FROM webhook_deliveries")
            .fetch_all(&harness.state().pool)
            .await
            .expect("delivery");
    let endpoint_id = rows[0].1.clone();
    let rows = deliveries(&harness, &endpoint_id).await;
    assert_eq!(rows[0]["status"], json!("pending"));
    assert_eq!(rows[0]["attempt"], json!(1));
    assert_eq!(rows[0]["response_code"], Value::Null);
    assert!(!rows[0]["response_body"]
        .as_str()
        .unwrap_or_default()
        .is_empty());
}

#[tokio::test]
async fn manages_endpoints_rotates_secrets_and_retries_deliveries() {
    let harness = setup().await;
    let server = HookServer::start().await;
    let event_types = harness.get("/v1/webhooks/event_types").await;
    let types = event_types.value();
    for expected in ["user.created", "user.deleted", "organization.created"] {
        assert!(types
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == expected));
    }

    let endpoint = harness
        .post(
            "/v1/webhooks/endpoints",
            json!({ "url": server.url(), "description": "first" }),
        )
        .await
        .value();
    let id = endpoint["id"].as_str().unwrap().to_string();
    let original_secret = endpoint["secret"].as_str().unwrap().to_string();

    let read = harness.get(&format!("/v1/webhooks/endpoints/{id}")).await;
    assert!(read.value().get("secret").is_none());
    let list_text = harness
        .get("/v1/webhooks/endpoints")
        .await
        .text()
        .to_string();
    assert!(!list_text.contains(&original_secret));
    let secret = harness
        .get(&format!("/v1/webhooks/endpoints/{id}/secret"))
        .await;
    assert_eq!(secret.value()["secret"], json!(original_secret));

    let rotated = harness
        .patch(
            &format!("/v1/webhooks/endpoints/{id}"),
            json!({ "rotate_secret": true, "description": "rotated" }),
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.text());
    let rotated_secret = rotated.value()["secret"].as_str().unwrap().to_string();
    assert!(rotated_secret.starts_with("whsec_"));
    assert_ne!(rotated_secret, original_secret);
    assert_eq!(rotated.value()["description"], json!("rotated"));

    assert_eq!(
        harness
            .post("/v1/webhooks/endpoints", json!({ "url": "nope" }))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .post(
                "/v1/webhooks/endpoints",
                json!({ "url": server.url(), "event_types": ["user.exploded"] }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness.get("/v1/webhooks/endpoints").await.value()["total_count"],
        json!(1)
    );

    server.respond_with(vec![500]);
    create_user(&harness, json!({})).await;
    deliver_due(harness.state(), None).await.expect("deliver");
    let failed = deliveries(&harness, &id).await[0].clone();
    assert_eq!(failed["status"], json!("pending"));

    let retried = harness
        .post_empty(&format!(
            "/v1/webhooks/deliveries/{}/retry",
            failed["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(retried.status, StatusCode::OK, "{}", retried.text());
    assert_eq!(retried.value()["status"], json!("pending"));
    assert_eq!(retried.value()["attempt"], json!(0));
    deliver_due(harness.state(), None).await.expect("deliver");
    assert_eq!(
        deliveries(&harness, &id).await[0]["status"],
        json!("success")
    );

    assert_eq!(
        harness
            .post_empty("/v1/webhooks/deliveries/whd_nope/retry")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        harness
            .delete(&format!("/v1/webhooks/endpoints/{id}"))
            .await
            .value(),
        json!({ "object": "webhook_endpoint", "id": id, "deleted": true })
    );
    assert_eq!(
        harness
            .get(&format!("/v1/webhooks/endpoints/{id}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
