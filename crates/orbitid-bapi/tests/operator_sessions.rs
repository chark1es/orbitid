//! The dashboard console cookie: how it is issued, where it is honoured, and
//! the per-address budgets on the console routes. The secret key never opens
//! the dashboard; account-based access is covered in `console_access.rs`.

mod common;

use axum::http::StatusCode;
use serde_json::json;

use common::{setup, SECRET_KEY};

const PASSWORD: &str = "correct horse battery staple";

fn operator_cookie(response: &orbitid_core::testing::TestResponse) -> Option<String> {
    response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("__orbit_operator="))
        .map(str::to_string)
}

async fn setup_owner(
    client: &orbitid_core::testing::TestClient,
) -> orbitid_core::testing::TestResponse {
    client
        .post(
            "/v1/operator_sessions/setup",
            Some(json!({ "email_address": "owner@example.com", "password": PASSWORD })),
            &[],
        )
        .await
}

#[tokio::test]
async fn the_secret_key_does_not_open_the_dashboard() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert!(!response.status.is_success(), "{}", response.status);
    assert!(operator_cookie(&response).is_none());
    // The key still authenticates the Backend API itself, as a bearer token.
    assert_eq!(harness.get("/v1/instance").await.status, StatusCode::OK);
}

#[tokio::test]
async fn the_console_cookie_is_http_only_strict_and_scoped_to_the_api() {
    let harness = setup().await;
    let response = setup_owner(&harness.client).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text());
    let raw = operator_cookie(&response).expect("operator cookie");
    let lower = raw.to_ascii_lowercase();
    assert!(lower.contains("httponly"));
    assert!(lower.contains("samesite=strict"));
    assert!(lower.contains("path=/v1"));
    assert!(!lower.contains("secure"));
}

#[tokio::test]
async fn the_cookie_authenticates_backend_reads_and_writes() {
    let harness = setup().await;
    let console = harness.console().await;
    let read = harness.cookie("/v1/instance", &console.cookie).await;
    assert_eq!(read.status, StatusCode::OK, "{}", read.text());
    assert!(read.value()["publishable_key"]
        .as_str()
        .unwrap_or("")
        .starts_with("pk_test_"));

    let write = harness
        .client
        .post(
            "/v1/users",
            Some(json!({
                "email_address": ["cookie-user@example.com"],
                "password": "Sup3r-secret!",
            })),
            &[("cookie", &console.cookie)],
        )
        .await;
    assert_eq!(write.status, StatusCode::OK, "{}", write.text());
}

#[tokio::test]
async fn current_reports_the_session_and_sign_out_revokes_it() {
    let harness = setup().await;
    // The client jar keeps both cookies from setup.
    assert_eq!(
        setup_owner(&harness.client).await.status,
        StatusCode::CREATED
    );
    let current = harness
        .client
        .get("/v1/operator_sessions/current", &[])
        .await;
    assert_eq!(current.status, StatusCode::OK, "{}", current.text());
    assert_eq!(current.value()["object"], "operator_session");
    assert!(current.value()["user_id"]
        .as_str()
        .unwrap_or("")
        .starts_with("user_"));

    let out = harness
        .client
        .delete("/v1/operator_sessions/current", None, &[])
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    let cleared = operator_cookie(&out).expect("cleared cookie");
    assert!(
        cleared.to_ascii_lowercase().contains("max-age=0")
            || cleared.contains("Expires=Thu, 01 Jan 1970"),
        "{cleared}"
    );
    let denied = harness.client.get("/v1/instance", &[]).await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_cookie_stays_on_this_origin() {
    let harness = setup().await;
    let console = harness.console().await;
    for origin in ["https://evil.example", "null"] {
        let read = harness
            .client
            .get(
                "/v1/instance",
                &[("cookie", &console.cookie), ("origin", origin)],
            )
            .await;
        assert_eq!(read.status, StatusCode::FORBIDDEN, "{origin}");
    }
    let cross_site = harness
        .client
        .get(
            "/v1/users",
            &[
                ("cookie", &console.cookie),
                ("sec-fetch-site", "cross-site"),
            ],
        )
        .await;
    assert_eq!(cross_site.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_query_string_key_is_refused() {
    let harness = setup().await;
    let response = harness
        .client
        .get("/v1/instance?secret_key=sk_test_testsecret", &[])
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn adds_secure_when_the_instance_is_served_over_https() {
    let app = orbitid_identity::testing::test_app_state_with(orbitid_core::config::EnvOverrides {
        base_url: Some("https://auth.example.com".into()),
        ..Default::default()
    })
    .await;
    let client = orbitid_core::testing::TestClient::new(common::build_app(app.state()));
    let response = setup_owner(&client).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text());
    let raw = operator_cookie(&response).expect("cookie");
    assert!(raw
        .to_ascii_lowercase()
        .split(';')
        .any(|part| part.trim() == "secure"));
}

#[tokio::test]
async fn applies_the_origin_rule_to_current_and_sign_out() {
    let harness = setup().await;
    let console = harness.console().await;
    for origin in ["https://evil.example", "null"] {
        let read = harness
            .client
            .get(
                "/v1/operator_sessions/current",
                &[("cookie", &console.cookie), ("origin", origin)],
            )
            .await;
        assert_eq!(read.status, StatusCode::FORBIDDEN, "{origin}");
        let delete = harness
            .client
            .delete(
                "/v1/operator_sessions/current",
                None,
                &[("cookie", &console.cookie), ("origin", origin)],
            )
            .await;
        assert_eq!(delete.status, StatusCode::FORBIDDEN, "{origin}");
    }
    assert_eq!(
        harness.cookie("/v1/instance", &console.cookie).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn refuses_an_unknown_or_expired_session_cookie() {
    let harness = setup().await;
    for cookie in ["__orbit_operator=", "__orbit_operator=not-a-real-token"] {
        assert_eq!(
            harness.cookie("/v1/instance", cookie).await.status,
            StatusCode::UNAUTHORIZED
        );
    }
    let console = harness.console().await;
    sqlx::query("UPDATE operator_sessions SET expires_at = $1")
        .bind(orbitid_core::http::now() - 1)
        .execute(&harness.state().pool)
        .await
        .expect("expire");
    assert_eq!(
        harness.cookie("/v1/instance", &console.cookie).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn stores_only_a_hash_and_the_key_fingerprint() {
    let harness = setup().await;
    let console = harness.console().await;
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT token_hash, key_fingerprint FROM operator_sessions")
            .fetch_all(&harness.state().pool)
            .await
            .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_ne!(rows[0].0, console.token);
    assert!(!rows[0].0.contains(&console.token));
    assert_eq!(
        rows[0].1,
        orbitid_identity::operator_session::key_fingerprint(SECRET_KEY)
    );
}

#[tokio::test]
async fn an_explicit_refused_origin_is_not_overridden_by_a_trusted_referer() {
    let harness = setup().await;
    let console = harness.console().await;
    let response = harness
        .client
        .get(
            "/v1/instance",
            &[
                ("cookie", &console.cookie),
                ("origin", "https://evil.example"),
                ("referer", "http://localhost:4000/users"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

fn assert_rate_limited(response: &orbitid_core::testing::TestResponse) {
    assert_eq!(
        response.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        response.text()
    );
    assert_eq!(
        common::error_code(response).as_deref(),
        Some("rate_limit_exceeded")
    );
    assert!(response.headers.contains_key("retry-after"));
}

#[tokio::test]
async fn opening_the_console_is_rate_limited_per_address() {
    let harness = setup().await;
    // A signed-out browser: each attempt is refused, and each one counts.
    for _ in 0..20 {
        let response = harness
            .client
            .post("/v1/operator_sessions/from_user", None, &[])
            .await;
        assert_eq!(
            response.status,
            StatusCode::UNAUTHORIZED,
            "{}",
            response.text()
        );
    }
    let blocked = harness
        .client
        .post("/v1/operator_sessions/from_user", None, &[])
        .await;
    assert_rate_limited(&blocked);
}

#[tokio::test]
async fn owner_setup_is_rate_limited_per_address() {
    let harness = setup().await;
    for _ in 0..10 {
        let weak = harness
            .client
            .post(
                "/v1/operator_sessions/setup",
                Some(json!({ "email_address": "a@example.com", "password": "short" })),
                &[],
            )
            .await;
        assert_eq!(
            weak.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            weak.text()
        );
    }
    // Even a valid attempt waits out the window.
    assert_rate_limited(&setup_owner(&harness.client).await);
    assert!(operator_cookie(&setup_owner(&harness.client).await).is_none());
}

#[tokio::test]
async fn the_status_check_has_its_own_budget() {
    let harness = setup().await;
    for _ in 0..120 {
        let response = harness
            .client
            .get("/v1/operator_sessions/status", &[])
            .await;
        assert_eq!(response.status, StatusCode::OK);
    }
    assert_rate_limited(
        &harness
            .client
            .get("/v1/operator_sessions/status", &[])
            .await,
    );
    // Other routes keep their own budgets.
    assert_eq!(
        harness
            .client
            .post("/v1/operator_sessions/from_user", None, &[])
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn cross_origin_requests_do_not_spend_the_budget() {
    let harness = setup().await;
    for _ in 0..30 {
        let forged = harness
            .client
            .post(
                "/v1/operator_sessions/from_user",
                None,
                &[("origin", "https://evil.example")],
            )
            .await;
        assert_eq!(forged.status, StatusCode::FORBIDDEN);
    }
    let own = harness
        .client
        .post("/v1/operator_sessions/from_user", None, &[])
        .await;
    assert_eq!(own.status, StatusCode::UNAUTHORIZED, "{}", own.text());
}

#[tokio::test]
async fn the_rate_limiting_setting_turns_the_budgets_off() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({ "security": { "rateLimitEnabled": false } }))
        .await
        .expect("settings");
    for _ in 0..25 {
        let response = harness
            .client
            .post("/v1/operator_sessions/from_user", None, &[])
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    }
}
