//! Ported from `test/core/auth-factors-anonymous.test.ts` (the Frontend API
//! parts: creation, gating and environment exposure).

mod common;

use axum::http::StatusCode;
use common::{harness, Harness};

async fn enable_anonymous(h: &Harness) {
    h.state()
        .settings
        .update(serde_json::json!({ "anonymous": { "enabled": true } }))
        .await
        .unwrap();
}

async fn create_guest(h: &Harness) -> serde_json::Value {
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["response"].clone()
}

#[tokio::test]
async fn anonymous_sign_up_is_disabled_by_default() {
    let h = harness().await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.error_codes(), vec!["sign_up_restricted"]);
    assert_eq!(
        response.value()["errors"][0]["meta"]["param_name"],
        "strategy"
    );
}

#[tokio::test]
async fn a_guest_gets_no_identifiers_and_an_active_session() {
    let h = harness().await;
    enable_anonymous(&h).await;
    let created = create_guest(&h).await;
    assert_eq!(created["status"], "complete");
    assert!(created["created_session_id"]
        .as_str()
        .unwrap()
        .starts_with("sess_"));
    assert!(created["created_user_id"]
        .as_str()
        .unwrap()
        .starts_with("user_"));

    let client = h.client.get("/v1/client", &[]).await.value();
    let session = &client["response"]["sessions"][0];
    assert_eq!(session["status"], "active");
    let user = &session["user"];
    assert_eq!(user["is_anonymous"], true);
    assert!(user["email_addresses"].as_array().unwrap().is_empty());
    assert_eq!(user["password_enabled"], false);
}

#[tokio::test]
async fn anonymous_sign_up_requires_public_sign_ups_and_legal_consent() {
    let h = harness().await;
    enable_anonymous(&h).await;
    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "waitlist" } }))
        .await
        .unwrap();
    let waitlisted = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(waitlisted.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(waitlisted.error_codes(), vec!["sign_up_restricted"]);

    h.state()
        .settings
        .update(serde_json::json!({
            "signUp": { "mode": "public", "legalConsentRequired": true }
        }))
        .await
        .unwrap();
    let no_consent = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(no_consent.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(no_consent.error_codes(), vec!["form_param_missing"]);
    assert_eq!(
        no_consent.value()["errors"][0]["meta"]["param_name"],
        "legal_accepted"
    );

    let accepted = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "strategy": "anonymous",
                "legal_accepted": true,
            })),
            &[],
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
    assert_eq!(accepted.value()["response"]["status"], "complete");
    assert!(accepted.value()["response"]["legal_accepted_at"].is_number());
}

#[tokio::test]
async fn anonymous_sign_up_is_rate_limited_per_address() {
    let h = harness().await;
    enable_anonymous(&h).await;
    for _ in 0..10 {
        let response = h
            .client
            .post(
                "/v1/client/sign_ups",
                Some(serde_json::json!({ "strategy": "anonymous" })),
                &[],
            )
            .await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    }
    let blocked = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(blocked.error_codes(), vec!["rate_limit_exceeded"]);
    assert!(blocked.headers.contains_key("retry-after"));
}

#[tokio::test]
async fn environment_advertises_anonymous_only_when_enabled() {
    let h = harness().await;
    let off = h.client.get("/v1/client/environment", &[]).await;
    assert_eq!(off.value()["auth_config"]["anonymous"]["enabled"], false);
    enable_anonymous(&h).await;
    let on = h.client.get("/v1/client/environment", &[]).await;
    assert_eq!(on.value()["auth_config"]["anonymous"]["enabled"], true);
}
