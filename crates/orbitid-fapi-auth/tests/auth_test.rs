//! Ported from `test/core/{auth,client-cookie-renewal,sessions,handshake}.test.ts`
//! (the parts that exercise the Frontend API routes).

mod common;

use axum::http::StatusCode;
use common::{harness, password_sign_in, seed_user};

#[tokio::test]
async fn environment_is_public_and_secret_free() {
    let h = harness().await;
    let response = h.client.get("/v1/client/environment", &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.headers.get("cache-control").unwrap(),
        "public, max-age=60"
    );
    let value = response.value();
    assert_eq!(value["object"], "environment");
    assert_eq!(value["auth_config"]["first_factors"][0], "email_code");
    assert!(
        value["user_settings"]["attributes"]["email_address"]["enabled"]
            .as_bool()
            .unwrap()
    );
    assert!(value.get("display_config").is_some());
}

#[tokio::test]
async fn client_bootstrap_creates_a_cookie_and_hides_finished_attempts() {
    let h = harness().await;
    let response = h.client.get("/v1/client", &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    let value = response.value();
    assert_eq!(value["response"]["object"], "client");
    assert_eq!(value["response"]["sign_in"], serde_json::Value::Null);
    assert!(h.client.cookie_header().unwrap().contains("__client="));

    // The same cookie reuses the same client row.
    let first_id = value["response"]["id"].as_str().unwrap().to_string();
    let again = h.client.get("/v1/client", &[]).await;
    assert_eq!(again.value()["response"]["id"], first_id);
}

#[tokio::test]
async fn password_sign_in_completes_a_session() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "user@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "complete");
    assert!(sign_in["created_session_id"].is_string());
    assert_eq!(sign_in["identifier"], "user@example.com");

    let client = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
    assert!(client["response"]["sign_in"].is_null());
    let session = &client["response"]["sessions"][0];
    assert_eq!(session["status"], "active");
    assert_eq!(session["sign_in_method"], "password");
    assert!(session["last_active_token"]["jwt"].is_string());
}

#[tokio::test]
async fn wrong_password_is_a_form_error_and_records_an_attempt() {
    let h = harness().await;
    let user = seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "user@example.com",
                "password": "wrong-password",
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response.error_codes(),
        vec!["form_password_incorrect".to_string()]
    );
    let row: (i64,) = sqlx::query_as("SELECT failed_attempts FROM users WHERE id = $1")
        .bind(&user.user.id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(row.0, 1);
}

#[tokio::test]
async fn unknown_identifier_returns_two_error_items() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({ "security": { "enumerationProtection": false } }))
        .await
        .unwrap();
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "nobody@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    let value = response.value();
    let errors = value["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0]["code"], "form_identifier_not_found");
}

/// Creates a sign-in for `identifier` on a fresh client and returns its response body.
async fn start_sign_in(h: &common::Harness, identifier: &str) -> serde_json::Value {
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": identifier })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["response"].clone()
}

fn strategies(sign_in: &serde_json::Value) -> Vec<String> {
    sign_in["supported_first_factors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|factor| factor["strategy"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn enumeration_protection_is_on_by_default() {
    let h = harness().await;
    assert!(h.state().settings.get().security.enumeration_protection);
}

#[tokio::test]
async fn enumeration_protection_answers_an_unknown_identifier_like_an_account() {
    let h = harness().await;
    seed_user(&h, "real@example.com", "Sup3r-secret!").await;

    // One sign-in per client at a time: each is attempted before the next starts.
    let attempt = |id: String, password: &'static str| {
        let client = &h.client;
        async move {
            client
                .post(
                    &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
                    Some(serde_json::json!({ "strategy": "password", "password": password })),
                    &[],
                )
                .await
        }
    };
    let real = start_sign_in(&h, "real@example.com").await;
    let wrong = attempt(real["id"].as_str().unwrap().to_string(), "not-it-at-all").await;
    let decoy = start_sign_in(&h, "nobody@example.com").await;
    assert_eq!(decoy["status"], "needs_first_factor");
    assert_eq!(decoy["status"], real["status"]);
    assert_eq!(strategies(&decoy), strategies(&real));
    assert!(strategies(&decoy).contains(&"password".to_string()));
    assert_eq!(
        decoy["supported_first_factors"][0]["safe_identifier"],
        "n*****@example.com"
    );
    // A real account's name is not shown before the first factor either.
    assert!(real["user_data"].is_null());
    assert!(decoy["user_data"].is_null());
    assert_eq!(decoy["identifier"], "nobody@example.com");

    // A password fails exactly as a wrong one on a real account does.
    let decoy_attempt = attempt(decoy["id"].as_str().unwrap().to_string(), "Sup3r-secret!").await;
    assert_eq!(decoy_attempt.status, wrong.status);
    assert_eq!(decoy_attempt.status, StatusCode::UNPROCESSABLE_ENTITY);
    let (wrong, decoy_attempt) = (wrong.value(), decoy_attempt.value());
    assert_eq!(
        decoy_attempt["errors"][0]["code"],
        "form_password_incorrect"
    );
    assert_eq!(
        decoy_attempt["errors"][0]["code"],
        wrong["errors"][0]["code"]
    );
    assert_eq!(
        decoy_attempt["errors"][0]["message"],
        wrong["errors"][0]["message"]
    );

    // Identifier and password in one request: the same refusal.
    let combined = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "nobody@example.com", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_eq!(combined.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        combined.value()["errors"][0]["code"],
        "form_password_incorrect"
    );
}

#[tokio::test]
async fn enumeration_protection_issues_a_code_it_never_sends_or_accepts() {
    let h = harness().await;
    let decoy = start_sign_in(&h, "nobody@example.com").await;
    let id = decoy["id"].as_str().unwrap().to_string();
    let email_id = decoy["supported_first_factors"][0]["email_address_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(email_id.starts_with("idn_e"));

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "email_address_id": email_id })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let prepared = prepared.value()["response"].clone();
    assert_eq!(
        prepared["first_factor_verification"]["strategy"],
        "email_code"
    );
    assert_eq!(
        prepared["first_factor_verification"]["status"],
        "unverified"
    );
    assert!(prepared["first_factor_verification"]["expire_at"].is_number());
    // The same made-up email id on every read.
    assert_eq!(
        prepared["supported_first_factors"][0]["email_address_id"],
        email_id
    );

    assert!(
        orbitid_platform::mail::get_mail_outbox(h.state()).is_empty(),
        "a decoy sends no email"
    );

    // Not even the fixed testing code signs in.
    for code in ["424242", "000000"] {
        let attempt = h
            .client
            .post(
                &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
                Some(serde_json::json!({ "strategy": "email_code", "code": code })),
                &[],
            )
            .await;
        assert_eq!(attempt.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(attempt.value()["errors"][0]["code"], "form_code_incorrect");
    }
}

#[tokio::test]
async fn session_tokens_and_end_session() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "user@example.com", "Sup3r-secret!").await;
    let session_id = sign_in["created_session_id"].as_str().unwrap().to_string();

    let sessions = h.client.get("/v1/client/sessions", &[]).await;
    assert_eq!(sessions.status, StatusCode::OK);
    assert_eq!(sessions.value()["response"][0]["id"], session_id);

    let token = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/tokens"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(token.status, StatusCode::OK);
    assert!(token.value()["jwt"].as_str().unwrap().split('.').count() == 3);

    let ended = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/end"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(ended.status, StatusCode::OK);
    assert_eq!(ended.value()["response"]["status"], "ended");
}

#[tokio::test]
async fn handshake_reports_signed_out_then_mints_a_token() {
    let h = harness().await;
    let response = h
        .client
        .get(
            "/v1/client/handshake?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fpage",
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let location = response.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_handshake=signed_out"),
        "{location}"
    );
    assert_eq!(response.headers.get("cache-control").unwrap(), "no-store");

    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    password_sign_in(&h, "user@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .get(
            "/v1/client/handshake?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fpage",
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let location = response.headers.get("location").unwrap().to_str().unwrap();
    assert!(location.contains("__orbit_handshake=ey"), "{location}");
}

#[tokio::test]
async fn handshake_requires_an_allowed_redirect_url() {
    let h = harness().await;
    let missing = h.client.get("/v1/client/handshake", &[]).await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    assert_eq!(missing.error_codes(), vec!["form_param_missing"]);

    let evil = h
        .client
        .get(
            "/v1/client/handshake?redirect_url=https%3A%2F%2Fevil.example%2Fpage",
            &[],
        )
        .await;
    assert_eq!(evil.status, StatusCode::BAD_REQUEST);
    assert_eq!(evil.error_codes(), vec!["form_param_format_invalid"]);
}

#[tokio::test]
async fn deleting_the_client_ends_sessions_and_clears_the_cookie() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    password_sign_in(&h, "user@example.com", "Sup3r-secret!").await;
    let response = h.client.request("DELETE", "/v1/client", None, &[]).await;
    assert_eq!(response.status, StatusCode::OK);
    let sessions = response.value()["response"]["sessions"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["status"], "removed");
    let set_cookie = response
        .headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(set_cookie.contains("__client=;"), "{set_cookie}");
}

#[tokio::test]
async fn stale_client_tokens_are_refused_outside_the_bootstrap() {
    let h = harness().await;
    // A cookie that names no row.
    let client = h.other_browser();
    let response = client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "nobody@example.com" })),
            &[("cookie", "__client=not-a-real-token")],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.error_codes(), vec!["client_state_invalid"]);
}

#[tokio::test]
async fn frontend_api_accepts_urlencoded_bodies() {
    let h = harness().await;
    seed_user(&h, "form@example.com", "Sup3r-secret!").await;
    h.client.get("/v1/client", &[]).await;
    let cookie = h.client.cookie_header();
    let response = common::raw_form(
        h.state(),
        "/v1/client/sign_ins",
        cookie.as_deref(),
        &[
            ("identifier", "form@example.com"),
            ("password", "Sup3r-secret!"),
        ],
    )
    .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.value()["response"]["status"], "complete");
    assert!(response.value()["response"]["created_session_id"].is_string());
}

#[tokio::test]
async fn handshake_reports_a_signed_out_browser_after_the_session_ends() {
    let h = harness().await;
    seed_user(&h, "ended@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "ended@example.com", "Sup3r-secret!").await;
    let session_id = sign_in["created_session_id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sessions/{session_id}/end"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    let response = h
        .client
        .get(
            "/v1/client/handshake?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fpage",
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let location = response.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_handshake=signed_out"),
        "{location}"
    );
}
