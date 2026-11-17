//! Rollback tests for OIDC API-key and OAuth-application mutations.

mod common;

use axum::http::StatusCode;
use common::{harness, insert_user};

async fn fail_event_inserts(state: &orbitid_core::AppState) {
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

#[tokio::test]
async fn api_key_creation_rolls_back_when_its_event_cannot_be_written() {
    let h = harness().await;
    let browser = insert_user(&h, "key-rollback@example.com").await;
    fail_event_inserts(h.state()).await;

    let response = h
        .post(
            "/v1/api_keys",
            serde_json::json!({ "name": "CI", "subject": browser.user.id }),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE subject = $1")
        .bind(&browser.user.id)
        .fetch_one(&h.state().pool)
        .await
        .expect("keys");
    assert_eq!(keys, 0, "the key insert must roll back with its event");
}

#[tokio::test]
async fn oauth_application_delete_rolls_back_when_grant_revocation_fails() {
    let h = harness().await;
    let browser = insert_user(&h, "app-delete@example.com").await;
    let app = h.create_app(serde_json::json!({})).await;
    let app_id = app["id"].as_str().expect("app id").to_string();
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO oauth_grants \
         (id, kind, application_id, user_id, token_hash, scopes, expires_at, created_at) \
         VALUES ('grant_delete', 'refresh', $1, $2, 'hash_delete', 'openid', $3, $3)",
    )
    .bind(&app_id)
    .bind(&browser.user.id)
    .bind(now + 3_600_000)
    .execute(&h.state().pool)
    .await
    .expect("grant");
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_grant_update() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected grant failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&h.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_grant_update BEFORE UPDATE ON oauth_grants \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_grant_update()",
    )
    .execute(&h.state().pool)
    .await
    .expect("trigger");

    let deleted = h.delete(&format!("/v1/oauth_applications/{app_id}")).await;
    assert_eq!(deleted.status, StatusCode::INTERNAL_SERVER_ERROR);
    let still_there: Option<String> =
        sqlx::query_scalar("SELECT id FROM oauth_applications WHERE id = $1")
            .bind(&app_id)
            .fetch_optional(&h.state().pool)
            .await
            .expect("app");
    assert!(
        still_there.is_some(),
        "the application must survive a rolled-back delete"
    );
    let revoked: bool =
        sqlx::query_scalar("SELECT revoked FROM oauth_grants WHERE id = 'grant_delete'")
            .fetch_one(&h.state().pool)
            .await
            .expect("grant");
    assert!(!revoked);
}

#[tokio::test]
async fn consent_is_not_recorded_when_the_code_insert_fails() {
    let h = harness().await;
    let browser = insert_user(&h, "consent-rollback@example.com").await;
    let app = h
        .create_app(serde_json::json!({
            "consent_screen_enabled": true,
            "redirect_uris": [common::REDIRECT_URI],
        }))
        .await;
    let app_id = app["id"].as_str().expect("app id").to_string();
    let client_id = app["client_id"].as_str().expect("client id").to_string();
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_grant() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected grant failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&h.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_grant BEFORE INSERT ON oauth_grants \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_grant()",
    )
    .execute(&h.state().pool)
    .await
    .expect("trigger");

    let response = browser
        .client
        .post(
            "/oauth/consent",
            Some(serde_json::json!({
                "client_id": client_id,
                "approve": true,
                "scope": "openid email",
                "redirect_uri": common::REDIRECT_URI,
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    let consents: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM oauth_consents WHERE application_id = $1")
            .bind(&app_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("consents");
    assert_eq!(
        consents, 0,
        "consent must roll back with the failed code insert"
    );
}
