//! SSRF protection end to end, ported from
//! the retired TypeScript test suite and `safe-fetch-hardening.test.ts`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use serde_json::json;

use orbitid_core::safe_fetch::{safe_fetch, SafeFetchOptions};

type SeenRequest = (String, String, Option<String>);

#[derive(Clone, Default)]
struct Probe {
    hits: Arc<AtomicUsize>,
    target: Arc<Mutex<String>>,
    seen: Arc<Mutex<Vec<SeenRequest>>>,
}

fn record(probe: &Probe, request: &Request) -> serde_json::Value {
    probe.hits.fetch_add(1, Ordering::SeqCst);
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    probe
        .seen
        .lock()
        .unwrap()
        .push((method.clone(), path.clone(), authorization));
    json!({ "path": path, "query": if query.is_empty() { String::new() } else { format!("?{query}") }, "method": method })
}

async fn echo(State(probe): State<Probe>, request: Request) -> Response {
    Json(record(&probe, &request)).into_response()
}

async fn redirect(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    let target = probe.target.lock().unwrap().clone();
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, target.parse().unwrap());
    response
}

async fn redirect307(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    let target = probe.target.lock().unwrap().clone();
    let mut response = StatusCode::TEMPORARY_REDIRECT.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, target.parse().unwrap());
    response
}

async fn redirect302(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    let target = probe.target.lock().unwrap().clone();
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, target.parse().unwrap());
    response
}

async fn redirect_loop(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, "/loop".parse().unwrap());
    response
}

async fn huge(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    "x".repeat(4096).into_response()
}

async fn slow(State(probe): State<Probe>, request: Request) -> Response {
    let _ = record(&probe, &request);
    tokio::time::sleep(Duration::from_secs(5)).await;
    "late".into_response()
}

async fn spawn(probe: Probe) -> (String, tokio::sync::oneshot::Sender<()>) {
    let app = Router::new()
        .route("/hello", any(echo))
        .route("/final", any(echo))
        .route("/echo", any(echo))
        .route("/steal", any(echo))
        .route("/next", any(echo))
        .route("/redirect", any(redirect))
        .route("/redirect307", any(redirect307))
        .route("/redirect302", any(redirect302))
        .route("/loop", any(redirect_loop))
        .route("/huge", any(huge))
        .route("/slow", any(slow))
        .with_state(probe);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let (shutdown, signal) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = signal.await;
            })
            .await;
    });
    (format!("http://{address}"), shutdown)
}

fn options() -> SafeFetchOptions {
    SafeFetchOptions::default()
}

#[tokio::test]
async fn private_targets_only_work_in_development_mode() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe.clone()).await;
    let ctx = support::test_state().await;

    assert!(
        orbitid_core::safe_fetch::private_networks_allowed(Some(&ctx.state)),
        "development mode allows a local test server"
    );
    let response = safe_fetch(Some(&ctx.state), &format!("{base}/hello?a=1"), options())
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    let body: serde_json::Value = response.json().unwrap();
    assert_eq!(body["path"], "/hello");
    assert_eq!(body["query"], "?a=1");

    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .unwrap();
    let before = probe.hits.load(Ordering::SeqCst);
    let error = safe_fetch(Some(&ctx.state), &format!("{base}/hello"), options())
        .await
        .unwrap_err();
    assert_eq!(error.status, 400);
    assert_eq!(probe.hits.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn refuses_metadata_and_non_http_targets() {
    let ctx = support::test_state().await;
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .unwrap();
    for url in [
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:6379/",
        "http://127.0.0.1/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://user:pass@example.com/",
    ] {
        let error = safe_fetch(Some(&ctx.state), url, options())
            .await
            .unwrap_err();
        assert_eq!(error.status, 400, "{url}");
    }
}

#[tokio::test]
async fn redirects_are_revalidated_and_bounded() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe.clone()).await;
    let ctx = support::test_state().await;

    *probe.target.lock().unwrap() = format!("{base}/final");
    let response = safe_fetch(Some(&ctx.state), &format!("{base}/redirect"), options())
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    let body: serde_json::Value = response.json().unwrap();
    assert_eq!(body["path"], "/final");
    assert_eq!(probe.hits.load(Ordering::SeqCst), 2);

    // A redirect to a blocked host is refused before any connection is made.
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .unwrap();
    let before = probe.hits.load(Ordering::SeqCst);
    let error = safe_fetch(Some(&ctx.state), &format!("{base}/redirect"), options())
        .await
        .unwrap_err();
    assert_eq!(error.status, 400);
    assert_eq!(probe.hits.load(Ordering::SeqCst), before);

    // More than three redirects is refused.
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": true } }))
        .await
        .unwrap();
    *probe.target.lock().unwrap() = format!("{base}/loop");
    let error = safe_fetch(Some(&ctx.state), &format!("{base}/loop"), options())
        .await
        .unwrap_err();
    assert!(error.message.contains("Too many redirects"));
    assert!(probe.hits.load(Ordering::SeqCst) <= 6);
}

#[tokio::test]
async fn caps_response_size_and_total_time() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe).await;
    let ctx = support::test_state().await;
    let error = safe_fetch(
        Some(&ctx.state),
        &format!("{base}/huge"),
        SafeFetchOptions {
            max_bytes: Some(512),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("exceeds 512 bytes"));

    let error = safe_fetch(
        Some(&ctx.state),
        &format!("{base}/slow"),
        SafeFetchOptions {
            timeout_ms: Some(120),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("timed out"));
}

#[tokio::test]
async fn sends_the_requested_method_headers_and_body() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe.clone()).await;
    let ctx = support::test_state().await;
    let response = safe_fetch(
        Some(&ctx.state),
        &format!("{base}/echo"),
        SafeFetchOptions {
            method: Some("POST".into()),
            headers: orbitid_core::safe_fetch::headers(&[("content-type", "application/json")]),
            body: Some(br#"{"ok":true}"#.to_vec()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let body: serde_json::Value = response.json().unwrap();
    assert_eq!(body["method"], "POST");
    assert_eq!(body["path"], "/echo");
}

#[tokio::test]
async fn redirects_never_leak_credentials_or_bodies_to_another_origin() {
    let first = Probe::default();
    let second = Probe::default();
    let (first_base, _first_shutdown) = spawn(first.clone()).await;
    let (second_base, _second_shutdown) = spawn(second.clone()).await;
    let ctx = support::test_state().await;

    // 307 cross-origin with a body: refused before the second server is called.
    *first.target.lock().unwrap() = format!("{second_base}/steal");
    let error = safe_fetch(
        Some(&ctx.state),
        &format!("{first_base}/redirect307"),
        SafeFetchOptions {
            method: Some("POST".into()),
            headers: orbitid_core::safe_fetch::headers(&[
                ("authorization", "Bearer PRIVATE"),
                ("content-type", "application/x-www-form-urlencoded"),
            ]),
            body: Some(b"client_secret=PRIVATE&code=AUTH".to_vec()),
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("another origin"));
    assert_eq!(second.hits.load(Ordering::SeqCst), 0);

    // 302 cross-origin becomes a body-less GET without the Authorization header.
    *first.target.lock().unwrap() = format!("{second_base}/next");
    let response = safe_fetch(
        Some(&ctx.state),
        &format!("{first_base}/redirect302"),
        SafeFetchOptions {
            method: Some("POST".into()),
            headers: orbitid_core::safe_fetch::headers(&[("authorization", "Bearer PRIVATE")]),
            body: Some(b"secret=1".to_vec()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(response.status, 200);
    let seen = second.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "GET");
    assert!(seen[0].2.is_none());
}

#[tokio::test]
async fn same_origin_307_keeps_method_credentials_and_body() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe.clone()).await;
    let ctx = support::test_state().await;
    *probe.target.lock().unwrap() = "/final".to_string();
    let response = safe_fetch(
        Some(&ctx.state),
        &format!("{base}/redirect307"),
        SafeFetchOptions {
            method: Some("POST".into()),
            headers: orbitid_core::safe_fetch::headers(&[("authorization", "Bearer KEEP")]),
            body: Some(b"x=1".to_vec()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(response.status, 200);
    let body: serde_json::Value = response.json().unwrap();
    assert_eq!(body["method"], "POST");
    let seen = probe.seen.lock().unwrap();
    assert_eq!(seen.last().unwrap().2.as_deref(), Some("Bearer KEEP"));
}

#[tokio::test]
async fn mapped_loopback_literal_is_refused_when_private_networks_are_off() {
    let probe = Probe::default();
    let (base, _shutdown) = spawn(probe.clone()).await;
    let port = url::Url::parse(&base).unwrap().port().unwrap();
    let ctx = support::test_state().await;
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .unwrap();
    let error = safe_fetch(
        Some(&ctx.state),
        &format!("http://[::ffff:127.0.0.1]:{port}/"),
        options(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("non-public"));
    assert_eq!(probe.hits.load(Ordering::SeqCst), 0);
}
