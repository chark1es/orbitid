//! Ported from the retired TypeScript test suite.

mod common;

use axum::http::StatusCode;
use serde_json::json;

use common::setup;

#[tokio::test]
async fn refuses_to_create_sign_in_or_actor_tokens() {
    let harness = setup().await;
    let user = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["tokens@example.com"], "password": "Sup3r-secret!" }),
        )
        .await
        .value();
    let user_id = user["id"].as_str().unwrap().to_string();

    let requests: Vec<(&str, Option<serde_json::Value>)> = vec![
        ("/v1/sign_in_tokens", Some(json!({ "user_id": user_id }))),
        ("/v1/sign_in_tokens/sit_whatever/revoke", None),
        (
            "/v1/actor_tokens",
            Some(json!({ "user_id": user_id, "actor": { "sub": "user_admin" } })),
        ),
        ("/v1/actor_tokens/act_whatever/revoke", None),
    ];
    for (path, body) in requests {
        let response = harness.client.post(path, body, common::bearer()).await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{path}");
        let payload = response.value();
        assert_eq!(payload["errors"][0]["code"], json!("not_allowed_access"));
        assert!(
            payload["errors"][0]["message"]
                .as_str()
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains("impersonation"),
            "{path}"
        );
    }

    let sign_in_tokens: i64 = sqlx::query_scalar("SELECT count(*) FROM sign_in_tokens")
        .fetch_one(&harness.state().pool)
        .await
        .expect("count");
    let actor_tokens: i64 = sqlx::query_scalar("SELECT count(*) FROM actor_tokens")
        .fetch_one(&harness.state().pool)
        .await
        .expect("count");
    assert_eq!(sign_in_tokens, 0);
    assert_eq!(actor_tokens, 0);
}

#[tokio::test]
async fn still_requires_the_secret_key() {
    let harness = setup().await;
    let response = harness
        .client
        .post(
            "/v1/sign_in_tokens",
            Some(json!({ "user_id": "user_1" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}
