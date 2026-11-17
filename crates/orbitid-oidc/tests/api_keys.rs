//! Ported from `test/machine/api-keys.test.ts`.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{harness, insert_user};

fn assert_code(response: &orbitid_core::testing::TestResponse, code: &str) {
    assert_eq!(
        response.value()["errors"][0]["code"],
        code,
        "{}",
        response.text()
    );
}

#[tokio::test]
async fn backend_creates_shows_the_secret_once_and_stores_only_hashes() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let created = h
        .post(
            "/v1/api_keys",
            json!({
                "name": "CI deploy",
                "subject": browser.user.id,
                "scopes": ["read", "write"],
                "claims": { "env": "prod" },
                "seconds_until_expiration": 3600,
                "description": "deploy bot"
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let key = created.value();
    assert_eq!(key["object"], "api_key");
    assert!(key["id"].as_str().unwrap().starts_with("ak_"));
    let secret = key["secret"].as_str().unwrap();
    assert!(secret.starts_with("ak_live_"));
    assert_eq!(key["prefix"], &secret[..12]);
    assert_eq!(key["scopes"], json!(["read", "write"]));
    assert_eq!(key["claims"], json!({ "env": "prod" }));
    assert_eq!(key["subject"], browser.user.id);
    assert!(key["expiration"].as_i64().unwrap() > orbitid_core::http::now());

    let stored: String = sqlx::query_scalar("SELECT secret_hash FROM api_keys WHERE id = $1")
        .bind(key["id"].as_str().unwrap())
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_ne!(stored, secret);
    assert_eq!(stored.len(), 64);

    let fetched = h
        .get(&format!("/v1/api_keys/{}", key["id"].as_str().unwrap()))
        .await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert!(fetched.value().get("secret").is_none());
}

#[tokio::test]
async fn backend_verifies_secrets_and_updates_last_used_at() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let key = h
        .post(
            "/v1/api_keys",
            json!({ "name": "k", "subject": browser.user.id }),
        )
        .await
        .value();
    let verified = h
        .post(
            "/v1/api_keys/verify",
            json!({ "secret": key["secret"].as_str().unwrap() }),
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK);
    assert_eq!(verified.value()["id"], key["id"]);
    assert!(verified.value()["last_used_at"].as_i64().unwrap() > 0);

    let bad = h
        .post(
            "/v1/api_keys/verify",
            json!({ "secret": "ak_live_not-a-real-key" }),
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    assert_code(&bad, "api_key_invalid");
}

#[tokio::test]
async fn backend_lists_filter_invalid_keys_and_revokes() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let key = h
        .post(
            "/v1/api_keys",
            json!({ "name": "short", "subject": browser.user.id }),
        )
        .await
        .value();
    sqlx::query("UPDATE api_keys SET expires_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 1000)
        .bind(key["id"].as_str().unwrap())
        .execute(&h.state().pool)
        .await
        .unwrap();

    let expired = h
        .post(
            "/v1/api_keys/verify",
            json!({ "secret": key["secret"].as_str().unwrap() }),
        )
        .await;
    assert_eq!(expired.status, StatusCode::UNAUTHORIZED);

    let list = h
        .get(&format!("/v1/api_keys?subject={}", browser.user.id))
        .await;
    assert_eq!(list.value()["data"], json!([]));
    let all = h
        .get(&format!(
            "/v1/api_keys?subject={}&include_invalid=true",
            browser.user.id
        ))
        .await;
    assert_eq!(all.value()["data"].as_array().unwrap().len(), 1);
    assert_eq!(all.value()["total_count"], 1);

    let second = h
        .post(
            "/v1/api_keys",
            json!({ "name": "revocable", "subject": browser.user.id }),
        )
        .await
        .value();
    let revoked = h
        .post(
            &format!("/v1/api_keys/{}/revoke", second["id"].as_str().unwrap()),
            json!({ "revocation_reason": "leaked" }),
        )
        .await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(revoked.value()["revoked"], true);
    let reason: Option<String> =
        sqlx::query_scalar("SELECT revocation_reason FROM api_keys WHERE id = $1")
            .bind(second["id"].as_str().unwrap())
            .fetch_one(&h.state().pool)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("leaked"));
    let after = h
        .post(
            "/v1/api_keys/verify",
            json!({ "secret": second["secret"].as_str().unwrap() }),
        )
        .await;
    assert_eq!(after.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn backend_updates_and_deletes_keys() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let key = h
        .post(
            "/v1/api_keys",
            json!({ "name": "old", "subject": browser.user.id }),
        )
        .await
        .value();
    let patched = h
        .patch(
            &format!("/v1/api_keys/{}", key["id"].as_str().unwrap()),
            json!({ "name": "renamed", "scopes": ["read"] }),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK);
    assert_eq!(patched.value()["name"], "renamed");

    let deleted = h
        .delete(&format!("/v1/api_keys/{}", key["id"].as_str().unwrap()))
        .await;
    assert_eq!(deleted.status, StatusCode::OK);
    assert_eq!(deleted.value()["object"], "api_key");
    assert_eq!(deleted.value()["deleted"], true);
    let gone = h
        .get(&format!("/v1/api_keys/{}", key["id"].as_str().unwrap()))
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn banned_and_locked_subjects_cannot_use_keys() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let key = h
        .post(
            "/v1/api_keys",
            json!({ "name": "ci", "subject": browser.user.id }),
        )
        .await
        .value();
    let verify = || {
        h.post(
            "/v1/api_keys/verify",
            json!({ "secret": key["secret"].as_str().unwrap() }),
        )
    };
    sqlx::query("UPDATE users SET banned = true WHERE id = $1")
        .bind(&browser.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(verify().await.status, StatusCode::UNAUTHORIZED);

    sqlx::query(
        "UPDATE users SET banned = false, locked = true, lockout_expires_at = NULL WHERE id = $1",
    )
    .bind(&browser.user.id)
    .execute(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(verify().await.status, StatusCode::UNAUTHORIZED);

    sqlx::query("UPDATE users SET locked = false WHERE id = $1")
        .bind(&browser.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(verify().await.status, StatusCode::OK);
}

#[tokio::test]
async fn backend_validates_subject_and_requires_the_secret_key() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let bad = h
        .post("/v1/api_keys", json!({ "name": "x", "subject": "wat_123" }))
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);
    let missing = h
        .post(
            "/v1/api_keys",
            json!({ "name": "x", "subject": "user_does_not_exist" }),
        )
        .await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
    let unauth = h.client.get("/v1/api_keys?subject=x", &[]).await;
    assert_eq!(unauth.status, StatusCode::UNAUTHORIZED);
    let _ = browser;
}

#[tokio::test]
async fn frontend_user_keys_are_owned_and_self_service() {
    let h = harness().await;
    let browser = insert_user(&h, "user@example.com").await;
    let created = browser
        .client
        .post(
            "/v1/client/me/api_keys",
            Some(json!({ "name": "Personal", "seconds_until_expiration": 60 })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let key = created.value()["response"].clone();
    assert_eq!(key["subject"], browser.user.id);
    assert_eq!(key["created_by"], browser.user.id);
    assert!(key["secret"].as_str().unwrap().starts_with("ak_live_"));

    let list = browser.client.get("/v1/client/me/api_keys", &[]).await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.value()["response"].as_array().unwrap().len(), 1);
    assert!(list.value()["response"][0].get("secret").is_none());

    let renamed = browser
        .client
        .patch(
            &format!("/v1/client/me/api_keys/{}", key["id"].as_str().unwrap()),
            Some(json!({ "name": "Renamed" })),
            &[],
        )
        .await;
    assert_eq!(renamed.value()["response"]["name"], "Renamed");
    let revoked = browser
        .client
        .post(
            &format!(
                "/v1/client/me/api_keys/{}/revoke",
                key["id"].as_str().unwrap()
            ),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(revoked.value()["response"]["revoked"], true);
    let deleted = browser
        .client
        .delete(
            &format!("/v1/client/me/api_keys/{}", key["id"].as_str().unwrap()),
            None,
            &[],
        )
        .await;
    assert_eq!(deleted.value()["response"]["deleted"], true);

    // Another user's key is invisible.
    let other = insert_user(&h, "other@example.com").await;
    let theirs = other
        .client
        .post(
            "/v1/client/me/api_keys",
            Some(json!({ "name": "theirs" })),
            &[],
        )
        .await
        .value()["response"]
        .clone();
    let attempt = browser
        .client
        .get(
            &format!("/v1/client/me/api_keys/{}", theirs["id"].as_str().unwrap()),
            &[],
        )
        .await;
    assert_eq!(attempt.status, StatusCode::NOT_FOUND);
    let attempt_revoke = browser
        .client
        .post(
            &format!(
                "/v1/client/me/api_keys/{}/revoke",
                theirs["id"].as_str().unwrap()
            ),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(attempt_revoke.status, StatusCode::NOT_FOUND);

    let anonymous = h.client.get("/v1/client/me/api_keys", &[]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn frontend_guests_cannot_create_keys() {
    let h = harness().await;
    let guest = orbitid_identity::testing::create_test_guest(h.state())
        .await
        .unwrap();
    let session = orbitid_identity::testing::create_test_client_session(h.state(), &guest.id)
        .await
        .unwrap();
    let client = orbitid_core::testing::TestClient::with_cookie(h.router.clone(), &session.cookie);
    let response = client
        .post(
            "/v1/client/me/api_keys",
            Some(json!({ "name": "guest" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_code(&response, "not_allowed_access");
}

#[tokio::test]
async fn frontend_organization_keys_require_permission() {
    let h = harness().await;
    let browser = insert_user(&h, "owner@example.com").await;
    let org = orbitid_identity::testing::create_test_organization(
        h.state(),
        "Acme",
        None,
        &browser.user.id,
    )
    .await
    .unwrap();

    let outsider = insert_user(&h, "outsider@example.com").await;
    let denied = outsider
        .client
        .get(
            &format!("/v1/client/organizations/{}/api_keys", org.id),
            &[],
        )
        .await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN);
    assert_code(&denied, "not_a_member_in_organization");

    let member = insert_user(&h, "member@example.com").await;
    orbitid_identity::testing::add_test_member(h.state(), &org.id, &member.user.id, "org:member")
        .await
        .unwrap();
    let plain = member
        .client
        .get(
            &format!("/v1/client/organizations/{}/api_keys", org.id),
            &[],
        )
        .await;
    assert_eq!(plain.status, StatusCode::FORBIDDEN);
    assert_code(&plain, "org_permission_required");

    // org:admin may create and list org keys.
    let created = browser
        .client
        .post(
            &format!("/v1/client/organizations/{}/api_keys", org.id),
            Some(json!({ "name": "Org key" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let key = created.value()["response"].clone();
    assert_eq!(key["subject"], org.id);
    assert_eq!(key["created_by"], browser.user.id);
    let list = browser
        .client
        .get(
            &format!("/v1/client/organizations/{}/api_keys", org.id),
            &[],
        )
        .await;
    assert_eq!(list.value()["response"].as_array().unwrap().len(), 1);

    let unknown = browser
        .client
        .get("/v1/client/organizations/org_missing/api_keys", &[])
        .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    assert_code(&unknown, "organization_not_found");
    let _: Value = json!({});
}
