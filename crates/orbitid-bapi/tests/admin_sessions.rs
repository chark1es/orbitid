//! Ported from the retired TypeScript test suite.

mod common;

use axum::http::StatusCode;
use serde_json::json;

use common::{error_code, setup, Harness};

async fn create_user(harness: &Harness) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [format!("session-{n}@example.com")], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

async fn session_jwt(harness: &Harness, session_id: &str) -> String {
    orbitid_identity::tokens::sign_session_token(
        harness.state(),
        session_id,
        orbitid_identity::tokens::SignSessionTokenOptions {
            template: None,
            azp: None,
        },
    )
    .await
    .expect("sign session token")
}

#[tokio::test]
async fn lists_reads_and_revokes_sessions_and_refuses_to_assert_factors() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    let other = create_user(&harness).await;
    let first = harness.create_session(&user).await;
    let second = harness.create_session_with(&user, "revoked").await;
    let other_session = harness.create_session(&other).await;

    let list = harness.get(&format!("/v1/sessions?user_id={user}")).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.text());
    assert_eq!(list.value()["total_count"], json!(2));
    assert!(list.value()["data"]
        .as_array()
        .unwrap()
        .iter()
        .all(|session| session["public_user_data"]["user_id"] == json!(user)));

    let active = harness
        .get(&format!("/v1/sessions?user_id={user}&status=active"))
        .await;
    assert_eq!(
        active.value()["data"][0]["id"].as_str(),
        Some(first.session_id.as_str())
    );
    let by_client = harness
        .get(&format!("/v1/sessions?client_id={}", second.client_id))
        .await;
    assert_eq!(
        by_client.value()["data"][0]["id"].as_str(),
        Some(second.session_id.as_str())
    );

    let detail = harness
        .get(&format!("/v1/sessions/{}", first.session_id))
        .await;
    assert_eq!(detail.value()["object"], json!("session"));
    assert_eq!(detail.value()["status"], json!("active"));
    assert_eq!(detail.value()["user"]["id"], json!(user));
    assert_eq!(detail.value()["factor_verification_age"], json!([-1, -1]));
    assert_eq!(
        harness.get("/v1/sessions/sess_nope").await.status,
        StatusCode::NOT_FOUND
    );

    let verified = harness
        .post_empty(&format!("/v1/sessions/{}/verify", first.session_id))
        .await;
    assert_eq!(verified.status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&verified).as_deref(), Some("not_allowed_access"));
    let unchanged = harness
        .get(&format!("/v1/sessions/{}", first.session_id))
        .await;
    assert_eq!(
        unchanged.value()["factor_verification_age"],
        json!([-1, -1])
    );

    let revoked = harness
        .post_empty(&format!("/v1/sessions/{}/revoke", second.session_id))
        .await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.text());
    assert_eq!(revoked.value()["status"], json!("revoked"));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&harness.state().pool)
        .await
        .expect("count sessions");
    assert_eq!(count, 3);
    assert!(!other_session.session_id.is_empty());
}

#[tokio::test]
async fn mints_session_tokens_only_for_a_caller_holding_that_session_token() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    let other = create_user(&harness).await;
    let session = harness.create_session(&user).await;
    let other_session = harness.create_session(&other).await;
    harness
        .post(
            "/v1/jwt_templates",
            json!({ "name": "with-email", "claims": { "email": "{{user.primary_email_address}}" } }),
        )
        .await;

    let no_proof = harness
        .post_empty(&format!("/v1/sessions/{}/tokens", session.session_id))
        .await;
    assert_eq!(no_proof.status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&no_proof).as_deref(), Some("not_allowed_access"));

    let other_jwt = session_jwt(&harness, &other_session.session_id).await;
    let wrong = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens", session.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", &other_jwt),
            ],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::FORBIDDEN);

    let proved = session_jwt(&harness, &session.session_id).await;
    let plain = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens", session.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", &proved),
            ],
        )
        .await;
    assert_eq!(plain.status, StatusCode::OK, "{}", plain.text());
    assert_eq!(plain.value()["object"], json!("token"));
    assert!(plain.value()["jwt"]
        .as_str()
        .map(|jwt| !jwt.is_empty())
        .unwrap_or(false));

    let templated = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens/with-email", session.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", &proved),
            ],
        )
        .await;
    assert_eq!(templated.status, StatusCode::OK, "{}", templated.text());
    assert!(templated.value()["jwt"].is_string());

    let missing = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens/missing", session.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", &proved),
            ],
        )
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);

    let forged = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens", session.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", "not.a.jwt"),
            ],
        )
        .await;
    assert_eq!(forged.status, StatusCode::FORBIDDEN);

    // `sign_session_token` refuses an inactive session, so sign while active
    // (the TS helper signs arbitrary claims) and then end it.
    let ended = harness.create_session(&user).await;
    let ended_jwt = session_jwt(&harness, &ended.session_id).await;
    sqlx::query("UPDATE sessions SET status = 'ended' WHERE id = $1")
        .bind(&ended.session_id)
        .execute(&harness.state().pool)
        .await
        .expect("end session");
    let inactive = harness
        .client
        .post(
            &format!("/v1/sessions/{}/tokens", ended.session_id),
            None,
            &[
                ("authorization", "Bearer sk_test_testsecret"),
                ("x-orbitid-session-token", &ended_jwt),
            ],
        )
        .await;
    assert_eq!(inactive.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error_code(&inactive).as_deref(),
        Some("authentication_invalid")
    );
}

#[tokio::test]
async fn exposes_clients_by_id_and_cookie_token_without_handing_out_session_jwts() {
    let harness = setup().await;
    let user = create_user(&harness).await;
    let fixture = harness.create_session(&user).await;

    let client = harness
        .get(&format!("/v1/clients/{}", fixture.client_id))
        .await;
    assert_eq!(client.status, StatusCode::OK, "{}", client.text());
    assert_eq!(client.value()["object"], json!("client"));
    assert_eq!(
        client.value()["sessions"][0]["id"].as_str(),
        Some(fixture.session_id.as_str())
    );
    assert_eq!(
        client.value()["sessions"][0]["last_active_token"],
        serde_json::Value::Null
    );

    let verified = harness
        .post("/v1/clients/verify", json!({ "token": fixture.token }))
        .await;
    assert_eq!(verified.status, StatusCode::OK);
    assert_eq!(verified.value()["id"], json!(fixture.client_id));
    assert_eq!(
        verified.value()["sessions"][0]["last_active_token"],
        serde_json::Value::Null
    );

    assert_eq!(
        harness
            .post("/v1/clients/verify", json!({ "token": "nope" }))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        harness.get("/v1/clients/client_nope").await.status,
        StatusCode::NOT_FOUND
    );
}
