//! Rollback coverage for the session re-verification and magic-link paths.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::testing::TestClient;
use orbitid_core::AppState;
use orbitid_platform::mail::{latest_code_for, EmailTemplate};
use serde_json::json;

async fn fail_webhook_events(state: &AppState) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

async fn fail_session_updates(state: &AppState) {
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_session_update() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected session update failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_session_update BEFORE UPDATE ON sessions \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_session_update()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

async fn session_id_of(h: &Harness) -> String {
    h.client.get("/v1/client", &[]).await.value()["response"]["sessions"][0]["id"]
        .as_str()
        .expect("session id")
        .to_string()
}

/// Drives a reset-password sign-in up to `needs_new_password` and returns the
/// sign-in id.
async fn start_password_reset(h: &Harness, client: &TestClient, email: &str) -> String {
    let created = client
        .post(
            "/v1/client/sign_ins",
            Some(json!({
                "identifier": email,
                "strategy": "reset_password_email_code",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let sign_in_id = created.value()["response"]["id"]
        .as_str()
        .expect("sign-in id")
        .to_string();
    let prepared = client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = latest_code_for(h.state(), email, Some(EmailTemplate::ResetPasswordCode))
        .expect("reset code");
    let verified = client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(verified.value()["response"]["status"], "needs_new_password");
    sign_in_id
}

#[tokio::test]
async fn signing_out_of_every_session_rolls_back_when_its_events_cannot_be_written() {
    let h = harness().await;
    seed_user(&h, "signout-all@example.com", "Sup3r-secret!").await;
    password_sign_in(&h, "signout-all@example.com", "Sup3r-secret!").await;
    fail_webhook_events(h.state()).await;

    let response = h.client.delete("/v1/client", None, &[]).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let active: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE status IN ('active','pending')")
            .fetch_one(&h.state().pool)
            .await
            .expect("sessions");
    assert_eq!(active, 1, "the sign-out must roll back with its events");
}

#[tokio::test]
async fn second_factor_reverification_does_not_consume_the_step_when_the_session_write_fails() {
    let h = harness().await;
    let user = seed_user(&h, "reverify-atomic@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .expect("totp");
    let sign_in = password_sign_in(&h, "reverify-atomic@example.com", "Sup3r-secret!").await;
    let sign_in_id = sign_in["id"].as_str().expect("sign-in id").to_string();
    let code =
        orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000).expect("totp");
    let done = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(json!({ "strategy": "totp", "code": code })),
            &[],
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    let session_id = session_id_of(&h).await;
    let step_before: Option<i64> =
        sqlx::query_scalar("SELECT totp_last_used_step FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&h.state().pool)
            .await
            .expect("step");
    fail_session_updates(h.state()).await;
    let next = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000 + 30)
        .expect("totp");
    let response = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_second_factor"),
            Some(json!({ "strategy": "totp", "code": next })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let step_after: Option<i64> =
        sqlx::query_scalar("SELECT totp_last_used_step FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&h.state().pool)
            .await
            .expect("step");
    assert_eq!(
        step_after, step_before,
        "a failed session write must not consume the TOTP step"
    );
}

#[tokio::test]
async fn password_reset_rolls_back_when_its_revocation_fails() {
    let h = harness().await;
    let user = seed_user(&h, "reset-atomic@example.com", "Sup3r-secret!").await;
    // A second browser's live session is exactly what the reset must revoke;
    // the injected failure below makes that revocation fail after the password
    // write, so only a same-transaction rollback keeps the old password alive.
    let other = h.other_browser();
    let other_sign_in = other
        .post(
            "/v1/client/sign_ins",
            Some(json!({
                "identifier": "reset-atomic@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(
        other_sign_in.status,
        StatusCode::OK,
        "{}",
        other_sign_in.text()
    );
    let old_session: String = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE user_id = $1 AND status = 'active' LIMIT 1",
    )
    .bind(&user.user.id)
    .fetch_one(&h.state().pool)
    .await
    .expect("old session");
    let sign_in_id = start_password_reset(&h, &h.client, "reset-atomic@example.com").await;
    let hash_before: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&h.state().pool)
            .await
            .expect("hash");

    fail_session_updates(h.state()).await;
    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/reset_password"),
            Some(json!({ "password": "An0ther-secret!" })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::INTERNAL_SERVER_ERROR);

    let hash_after: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&h.state().pool)
            .await
            .expect("hash");
    assert_eq!(
        hash_after, hash_before,
        "a failed revocation must roll the password update back"
    );
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_at FROM verifications WHERE owner_id = $1")
            .bind(&sign_in_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("verification");
    assert!(consumed.is_none(), "the reset code must stay unconsumed");
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&old_session)
        .fetch_one(&h.state().pool)
        .await
        .expect("session");
    assert_eq!(
        status, "active",
        "the existing session must survive the rollback"
    );
}

#[tokio::test]
async fn magic_link_stays_unconsumed_when_the_sign_in_transition_fails() {
    let h = harness().await;
    seed_user(&h, "link-atomic@example.com", "Sup3r-secret!").await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "link-atomic@example.com" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("sign-in id")
        .to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(json!({ "strategy": "email_link" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let link = orbitid_platform::mail::latest_link_for(h.state(), "link-atomic@example.com")
        .expect("link");
    let token = url::Url::parse(&link)
        .expect("url")
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .expect("token");
    fail_webhook_events(h.state()).await;
    let response = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert_eq!(response.status, StatusCode::FOUND);
    let location = response
        .headers
        .get("location")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        location.contains("failed"),
        "expected failed redirect, got {location}"
    );
    let consumed: Option<i64> =
        sqlx::query_scalar("SELECT consumed_at FROM verifications WHERE owner_id = $1")
            .bind(&id)
            .fetch_one(&h.state().pool)
            .await
            .expect("verification");
    assert!(
        consumed.is_none(),
        "the link must stay usable after a rolled-back transition"
    );
}
