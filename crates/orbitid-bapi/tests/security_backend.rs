//! Ported Backend API parts of `test/security/{injection,limits,council-readiness,handoff-review}.test.ts`.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

async fn create_user(harness: &Harness, body: Value) -> Value {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut body = body;
    let object = body.as_object_mut().expect("object body");
    if !object.contains_key("email_address") {
        object.insert(
            "email_address".into(),
            json!([format!("security-{n}@example.com")]),
        );
    }
    if !object.contains_key("password") {
        object.insert("password".into(), json!("Sup3r-secret!"));
    }
    let response = harness.post("/v1/users", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

fn first_names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["first_name"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn falls_back_to_the_default_order_for_unknown_order_by() {
    let harness = setup().await;
    create_user(&harness, json!({ "first_name": "Ada" })).await;
    for order_by in [
        "created_at; drop table users",
        "users.password_hash desc",
        "(select 1)",
        "1=1 --",
        "id) --",
    ] {
        let encoded = order_by
            .replace(' ', "%20")
            .replace(';', "%3B")
            .replace('(', "%28")
            .replace(')', "%29")
            .replace('/', "%2F");
        let response = harness.get(&format!("/v1/users?order_by={encoded}")).await;
        assert_eq!(response.status, StatusCode::OK, "{order_by}");
        let count = harness.get("/v1/users/count").await;
        assert_eq!(count.value()["total_count"], json!(1), "{order_by}");
    }
}

#[tokio::test]
async fn accepts_a_whitelisted_order_by_and_direction() {
    let harness = setup().await;
    create_user(&harness, json!({ "first_name": "first" })).await;
    create_user(&harness, json!({ "first_name": "second" })).await;
    let asc = harness.get("/v1/users?order_by=%2Bcreated_at").await;
    let desc = harness.get("/v1/users?order_by=-created_at").await;
    assert_eq!(first_names(&asc.value()), vec!["first", "second"]);
    assert_eq!(first_names(&desc.value()), vec!["second", "first"]);
}

#[tokio::test]
async fn escapes_like_wildcards_in_search() {
    let harness = setup().await;
    create_user(&harness, json!({ "first_name": "100% legit" })).await;
    create_user(&harness, json!({ "first_name": "Ada" })).await;

    let literal = harness.get("/v1/users?query=%25").await;
    assert_eq!(first_names(&literal.value()), vec!["100% legit"]);
    let underscore = harness.get("/v1/users?query=Ada_").await;
    assert!(first_names(&underscore.value()).is_empty());
    let backslash = harness.get("/v1/users?query=Ada%5C").await;
    assert!(first_names(&backslash.value()).is_empty());
}

#[tokio::test]
async fn does_not_pollute_object_prototype_through_a_metadata_patch() {
    let harness = setup().await;
    let user = create_user(&harness, json!({})).await;
    let id = user["id"].as_str().unwrap();
    let response = harness
        .patch(
            &format!("/v1/users/{id}/metadata"),
            json!({ "public_metadata": { "__proto__": { "polluted": true }, "constructor": { "prototype": { "polluted": true } }, "ok": 1 } }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.value()["public_metadata"], json!({ "ok": 1 }));
}

#[tokio::test]
async fn caps_backend_pagination_and_refuses_query_string_keys() {
    let harness = setup().await;
    let too_big = harness.get("/v1/users?limit=100000").await;
    assert_eq!(too_big.status, StatusCode::UNPROCESSABLE_ENTITY);
    let negative = harness.get("/v1/users?offset=-5").await;
    assert_eq!(negative.status, StatusCode::UNPROCESSABLE_ENTITY);
    let query_key = harness
        .client
        .get("/v1/users?secret_key=sk_test_testsecret", &[])
        .await;
    assert_eq!(query_key.status, StatusCode::UNAUTHORIZED);
    let api_key = harness
        .client
        .get("/v1/users?api_key=sk_test_testsecret", &[])
        .await;
    assert_eq!(api_key.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn valid_traffic_does_not_consume_the_failed_guess_budget() {
    let harness = setup().await;
    for _ in 0..15 {
        let response = harness
            .client
            .get("/v1/users?limit=1", common::bearer())
            .await;
        assert_eq!(response.status, StatusCode::OK);
    }
    for _ in 0..10 {
        let response = harness
            .client
            .get(
                "/v1/users?limit=1",
                &[("authorization", "Bearer sk_test_wrong")],
            )
            .await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    }
    let blocked = harness
        .client
        .get("/v1/users?limit=1", common::bearer())
        .await;
    assert_eq!(
        blocked.status,
        StatusCode::TOO_MANY_REQUESTS,
        "{}",
        blocked.text()
    );
    assert_eq!(error_code(&blocked).as_deref(), Some("rate_limit_exceeded"));
}

#[tokio::test]
async fn operator_cookie_does_not_authenticate_application_origin_writes() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({
            "application": {
                "allowedOrigins": ["https://app.acme.example"],
                "developmentMode": false,
            }
        }))
        .await
        .expect("settings");
    let cookie = harness.console().await.cookie;

    let write = harness
        .client
        .post(
            "/v1/users",
            Some(json!({ "email_address": ["forbidden@example.com"] })),
            &[
                ("cookie", &cookie),
                ("origin", "https://app.acme.example"),
                ("sec-fetch-site", "same-site"),
            ],
        )
        .await;
    assert_eq!(write.status, StatusCode::FORBIDDEN, "{}", write.text());

    let allowed = harness
        .client
        .get("/v1/instance", &[("cookie", &cookie)])
        .await;
    assert_eq!(allowed.status, StatusCode::OK);
}
