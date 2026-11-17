mod common;

use axum::http::StatusCode;

use common::{setup, SECRET_KEY};

fn operator_cookie(response: &orbitid_core::testing::TestResponse) -> Option<String> {
    response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("__orbit_operator="))
        .map(str::to_string)
}

#[tokio::test]
async fn exchanges_the_secret_key_for_an_http_only_cookie() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    let body = response.value();
    assert_eq!(body["object"], "operator_session");
    assert!(body["id"].as_str().unwrap_or("").starts_with("osess_"));
    assert!(body["expires_at"].as_i64().unwrap_or(0) > orbitid_core::http::now());
    let raw = operator_cookie(&response).expect("operator cookie");
    let lower = raw.to_ascii_lowercase();
    assert!(lower.contains("httponly"));
    assert!(lower.contains("samesite=strict"));
    assert!(lower.contains("path=/v1"));
    assert!(!lower.contains("secure"));
    assert!(!raw.contains(SECRET_KEY));
}

#[tokio::test]
async fn refuses_the_wrong_key_and_never_sets_a_cookie() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": "sk_test_not_the_key" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        common::error_code(&response).as_deref(),
        Some("secret_key_invalid")
    );
    assert!(operator_cookie(&response).is_none());
}

#[tokio::test]
async fn refuses_cross_origin_exchanges() {
    let harness = setup().await;
    for origin in ["https://evil.example", "null"] {
        let response = harness
            .client
            .post(
                "/v1/operator_sessions",
                Some(serde_json::json!({ "secret_key": SECRET_KEY })),
                &[("origin", origin)],
            )
            .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{origin}");
        assert!(operator_cookie(&response).is_none());
    }
}

#[tokio::test]
async fn accepts_this_instances_own_origin() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[
                ("origin", "http://localhost:4000"),
                ("sec-fetch-site", "same-origin"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
}

#[tokio::test]
async fn the_cookie_authenticates_backend_reads_and_writes() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    let cookie = response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("__orbit_operator="))
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
        .expect("cookie pair");

    let read = harness.cookie("/v1/instance", &cookie).await;
    assert_eq!(read.status, StatusCode::OK);
    assert!(read.value()["publishable_key"]
        .as_str()
        .unwrap_or("")
        .starts_with("pk_test_"));

    let write = harness
        .client
        .post(
            "/v1/users",
            Some(serde_json::json!({
                "email_address": ["cookie-user@example.com"],
                "password": "Sup3r-secret!",
            })),
            &[("cookie", &cookie)],
        )
        .await;
    assert_eq!(write.status, StatusCode::OK);
}

#[tokio::test]
async fn current_reports_the_session_and_sign_out_revokes_it() {
    let harness = setup().await;
    harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    // The client jar stores the cookie from the exchange.
    let current = harness
        .client
        .get("/v1/operator_sessions/current", &[])
        .await;
    assert_eq!(current.status, StatusCode::OK);
    assert_eq!(current.value()["object"], "operator_session");

    let out = harness
        .client
        .delete("/v1/operator_sessions/current", None, &[])
        .await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    let cleared = out
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("__orbit_operator="))
        .map(str::to_string)
        .expect("cleared cookie");
    assert!(
        cleared.to_ascii_lowercase().contains("max-age=0")
            || cleared.contains("Expires=Thu, 01 Jan 1970"),
        "{cleared}"
    );
    // The jar dropped the cookie; the API is refused again.
    let denied = harness.client.get("/v1/instance", &[]).await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_cookie_stays_on_this_origin() {
    let harness = setup().await;
    harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    for origin in ["https://evil.example", "null"] {
        let read = harness
            .client
            .get("/v1/instance", &[("origin", origin)])
            .await;
        assert_eq!(read.status, StatusCode::FORBIDDEN, "{origin}");
    }
    let cross_site = harness
        .client
        .get("/v1/users", &[("sec-fetch-site", "cross-site")])
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

async fn cookie_from(harness: &common::Harness) -> String {
    let response = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with("__orbit_operator="))
        .and_then(|value| value.split(';').next())
        .map(str::to_string)
        .expect("cookie")
}

#[tokio::test]
async fn adds_secure_when_the_instance_is_served_over_https() {
    let app = orbitid_identity::testing::test_app_state_with(orbitid_core::config::EnvOverrides {
        base_url: Some("https://auth.example.com".into()),
        ..Default::default()
    })
    .await;
    let client = orbitid_core::testing::TestClient::new(common::build_app(app.state()));
    let response = client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::CREATED);
    let raw = operator_cookie(&response).expect("cookie");
    assert!(raw
        .to_ascii_lowercase()
        .split(';')
        .any(|part| part.trim() == "secure"));
}

#[tokio::test]
async fn locks_out_the_key_after_the_failure_budget() {
    let harness = setup().await;
    let mut statuses = Vec::new();
    for index in 0..14 {
        let response = harness
            .client
            .post(
                "/v1/operator_sessions",
                Some(serde_json::json!({ "secret_key": format!("sk_test_wrong_{index}") })),
                &[],
            )
            .await;
        statuses.push(response.status);
    }
    assert!(statuses.contains(&StatusCode::UNAUTHORIZED));
    assert!(statuses.contains(&StatusCode::TOO_MANY_REQUESTS));
    let correct = harness
        .client
        .post(
            "/v1/operator_sessions",
            Some(serde_json::json!({ "secret_key": SECRET_KEY })),
            &[],
        )
        .await;
    assert_eq!(correct.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn applies_the_origin_rule_to_current_and_sign_out() {
    let harness = setup().await;
    let cookie = cookie_from(&harness).await;
    for origin in ["https://evil.example", "null"] {
        let read = harness
            .client
            .get(
                "/v1/operator_sessions/current",
                &[("cookie", &cookie), ("origin", origin)],
            )
            .await;
        assert_eq!(read.status, StatusCode::FORBIDDEN, "{origin}");
        let delete = harness
            .client
            .delete(
                "/v1/operator_sessions/current",
                None,
                &[("cookie", &cookie), ("origin", origin)],
            )
            .await;
        assert_eq!(delete.status, StatusCode::FORBIDDEN, "{origin}");
    }
    assert_eq!(
        harness.cookie("/v1/instance", &cookie).await.status,
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
    let cookie = cookie_from(&harness).await;
    sqlx::query("UPDATE operator_sessions SET expires_at = $1")
        .bind(orbitid_core::http::now() - 1)
        .execute(&harness.state().pool)
        .await
        .expect("expire");
    assert_eq!(
        harness.cookie("/v1/instance", &cookie).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn stores_only_a_hash_and_the_key_fingerprint() {
    let harness = setup().await;
    let cookie = cookie_from(&harness).await;
    let token = cookie.trim_start_matches("__orbit_operator=");
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT token_hash, key_fingerprint FROM operator_sessions")
            .fetch_all(&harness.state().pool)
            .await
            .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_ne!(rows[0].0, token);
    assert!(!rows[0].0.contains(token));
    assert_eq!(
        rows[0].1,
        orbitid_identity::operator_session::key_fingerprint(SECRET_KEY)
    );
}

#[tokio::test]
async fn an_explicit_refused_origin_is_not_overridden_by_a_trusted_referer() {
    let harness = setup().await;
    let cookie = cookie_from(&harness).await;
    let response = harness
        .client
        .get(
            "/v1/instance",
            &[
                ("cookie", &cookie),
                ("origin", "https://evil.example"),
                ("referer", "http://localhost:4000/users"),
            ],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
}
