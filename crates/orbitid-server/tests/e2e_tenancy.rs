//! Multi-replica behaviour and a real-process smoke test.
//!
//! Two `AppState`s point at the same database (two stateless replicas behind a
//! load balancer): settings written through one are observed by the other, a
//! session minted on one is valid on the other, and rate limits are shared.
//! The last test spawns the actual `orbitid` binary on an ephemeral port and
//! talks to it over TCP.

mod common;

use std::process::{Command, Stdio};
use std::time::Duration;

use axum::http::StatusCode;
use common::*;
use orbitid_core::testing::EphemeralDb;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn two_replicas_share_settings_sessions_and_rate_limits() {
    let first = E2e::new().await;
    let second_state = replica_state(&first.app.context.db.url).await;
    let second =
        orbitid_core::testing::TestClient::new(orbitid_server::build_app(second_state.clone()));

    // ── settings written through replica A are served by replica B ──
    let patched = first
        .client
        .patch(
            "/v1/instance",
            Some(json!({ "application": { "name": "Shared Replica" } })),
            bearer(),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    let mut observed = false;
    for _ in 0..50 {
        let environment = second.get("/v1/client/environment", &[]).await;
        if environment.status == StatusCode::OK
            && environment.value()["display_config"]["application_name"] == "Shared Replica"
        {
            observed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(observed, "replica B never observed the settings change");

    // ── a browser session minted through A is valid through B ──
    let browser = first.browser();
    sign_up(&first, &browser, "shared@example.com", "Sup3r-secret!").await;
    let cookie = browser.cookie_header().expect("client cookie");
    let on_second = orbitid_core::testing::TestClient::with_cookie(
        orbitid_server::build_app(second_state.clone()),
        &cookie,
    );
    let profile = on_second.get("/v1/client/me", &[]).await;
    assert_eq!(profile.status, StatusCode::OK, "{}", profile.text());
    assert_eq!(
        profile.value()["response"]["email_addresses"][0]["email_address"],
        "shared@example.com"
    );

    // ── secret-key failure budget is shared ──
    let bad = [("authorization", "Bearer sk_test_wrong_key")];
    for index in 0..10 {
        let response = first.client.get("/v1/users", &bad).await;
        assert_eq!(
            response.status,
            StatusCode::UNAUTHORIZED,
            "attempt {index}: {}",
            response.text()
        );
    }
    let blocked = second.get("/v1/users", &bad).await;
    assert_eq!(
        blocked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        blocked.text()
    );
    assert_eq!(blocked.value()["errors"][0]["code"], "rate_limit_exceeded");
}

struct ChildGuard(std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn wait_for_http(port: u16) -> String {
    for _ in 0..200 {
        if let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            let request = b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
            if stream.write_all(request).await.is_ok() {
                let mut response = Vec::new();
                if tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut response))
                    .await
                    .is_ok()
                {
                    return String::from_utf8_lossy(&response).to_string();
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    panic!("the binary never answered on port {port}");
}

#[tokio::test]
async fn real_binary_serves_health_over_tcp() {
    let db = EphemeralDb::create().await.expect("ephemeral database");
    // Reserve a port, then release it for the child process.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let data_dir = std::env::temp_dir().join(format!(
        "orbitid-rs-binary-{}",
        orbitid_core::crypto::random_token(8)
    ));
    let child = Command::new(env!("CARGO_BIN_EXE_orbitid"))
        .arg("start")
        .env("PORT", port.to_string())
        .env("ORBITID_DATABASE_URL", &db.url)
        .env("ORBITID_SECRET_KEY", SECRET_KEY)
        .env("ORBITID_BASE_URL", format!("http://127.0.0.1:{port}"))
        .env(
            "ORBITID_ENCRYPTION_KEY",
            "test-encryption-key-for-orbitid-0123456789",
        )
        .env("ORBITID_DATA_DIR", &data_dir)
        .env("ORBITID_DASHBOARD_DIR", "/nonexistent-dashboard")
        .env("NODE_ENV", "test")
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn orbitid");
    let mut guard = ChildGuard(child);

    let health = wait_for_http(port).await;
    assert!(
        health.starts_with("HTTP/1.1 200") || health.starts_with("HTTP/1.0 200"),
        "{health}"
    );
    assert!(health.contains("publishable_key"), "{health}");
    assert!(health.contains("\"database\":\"postgres\""), "{health}");

    // The readiness probe answers over the same real socket.
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    stream
        .write_all(b"GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .expect("write");
    let mut ready = Vec::new();
    stream.read_to_end(&mut ready).await.expect("read");
    let ready = String::from_utf8_lossy(&ready);
    assert!(ready.contains("\"status\":\"ready\""), "{ready}");

    // A graceful SIGTERM lets the process exit on its own.
    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(guard.0.id().to_string())
        .status();
    for _ in 0..100 {
        if guard.0.try_wait().expect("try_wait").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
