//! Ported from the retired TypeScript test suite (CRUD) and
//! `jwt-custom-key.test.ts` (template key management). The shortcode renderer
//! lives in `orbitid-credentials` and is covered by its own unit tests.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup};

async fn create_template(harness: &common::Harness, body: Value) -> Value {
    let response = harness.post("/v1/jwt_templates", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

#[tokio::test]
async fn creates_lists_updates_and_deletes_templates() {
    let harness = setup().await;
    let created = create_template(
        &harness,
        json!({
            "name": "hasura",
            "claims": { "https://hasura.io/jwt/claims": { "x-hasura-user-id": "{{user.id}}" } },
        }),
    )
    .await;
    assert_eq!(created["object"], json!("jwt_template"));
    assert_eq!(created["name"], json!("hasura"));
    assert_eq!(created["lifetime"], json!(60));
    assert_eq!(created["allowed_clock_skew"], json!(5));
    assert_eq!(created["custom_signing_key"], json!(false));
    assert_eq!(created["signing_algorithm"], json!("RS256"));
    assert!(created.get("signing_key").is_none() || created["signing_key"].is_null());

    let stored: Option<String> =
        sqlx::query_scalar("SELECT signing_key_enc FROM jwt_templates WHERE id = $1")
            .bind(created["id"].as_str().unwrap())
            .fetch_one(&harness.state().pool)
            .await
            .expect("row");
    assert_eq!(stored, None);

    assert_eq!(
        harness
            .post("/v1/jwt_templates", json!({ "name": "hasura" }))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness.get("/v1/jwt_templates").await.value()["total_count"],
        json!(1)
    );
    assert_eq!(
        harness
            .get(&format!(
                "/v1/jwt_templates/{}",
                created["id"].as_str().unwrap()
            ))
            .await
            .value()["name"],
        json!("hasura")
    );

    let updated = harness
        .patch(
            &format!("/v1/jwt_templates/{}", created["id"].as_str().unwrap()),
            json!({ "lifetime": 300, "claims": { "sub2": "{{user.username}}" } }),
        )
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text());
    assert_eq!(updated.value()["lifetime"], json!(300));
    assert_eq!(
        updated.value()["claims"],
        json!({ "sub2": "{{user.username}}" })
    );

    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(
        harness
            .delete(&format!("/v1/jwt_templates/{id}"))
            .await
            .value(),
        json!({ "object": "jwt_template", "id": id, "deleted": true })
    );
    assert_eq!(
        harness.get(&format!("/v1/jwt_templates/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn rejects_reserved_claims_and_out_of_range_options() {
    let harness = setup().await;
    for claim in [
        "sub",
        "iss",
        "exp",
        "azp",
        "sid",
        "act",
        "org_id",
        "org_role",
        "org_permissions",
        "roles",
        "role_permissions",
        "fva",
        "sts",
        "anonymous",
        "token_type",
    ] {
        let response = harness
            .post(
                "/v1/jwt_templates",
                json!({ "name": format!("t-{claim}"), "claims": { claim: "x" } }),
            )
            .await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{claim}");
        assert_eq!(
            error_code(&response).as_deref(),
            Some("form_param_value_invalid"),
            "{claim}"
        );
    }
    assert_eq!(
        harness
            .post(
                "/v1/jwt_templates",
                json!({ "name": "short", "lifetime": 10 })
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .post(
                "/v1/jwt_templates",
                json!({ "name": "long", "lifetime": 315_360_001 }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .post(
                "/v1/jwt_templates",
                json!({ "name": "skew", "allowed_clock_skew": 301 }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .post("/v1/jwt_templates", json!({ "name": "bad name!" }))
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .post(
                "/v1/jwt_templates",
                json!({ "name": "vectors", "claims": [] })
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn changes_only_the_fields_a_patch_sends() {
    let harness = setup().await;
    let created = create_template(
        &harness,
        json!({
            "name": "keep-options",
            "claims": { "plan": "pro" },
            "lifetime": 120,
            "allowed_clock_skew": 30,
            "custom_signing_key": true,
        }),
    )
    .await;
    let id = created["id"].as_str().unwrap().to_string();
    let updated = harness
        .patch(
            &format!("/v1/jwt_templates/{id}"),
            json!({ "name": "renamed" }),
        )
        .await;
    assert_eq!(updated.value()["name"], json!("renamed"));
    assert_eq!(updated.value()["claims"], json!({ "plan": "pro" }));
    assert_eq!(updated.value()["lifetime"], json!(120));
    assert_eq!(updated.value()["allowed_clock_skew"], json!(30));
    assert_eq!(updated.value()["custom_signing_key"], json!(true));
    assert_eq!(updated.value()["signing_algorithm"], json!("RS256"));

    let rotated = harness
        .patch(
            &format!("/v1/jwt_templates/{id}"),
            json!({ "signing_algorithm": "HS256" }),
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK, "{}", rotated.text());
    assert_eq!(rotated.value()["custom_signing_key"], json!(true));
    assert_eq!(rotated.value()["signing_algorithm"], json!("HS256"));
    assert!(rotated.value()["signing_key"].is_string());
}

#[tokio::test]
async fn generates_and_rotates_custom_signing_keys() {
    let harness = setup().await;
    let rs = create_template(
        &harness,
        json!({ "name": "custom-rs", "claims": { "a": "{{user.id}}" }, "custom_signing_key": true }),
    )
    .await;
    assert_eq!(rs["custom_signing_key"], json!(true));
    let rs_id = rs["id"].as_str().unwrap().to_string();
    let stored: Option<String> =
        sqlx::query_scalar("SELECT signing_key_enc FROM jwt_templates WHERE id = $1")
            .bind(&rs_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("row");
    let stored = stored.expect("encrypted key");
    assert!(stored.starts_with("v1."), "{stored}");
    assert!(!stored.contains("\"kty\""));

    let es = create_template(
        &harness,
        json!({ "name": "custom-es", "custom_signing_key": true, "signing_algorithm": "ES256" }),
    )
    .await;
    let es_id = es["id"].as_str().unwrap().to_string();
    let (algorithm, key): (String, Option<String>) = sqlx::query_as(
        "SELECT signing_algorithm, signing_key_enc FROM jwt_templates WHERE id = $1",
    )
    .bind(&es_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("row");
    assert_eq!(algorithm, "ES256");
    assert!(key.unwrap_or_default().starts_with("v1."));

    let rotated = harness
        .patch(
            &format!("/v1/jwt_templates/{rs_id}"),
            json!({ "signing_algorithm": "HS256" }),
        )
        .await;
    assert_eq!(rotated.value()["signing_algorithm"], json!("HS256"));
    let rotated_key: Option<String> =
        sqlx::query_scalar("SELECT signing_key_enc FROM jwt_templates WHERE id = $1")
            .bind(&rs_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("row");
    assert_ne!(rotated_key, Some(stored));

    let cleared = harness
        .patch(
            &format!("/v1/jwt_templates/{rs_id}"),
            json!({ "custom_signing_key": false }),
        )
        .await;
    assert_eq!(cleared.value()["custom_signing_key"], json!(false));
    let cleared_key: Option<String> =
        sqlx::query_scalar("SELECT signing_key_enc FROM jwt_templates WHERE id = $1")
            .bind(&rs_id)
            .fetch_one(&harness.state().pool)
            .await
            .expect("row");
    assert_eq!(cleared_key, None);
}
