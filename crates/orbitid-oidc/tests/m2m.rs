//! Ported from `test/machine/m2m.test.ts` and the `client_credentials` part of
//! `modules/oidc/machine.ts`.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{basic, decode_claims, harness, Harness};

async fn create_machine(h: &Harness, name: &str, extra: Value) -> Value {
    let mut body = json!({ "name": name });
    if let (Some(base), Value::Object(extra)) = (body.as_object_mut(), extra) {
        for (key, value) in extra {
            base.insert(key, value);
        }
    }
    let response = h.post("/v1/m2m/machines", body).await;
    assert_eq!(response.status, StatusCode::CREATED, "{}", response.text());
    response.value()
}

#[tokio::test]
async fn machines_crud_and_scopes() {
    let h = harness().await;
    let machine = create_machine(&h, "ci", json!({})).await;
    assert_eq!(machine["object"], "machine");
    assert!(machine["id"].as_str().unwrap().starts_with("mch_"));
    assert!(machine["secret"].as_str().unwrap().starts_with("mk_"));
    assert_eq!(machine["default_token_ttl"], 3600);
    assert_eq!(machine["scoped_machines"], json!([]));

    let list = h.get("/v1/m2m/machines").await;
    assert_eq!(list.value()["total_count"], 1);
    assert!(list.value()["data"][0].get("secret").is_none());

    let patched = h
        .patch(
            &format!("/v1/m2m/machines/{}", machine["id"].as_str().unwrap()),
            json!({ "name": "ci-renamed", "default_token_ttl": 60 }),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK);
    assert_eq!(patched.value()["name"], "ci-renamed");
    assert_eq!(patched.value()["default_token_ttl"], 60);

    let a = create_machine(&h, "a", json!({})).await;
    let b = create_machine(&h, "b", json!({})).await;
    let linked = h
        .post(
            &format!("/v1/m2m/machines/{}/scopes", a["id"].as_str().unwrap()),
            json!({ "scoped_machine_id": b["id"] }),
        )
        .await;
    assert_eq!(linked.status, StatusCode::OK);
    assert_eq!(linked.value()["scoped_machines"], json!([b["id"]]));
    let again = h
        .post(
            &format!("/v1/m2m/machines/{}/scopes", a["id"].as_str().unwrap()),
            json!({ "machine_id": b["id"] }),
        )
        .await;
    assert_eq!(again.value()["scoped_machines"], json!([b["id"]]));
    let itself = h
        .post(
            &format!("/v1/m2m/machines/{}/scopes", a["id"].as_str().unwrap()),
            json!({ "scoped_machine_id": a["id"] }),
        )
        .await;
    assert_eq!(itself.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn rotate_secret_invalidates_the_old_one() {
    let h = harness().await;
    let machine = create_machine(&h, "machine", json!({})).await;
    let rotated = h
        .post(
            &format!(
                "/v1/m2m/machines/{}/secret/rotate",
                machine["id"].as_str().unwrap()
            ),
            json!({}),
        )
        .await;
    assert_eq!(rotated.status, StatusCode::OK);
    let secret = rotated.value()["secret"].as_str().unwrap().to_string();
    assert!(secret.starts_with("mk_"));
    assert_ne!(secret, machine["secret"]);

    let old = h
        .form_with_auth(
            "/oauth/m2m/token",
            &[("grant_type", "client_credentials")],
            &basic(
                machine["id"].as_str().unwrap(),
                machine["secret"].as_str().unwrap(),
            ),
        )
        .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
    assert_eq!(old.value()["error"], "invalid_client");

    let new = h
        .form_with_auth(
            "/oauth/m2m/token",
            &[("grant_type", "client_credentials")],
            &basic(machine["id"].as_str().unwrap(), &secret),
        )
        .await;
    assert_eq!(new.status, StatusCode::OK);
    assert!(new.value()["access_token"]
        .as_str()
        .unwrap()
        .starts_with("mt_"));
}

#[tokio::test]
async fn opaque_tokens_are_hashed_verifiable_and_revocable() {
    let h = harness().await;
    let machine = create_machine(&h, "machine", json!({})).await;
    let created = h
        .post(
            "/v1/m2m/tokens",
            json!({
                "machine_id": machine["id"],
                "seconds_until_expiration": 600,
                "claims": { "run": "42" }
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let token = created.value();
    assert!(token["token"].as_str().unwrap().starts_with("mt_"));
    assert_eq!(token["machine_id"], machine["id"]);
    assert_eq!(token["claims"]["run"], "42");
    assert_eq!(token["claims"]["sub"], machine["id"]);

    let stored: String = sqlx::query_scalar("SELECT token_hash FROM m2m_tokens WHERE id = $1")
        .bind(token["id"].as_str().unwrap())
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_ne!(stored, token["token"]);

    let verified = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(verified.status, StatusCode::OK);
    assert_eq!(verified.value()["valid"], true);
    assert_eq!(verified.value()["machine_id"], machine["id"]);

    let listed = h
        .get(&format!(
            "/v1/m2m/tokens?machine_id={}",
            machine["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(listed.value()["total_count"], 1);

    let revoked = h
        .post(
            &format!("/v1/m2m/tokens/{}/revoke", token["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(revoked.value()["revoked"], true);
    let after = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
    assert_eq!(after.value()["errors"][0]["code"], "authorization_invalid");
}

#[tokio::test]
async fn reserved_claims_are_refused() {
    let h = harness().await;
    let machine = create_machine(&h, "machine", json!({})).await;
    for claims in [
        json!({ "sid": "sess_x" }),
        json!({ "org_role": "org:admin" }),
        json!({ "org_permissions": ["org:sys_profile:manage"] }),
        json!({ "act": { "sub": "user_1" } }),
    ] {
        let response = h
            .post(
                "/v1/m2m/tokens",
                json!({
                    "machine_id": machine["id"],
                    "token_format": "jwt",
                    "claims": claims
                }),
            )
            .await;
        assert_eq!(
            response.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{}",
            response.text()
        );
    }
}

#[tokio::test]
async fn jwt_tokens_are_rs256_bound_to_the_machine() {
    let h = harness().await;
    let other = create_machine(&h, "target", json!({})).await;
    let machine = create_machine(&h, "issuer", json!({ "scoped_machines": [other["id"]] })).await;
    let created = h
        .post(
            "/v1/m2m/tokens",
            json!({
                "machine_id": machine["id"],
                "token_format": "jwt",
                "seconds_until_expiration": 300
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    let token = created.value();
    assert_eq!(token["token"].as_str().unwrap().split('.').count(), 3);
    let claims = decode_claims(token["token"].as_str().unwrap());
    assert_eq!(claims["sub"], machine["id"]);
    assert_eq!(claims["scopes"], json!([other["id"]]));
    assert_eq!(claims["iss"], common::BASE_URL);

    let verified = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(verified.status, StatusCode::OK);
    assert_eq!(verified.value()["machine_id"], machine["id"]);

    h.post(
        &format!("/v1/m2m/tokens/{}/revoke", token["id"].as_str().unwrap()),
        json!({}),
    )
    .await;
    let after = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn expired_and_garbage_tokens_are_rejected() {
    let h = harness().await;
    let machine = create_machine(&h, "machine", json!({})).await;
    let token = h
        .post("/v1/m2m/tokens", json!({ "machine_id": machine["id"] }))
        .await
        .value();
    sqlx::query("UPDATE m2m_tokens SET expires_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 1)
        .bind(token["id"].as_str().unwrap())
        .execute(&h.state().pool)
        .await
        .unwrap();
    let expired = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(expired.status, StatusCode::UNAUTHORIZED);
    let garbage = h
        .post("/v1/m2m/tokens/verify", json!({ "token": "mt_nope" }))
        .await;
    assert_eq!(garbage.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn machine_secret_mints_tokens_at_the_oauth_endpoint() {
    let h = harness().await;
    let other = create_machine(&h, "other", json!({})).await;
    let machine = create_machine(&h, "machine", json!({ "scoped_machines": [other["id"]] })).await;
    let id = machine["id"].as_str().unwrap();
    let secret = machine["secret"].as_str().unwrap();

    let response = h
        .form_with_auth(
            "/oauth/m2m/token",
            &[
                ("grant_type", "client_credentials"),
                ("token_format", "opaque"),
                ("seconds_until_expiration", "120"),
            ],
            &basic(id, secret),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let body = response.value();
    assert!(body["access_token"].as_str().unwrap().starts_with("mt_"));
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["token_format"], "opaque");
    assert_eq!(body["scope"], other["id"]);
    assert!(body["expires_in"].as_i64().unwrap() > 100);
    assert!(body.get("machine_token").is_some());

    let via_body = h
        .post(
            "/oauth/m2m/token",
            json!({
                "machine_id": id,
                "machine_secret": secret,
                "token_format": "jwt"
            }),
        )
        .await;
    assert_eq!(via_body.status, StatusCode::OK);
    assert_eq!(
        via_body.value()["access_token"]
            .as_str()
            .unwrap()
            .split('.')
            .count(),
        3
    );

    let wrong_secret = h
        .form(
            "/oauth/m2m/token",
            &[
                ("grant_type", "client_credentials"),
                ("machine_id", id),
                ("machine_secret", "mk_wrong"),
            ],
        )
        .await;
    assert_eq!(wrong_secret.status, StatusCode::UNAUTHORIZED);
    assert_eq!(wrong_secret.value()["error"], "invalid_client");

    let wrong_grant = h
        .form_with_auth(
            "/oauth/m2m/token",
            &[("grant_type", "password")],
            &basic(id, secret),
        )
        .await;
    assert_eq!(wrong_grant.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong_grant.value()["error"], "unsupported_grant_type");
}

#[tokio::test]
async fn secret_key_is_required_and_deleting_a_machine_removes_its_tokens() {
    let h = harness().await;
    let machine = create_machine(&h, "machine", json!({})).await;
    assert_eq!(
        h.client.get("/v1/m2m/machines", &[]).await.status,
        StatusCode::UNAUTHORIZED
    );
    let token = h
        .post("/v1/m2m/tokens", json!({ "machine_id": machine["id"] }))
        .await
        .value();
    let deleted = h
        .delete(&format!(
            "/v1/m2m/machines/{}",
            machine["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(deleted.status, StatusCode::OK);
    let remaining: Option<String> = sqlx::query_scalar("SELECT id FROM m2m_tokens WHERE id = $1")
        .bind(token["id"].as_str().unwrap())
        .fetch_optional(&h.state().pool)
        .await
        .unwrap();
    assert!(remaining.is_none());
    let verify = h
        .post("/v1/m2m/tokens/verify", json!({ "token": token["token"] }))
        .await;
    assert_eq!(verify.status, StatusCode::UNAUTHORIZED);
}
