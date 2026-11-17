//! End-to-end walks for machine credentials and webhook delivery: API key
//! create → verify, an M2M client-credentials token, and a real HTTP delivery of
//! a signed `user.created` event to a local listener through the background
//! worker.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use common::*;
use orbitid_platform::webhooks::{
    verify_webhook_signature, WebhookVerificationInput, WebhookWorker,
};
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Received(Arc<Mutex<Vec<(HeaderMap, Bytes)>>>);

async fn start_receiver() -> (String, Received) {
    let received = Received::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let sink = received.clone();
    let app = Router::new().route(
        "/hook",
        post(
            move |State(sink): State<Received>, headers: HeaderMap, body: Bytes| async move {
                if let Ok(mut requests) = sink.0.lock() {
                    requests.push((headers, body));
                }
                StatusCode::OK
            },
        )
        .with_state(sink),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://127.0.0.1:{port}/hook"), received)
}

async fn wait_for(received: &Received) -> Option<(HeaderMap, Bytes)> {
    for _ in 0..100 {
        if let Ok(requests) = received.0.lock() {
            if let Some(first) = requests.first() {
                return Some((first.0.clone(), first.1.clone()));
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[tokio::test]
async fn api_key_create_then_verify() {
    let e2e = E2e::new().await;
    let browser = e2e.browser();
    let signup = sign_up(&e2e, &browser, "key@example.com", "Sup3r-secret!").await;
    let user_id = signup["response"]["created_user_id"]
        .as_str()
        .unwrap()
        .to_string();

    let created = e2e
        .client
        .post(
            "/v1/api_keys",
            Some(json!({ "name": "CI", "subject": user_id, "scopes": ["read"] })),
            bearer(),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let key: Value = created.value();
    let secret = key["secret"].as_str().expect("secret").to_string();
    assert!(secret.starts_with("ak_live_"));

    let verified = e2e
        .client
        .post(
            "/v1/api_keys/verify",
            Some(json!({ "secret": secret })),
            bearer(),
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(verified.value()["id"], key["id"]);
    assert_eq!(verified.value()["subject"], user_id);

    // Revocation is a revocation of the credential, not just a flag on reads.
    let revoked = e2e
        .client
        .post(
            &format!("/v1/api_keys/{}/revoke", key["id"].as_str().unwrap()),
            Some(json!({})),
            bearer(),
        )
        .await;
    assert_eq!(revoked.status, StatusCode::OK);
    let after = e2e
        .client
        .post(
            "/v1/api_keys/verify",
            Some(json!({ "secret": secret })),
            bearer(),
        )
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn m2m_client_credentials_token() {
    let e2e = E2e::new().await;
    let machine = e2e
        .client
        .post("/v1/m2m/machines", Some(json!({ "name": "ci" })), bearer())
        .await;
    assert_eq!(machine.status, StatusCode::CREATED, "{}", machine.text());
    let machine: Value = machine.value();
    let id = machine["id"].as_str().unwrap().to_string();
    let secret = machine["secret"].as_str().unwrap().to_string();

    use base64::Engine;
    let basic = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{id}:{secret}"))
    );
    let token = form_post(
        &orbitid_server::build_app(e2e.state().clone()),
        None,
        "/oauth/m2m/token",
        &[("grant_type", "client_credentials")],
        &[("authorization", &basic)],
    )
    .await;
    assert_eq!(token.status, StatusCode::OK, "{}", token.text());
    let access = token.value()["access_token"]
        .as_str()
        .expect("access token")
        .to_string();
    assert!(access.starts_with("mt_"));

    let listed = e2e.client.get("/v1/m2m/tokens", bearer()).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text());
    assert!(listed.value()["total_count"].as_i64().unwrap_or(0) >= 1);
}

#[tokio::test]
async fn webhook_delivers_a_signed_user_created_event() {
    let e2e = E2e::new().await;
    let (url, received) = start_receiver().await;
    let endpoint = e2e
        .client
        .post(
            "/v1/webhooks/endpoints",
            Some(json!({ "url": url, "event_types": ["user.created"] })),
            bearer(),
        )
        .await;
    assert_eq!(endpoint.status, StatusCode::OK, "{}", endpoint.text());
    let endpoint: Value = endpoint.value();
    let secret = endpoint["secret"].as_str().expect("secret").to_string();

    let worker = WebhookWorker::start(e2e.state().clone());
    // A Backend API user creation emits `user.created`.
    let created = e2e
        .client
        .post(
            "/v1/users",
            Some(json!({
                "email_address": ["hooked@example.com"],
                "password": "Sup3r-secret!"
            })),
            bearer(),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());

    let (headers, body) = wait_for(&received).await.expect("a delivery");
    let body_text = String::from_utf8_lossy(&body).to_string();
    assert_eq!(headers.get("content-type").unwrap(), "application/json");
    let event: Value = serde_json::from_str(&body_text).expect("event json");
    assert_eq!(event["type"], "user.created");
    assert!(event["data"]["email_addresses"][0]["email_address"]
        .as_str()
        .unwrap_or_default()
        .contains("hooked@example.com"));

    let verified = verify_webhook_signature(
        &WebhookVerificationInput {
            secret: &secret,
            id: headers.get("svix-id").and_then(|v| v.to_str().ok()),
            timestamp: headers.get("svix-timestamp").and_then(|v| v.to_str().ok()),
            body: &body_text,
            signature: headers.get("svix-signature").and_then(|v| v.to_str().ok()),
        },
        Default::default(),
    );
    assert!(verified, "the delivery carries a valid svix signature");

    // The delivery is recorded for the dashboard.
    let deliveries = e2e
        .client
        .get(
            &format!(
                "/v1/webhooks/endpoints/{}/deliveries",
                endpoint["id"].as_str().unwrap()
            ),
            bearer(),
        )
        .await;
    assert_eq!(deliveries.status, StatusCode::OK);
    assert!(!deliveries.value()["data"].as_array().unwrap().is_empty());
    worker.shutdown().await;
}
