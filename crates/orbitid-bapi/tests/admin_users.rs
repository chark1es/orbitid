//! Ported from the retired TypeScript test suite.

mod common;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

/// A fixed, valid base32 TOTP secret (the TS tests generate a random one).
const TOTP_SECRET: &str = "JBSWY3DPEHPK3PXP";

async fn create_user(harness: &Harness, body: Value) -> Value {
    // Mirrors the TS helper: a random email and a valid password unless the
    // caller overrides them.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut body = body;
    let object = body.as_object_mut().expect("object body");
    if !object.contains_key("email_address") && !object.contains_key("username") {
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        object.insert(
            "email_address".into(),
            json!([format!("user-{n}@example.com")]),
        );
    }
    if !object.contains_key("password") && !object.contains_key("password_digest") {
        object.insert("password".into(), json!("Sup3r-secret!"));
    }
    let response = harness.post("/v1/users", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn filters_by_mfa_and_wraps_with_paginated() {
    let harness = setup().await;
    let with_mfa = create_user(
        &harness,
        json!({
            "email_address": ["mfa@example.com"],
            "password": "Sup3r-secret!",
            "totp_secret": TOTP_SECRET,
        }),
    )
    .await;
    let without = create_user(
        &harness,
        json!({ "email_address": ["plain@example.com"], "password": "Sup3r-secret!" }),
    )
    .await;
    assert_eq!(with_mfa["totp_enabled"], json!(true));

    let on = harness.get("/v1/users?mfa=true&paginated=true").await;
    assert_eq!(on.status, StatusCode::OK);
    assert_eq!(
        ids(&on.value()["data"]),
        vec![with_mfa["id"].as_str().unwrap().to_string()]
    );
    assert_eq!(on.value()["total_count"], json!(1));

    let off = harness.get("/v1/users?mfa=false").await;
    assert_eq!(
        ids(&off.value()),
        vec![without["id"].as_str().unwrap().to_string()]
    );
}

#[tokio::test]
async fn creates_a_user_with_verified_email_hashed_password_and_metadata() {
    let harness = setup().await;
    let user = create_user(
        &harness,
        json!({
            "email_address": ["Alice@Example.com"],
            "phone_number": ["+15551234567"],
            "username": "alice",
            "password": "Sup3r-secret!",
            "first_name": "Alice",
            "last_name": "Liddle",
            "external_id": "crm_1",
            "public_metadata": { "tier": "pro" },
            "private_metadata": { "secret": 1 },
            "unsafe_metadata": { "color": "red" },
            "totp_secret": TOTP_SECRET,
            "backup_codes": ["abcd1234"],
        }),
    )
    .await;
    assert_eq!(user["object"], json!("user"));
    assert_eq!(
        user["email_addresses"][0]["email_address"],
        json!("alice@example.com")
    );
    assert_eq!(
        user["email_addresses"][0]["verification"]["status"],
        json!("verified")
    );
    assert_eq!(
        user["primary_email_address_id"],
        user["email_addresses"][0]["id"]
    );
    assert_eq!(
        user["phone_numbers"][0]["phone_number"],
        json!("+15551234567")
    );
    assert_eq!(user["password_enabled"], json!(true));
    assert_eq!(user["totp_enabled"], json!(true));
    assert_eq!(user["backup_code_enabled"], json!(true));
    assert_eq!(user["public_metadata"], json!({ "tier": "pro" }));
    assert_eq!(user["private_metadata"], json!({ "secret": 1 }));
    assert_eq!(user["username"], json!("alice"));
    assert_eq!(user["external_id"], json!("crm_1"));

    let (hash, codes): (Option<String>, Value) =
        sqlx::query_as("SELECT password_hash, backup_codes FROM users WHERE id = $1")
            .bind(user["id"].as_str().unwrap())
            .fetch_one(&harness.state().pool)
            .await
            .expect("user row");
    let hash = hash.expect("password hash");
    assert!(hash.starts_with("$argon2id$"), "{hash}");
    assert_ne!(hash, "Sup3r-secret!");
    let codes = codes.as_array().cloned().unwrap_or_default();
    assert_eq!(codes.len(), 1);
    assert_ne!(codes[0].as_str().unwrap_or_default(), "abcd1234");
}

#[tokio::test]
async fn rejects_duplicates_and_enforces_the_password_policy() {
    let harness = setup().await;
    create_user(
        &harness,
        json!({
            "email_address": ["dup@example.com"],
            "username": "dup",
            "external_id": "ext-1",
        }),
    )
    .await;

    let dup_email = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["dup@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(dup_email.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&dup_email).as_deref(),
        Some("form_identifier_exists")
    );

    let dup_username = harness
        .post(
            "/v1/users",
            json!({ "username": "DUP", "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(dup_username.status, StatusCode::UNPROCESSABLE_ENTITY);
    let dup_external = harness
        .post(
            "/v1/users",
            json!({ "external_id": "ext-1", "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(dup_external.status, StatusCode::UNPROCESSABLE_ENTITY);

    let missing_password = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["nopass@example.com"] }),
        )
        .await;
    assert_eq!(missing_password.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&missing_password).as_deref(),
        Some("form_param_missing")
    );

    let short = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["short@example.com"], "password": "abc" }),
        )
        .await;
    assert_eq!(short.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&short).as_deref(),
        Some("form_password_length_too_short")
    );

    let twice = harness
        .post(
            "/v1/users",
            json!({
                "email_address": ["twice@example.com", "Twice@example.com"],
                "skip_password_requirement": true,
            }),
        )
        .await;
    assert_eq!(twice.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&twice).as_deref(), Some("duplicate_record"));

    let skipped = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["skipped@example.com"], "skip_password_requirement": true }),
        )
        .await;
    assert_eq!(skipped.status, StatusCode::OK);
    assert_eq!(skipped.value()["password_enabled"], json!(false));

    let digest = harness
        .post(
            "/v1/users",
            json!({
                "email_address": ["digest@example.com"],
                "password_digest": "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000",
                "password_hasher": "argon2",
                "skip_password_checks": true,
            }),
        )
        .await;
    assert_eq!(digest.status, StatusCode::OK, "{}", digest.text());
}

#[tokio::test]
async fn lists_users_as_a_bare_array_with_total_count_filters_and_pagination() {
    let harness = setup().await;
    let a = create_user(
        &harness,
        json!({ "email_address": ["a@example.com"], "username": "alpha", "created_at": 1000 }),
    )
    .await;
    let b = create_user(
        &harness,
        json!({ "email_address": ["b@example.com"], "external_id": "ext-b", "created_at": 2000 }),
    )
    .await;
    let c = create_user(
        &harness,
        json!({
            "email_address": ["c@example.com"],
            "phone_number": ["+15550000003"],
            "created_at": 3000,
        }),
    )
    .await;

    let list = harness.get("/v1/users").await;
    assert_eq!(list.status, StatusCode::OK);
    assert!(list.value().is_array());
    assert_eq!(
        list.headers
            .get("x-total-count")
            .and_then(|value| value.to_str().ok()),
        Some("3")
    );
    let order = ids(&list.value());
    assert_eq!(
        order,
        vec![
            c["id"].as_str().unwrap().to_string(),
            b["id"].as_str().unwrap().to_string(),
            a["id"].as_str().unwrap().to_string()
        ]
    );

    let ascending = harness.get("/v1/users?order_by=created_at").await;
    let ascending_ids = ids(&ascending.value());
    assert_eq!(
        ascending_ids,
        vec![
            a["id"].as_str().unwrap().to_string(),
            b["id"].as_str().unwrap().to_string(),
            c["id"].as_str().unwrap().to_string()
        ]
    );
    let page = harness
        .get("/v1/users?limit=1&offset=1&order_by=created_at")
        .await;
    assert_eq!(
        ids(&page.value()),
        vec![b["id"].as_str().unwrap().to_string()]
    );

    let paginated = harness.get("/v1/users?paginated=true&limit=2").await;
    assert_eq!(paginated.value()["total_count"], json!(3));
    assert_eq!(paginated.value()["data"].as_array().map(Vec::len), Some(2));

    let count = harness.get("/v1/users/count").await;
    assert_eq!(
        count.value(),
        json!({ "object": "total_count", "total_count": 3 })
    );

    assert_eq!(
        ids(&harness.get("/v1/users?query=alpha").await.value()),
        vec![b_id(&a)]
    );
    assert_eq!(
        ids(&harness
            .get(&format!("/v1/users?query={}", b["id"].as_str().unwrap()))
            .await
            .value()),
        vec![b_id(&b)]
    );
    assert_eq!(
        ids(&harness
            .get("/v1/users?email_address=b@example.com")
            .await
            .value()),
        vec![b_id(&b)]
    );
    let mut both = ids(&harness
        .get("/v1/users?email_address=a@example.com&email_address=c@example.com")
        .await
        .value());
    both.sort();
    let mut expected = vec![b_id(&a), b_id(&c)];
    expected.sort();
    assert_eq!(both, expected);
    assert_eq!(
        ids(&harness.get("/v1/users?username=alpha").await.value()),
        vec![b_id(&a)]
    );
    assert_eq!(
        ids(&harness.get("/v1/users?external_id=ext-b").await.value()),
        vec![b_id(&b)]
    );
    assert_eq!(
        ids(&harness
            .get(&format!("/v1/users?user_id={}", c["id"].as_str().unwrap()))
            .await
            .value()),
        vec![b_id(&c)]
    );
    assert_eq!(
        ids(&harness
            .get("/v1/users?phone_number=%2B15550000003")
            .await
            .value()),
        vec![b_id(&c)]
    );
    assert!(ids(&harness
        .get("/v1/users?email_address=nobody@example.com")
        .await
        .value())
    .is_empty());

    let org_id = orbitid_core::ids::new_id("org");
    sqlx::query(
        "INSERT INTO organizations (id, name, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ($1, 'Acme', '{}', '{}', 1, 1)",
    )
    .bind(&org_id)
        .execute(&harness.state().pool)
        .await
        .expect("insert org");
    sqlx::query(
        "INSERT INTO organization_memberships \
         (id, organization_id, user_id, role_key, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ($1, $2, $3, 'org:member', '{}', '{}', 1, 1)",
    )
    .bind(orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::MEMBERSHIP))
    .bind(&org_id)
    .bind(b["id"].as_str().unwrap())
    .execute(&harness.state().pool)
    .await
    .expect("insert membership");
    assert_eq!(
        ids(&harness
            .get(&format!("/v1/users?organization_id={org_id}"))
            .await
            .value()),
        vec![b_id(&b)]
    );

    assert!(ids(&harness.get("/v1/users?banned=true").await.value()).is_empty());
    sqlx::query("UPDATE users SET last_active_at = 5000")
        .execute(&harness.state().pool)
        .await
        .expect("update activity");
    assert_eq!(
        harness
            .get("/v1/users?last_active_at_since=4000")
            .await
            .value()
            .as_array()
            .map(Vec::len),
        Some(3)
    );
    assert!(ids(&harness
        .get("/v1/users?last_active_at_since=6000")
        .await
        .value())
    .is_empty());
}

fn b_id(value: &Value) -> String {
    value["id"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn updates_profile_fields_replaces_metadata_and_deep_merges() {
    let harness = setup().await;
    let user = create_user(
        &harness,
        json!({
            "public_metadata": { "tier": "free", "nested": { "a": 1, "b": 2 }, "drop": true },
        }),
    )
    .await;
    let id = b_id(&user);

    let updated = harness
        .patch(
            &format!("/v1/users/{id}"),
            json!({
                "first_name": "Grace",
                "username": "grace",
                "public_metadata": { "tier": "pro" },
                "delete_self_enabled": false,
            }),
        )
        .await;
    assert_eq!(updated.status, StatusCode::OK, "{}", updated.text());
    assert_eq!(updated.value()["first_name"], json!("Grace"));
    assert_eq!(updated.value()["username"], json!("grace"));
    assert_eq!(updated.value()["public_metadata"], json!({ "tier": "pro" }));
    assert_eq!(updated.value()["delete_self_enabled"], json!(false));

    harness
        .patch(
            &format!("/v1/users/{id}/metadata"),
            json!({ "public_metadata": { "nested": { "a": 1, "b": 2 }, "drop": true } }),
        )
        .await;
    let merged = harness
        .patch(
            &format!("/v1/users/{id}/metadata"),
            json!({ "public_metadata": { "nested": { "b": 3, "c": 4 }, "drop": null, "email": "x" } }),
        )
        .await;
    assert_eq!(
        merged.value()["public_metadata"],
        json!({ "tier": "pro", "nested": { "a": 1, "b": 3, "c": 4 }, "email": "x" })
    );

    let cleared = harness
        .patch(&format!("/v1/users/{id}"), json!({ "username": null }))
        .await;
    assert_eq!(cleared.value()["username"], Value::Null);

    let moved = harness
        .patch(
            &format!("/v1/users/{id}"),
            json!({ "primary_email_address_id": user["email_addresses"][0]["id"] }),
        )
        .await;
    assert_eq!(moved.status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&moved).as_deref(), Some("not_allowed_access"));
}

#[tokio::test]
async fn bans_unbans_locks_and_unlocks_without_touching_credentials() {
    let harness = setup().await;
    let user = create_user(
        &harness,
        json!({
            "password": "Sup3r-secret!",
            "totp_secret": TOTP_SECRET,
            "email_address": ["moderated@example.com"],
        }),
    )
    .await;
    let id = b_id(&user);
    let session = harness.create_session(&id).await;

    let banned = harness.post_empty(&format!("/v1/users/{id}/ban")).await;
    assert_eq!(banned.status, StatusCode::OK, "{}", banned.text());
    assert_eq!(banned.value()["banned"], json!(true));
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "revoked");
    assert_eq!(
        ids(&harness.get("/v1/users?banned=true").await.value()),
        vec![id.clone()]
    );

    let unbanned = harness.post_empty(&format!("/v1/users/{id}/unban")).await;
    assert_eq!(unbanned.value()["banned"], json!(false));

    let locked = harness.post_empty(&format!("/v1/users/{id}/lock")).await;
    assert_eq!(locked.value()["locked"], json!(true));
    assert_eq!(locked.value()["lockout_expires_in_seconds"], Value::Null);
    assert_eq!(
        ids(&harness.get("/v1/users?locked=true").await.value()),
        vec![id.clone()]
    );

    let unlocked = harness.post_empty(&format!("/v1/users/{id}/unlock")).await;
    assert_eq!(unlocked.value()["locked"], json!(false));

    let read = harness.get(&format!("/v1/users/{id}")).await;
    assert_eq!(read.value()["password_enabled"], json!(true));
    assert_eq!(read.value()["totp_enabled"], json!(true));
}

#[tokio::test]
async fn refuses_credential_changes_from_the_backend_api() {
    let harness = setup().await;
    let user = create_user(
        &harness,
        json!({
            "email_address": ["secure@example.com"],
            "password": "Sup3r-secret!",
            "totp_secret": TOTP_SECRET,
            "backup_codes": ["abcd1234"],
        }),
    )
    .await;
    let id = b_id(&user);
    let session = harness.create_session(&id).await;
    let before: (Option<String>, Option<String>, bool, Value) = sqlx::query_as(
        "SELECT password_hash, totp_secret_enc, totp_verified, backup_codes FROM users WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("user row");

    let attempts: Vec<(&str, String, Option<Value>)> = vec![
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({ "password": "Attacker-known-1!" })),
        ),
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({
                "password_digest": "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
                "password_hasher": "argon2"
            })),
        ),
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({ "totp_secret": TOTP_SECRET })),
        ),
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({ "totp_secret": null })),
        ),
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({ "backup_codes": ["attacker"] })),
        ),
        (
            "PATCH",
            format!("/v1/users/{id}"),
            Some(json!({ "backup_codes": null })),
        ),
        ("DELETE", format!("/v1/users/{id}/mfa"), None),
        ("DELETE", format!("/v1/users/{id}/password"), None),
    ];
    for (method, path, body) in attempts {
        let response = harness
            .client
            .request(method, &path, body, common::bearer())
            .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(error_code(&response).as_deref(), Some("not_allowed_access"));
        assert!(
            response
                .text()
                .to_ascii_lowercase()
                .contains("signed-in session"),
            "{method} {path}: {}",
            response.text()
        );
    }

    let after: (Option<String>, Option<String>, bool, Value) = sqlx::query_as(
        "SELECT password_hash, totp_secret_enc, totp_verified, backup_codes FROM users WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("user row");
    assert_eq!(before, after);
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&session.session_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("session");
    assert_eq!(status, "active");

    for path in [
        format!("/v1/users/{id}/verify_password"),
        format!("/v1/users/{id}/verify_totp"),
    ] {
        let response = harness
            .post(
                &path,
                json!({ "password": "Sup3r-secret!", "code": "000000" }),
            )
            .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(error_code(&response).as_deref(), Some("not_allowed_access"));
    }
}

#[tokio::test]
async fn deletes_a_user_and_cascades_identifiers() {
    let harness = setup().await;
    let user = create_user(&harness, json!({ "email_address": ["gone@example.com"] })).await;
    let id = b_id(&user);
    let deleted = harness.delete(&format!("/v1/users/{id}")).await;
    assert_eq!(deleted.status, StatusCode::OK);
    assert_eq!(
        deleted.value(),
        json!({ "object": "user", "id": id, "deleted": true })
    );
    assert_eq!(
        harness.get(&format!("/v1/users/{id}")).await.status,
        StatusCode::NOT_FOUND
    );
    let emails = harness
        .get(&format!("/v1/email_addresses?user_id={id}"))
        .await;
    assert!(emails.value()["data"]
        .as_array()
        .map(Vec::is_empty)
        .unwrap_or(false));
}

#[tokio::test]
async fn refuses_every_identifier_write() {
    let harness = setup().await;
    let user = create_user(
        &harness,
        json!({
            "email_address": ["first@example.com"],
            "phone_number": ["+15551230000"],
        }),
    )
    .await;
    let id = b_id(&user);
    let email_id = user["email_addresses"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let phone_id = user["phone_numbers"][0]["id"].as_str().unwrap().to_string();

    let attempts: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            "/v1/email_addresses".into(),
            Some(
                json!({ "user_id": id, "email_address": "attacker@example.com", "verified": true, "primary": true }),
            ),
        ),
        (
            "POST",
            "/v1/email_addresses".into(),
            Some(json!({ "user_id": id, "email_address": "attacker@example.com" })),
        ),
        (
            "PATCH",
            format!("/v1/email_addresses/{email_id}"),
            Some(json!({ "verified": true })),
        ),
        (
            "PATCH",
            format!("/v1/email_addresses/{email_id}"),
            Some(json!({ "verified": false })),
        ),
        (
            "PATCH",
            format!("/v1/email_addresses/{email_id}"),
            Some(json!({ "primary": true })),
        ),
        ("DELETE", format!("/v1/email_addresses/{email_id}"), None),
        (
            "POST",
            "/v1/phone_numbers".into(),
            Some(
                json!({ "user_id": id, "phone_number": "+15550009999", "verified": true, "primary": true, "default_second_factor": true }),
            ),
        ),
        (
            "PATCH",
            format!("/v1/phone_numbers/{phone_id}"),
            Some(json!({ "verified": true })),
        ),
        (
            "PATCH",
            format!("/v1/phone_numbers/{phone_id}"),
            Some(json!({ "default_second_factor": true })),
        ),
        (
            "PATCH",
            format!("/v1/phone_numbers/{phone_id}"),
            Some(json!({ "primary": true })),
        ),
        ("DELETE", format!("/v1/phone_numbers/{phone_id}"), None),
    ];
    for (method, path, body) in attempts {
        let response = harness
            .client
            .request(method, &path, body, common::bearer())
            .await;
        assert_eq!(response.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(error_code(&response).as_deref(), Some("not_allowed_access"));
    }

    let emails = harness
        .get(&format!("/v1/email_addresses?user_id={id}"))
        .await;
    assert_eq!(
        emails.value()["data"][0]["email_address"],
        json!("first@example.com")
    );
    assert_eq!(
        emails.value()["data"][0]["verification"]["status"],
        json!("verified")
    );
    let phones = harness
        .get(&format!("/v1/phone_numbers?user_id={id}"))
        .await;
    assert_eq!(
        phones.value()["data"][0]["phone_number"],
        json!("+15551230000")
    );

    let read = harness.get(&format!("/v1/users/{id}")).await;
    assert_eq!(read.value()["primary_email_address_id"], json!(email_id));
    assert_eq!(read.value()["primary_phone_number_id"], json!(phone_id));

    assert_eq!(
        harness
            .patch(
                "/v1/email_addresses/idn_e_nope",
                json!({ "verified": true })
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        harness
            .post(
                "/v1/email_addresses",
                json!({ "user_id": "user_nope", "email_address": "x@example.com" }),
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn stores_and_clears_profile_images() {
    let harness = setup().await;
    let user = create_user(&harness, json!({ "email_address": ["image@example.com"] })).await;
    let id = b_id(&user);
    let data_url = "data:image/png;base64,iVBORw0KGgo=";
    let with_image = harness
        .post(
            &format!("/v1/users/{id}/profile_image"),
            json!({ "file": data_url }),
        )
        .await;
    assert_eq!(with_image.status, StatusCode::OK, "{}", with_image.text());
    assert_eq!(with_image.value()["has_image"], json!(true));
    assert_eq!(with_image.value()["image_url"], json!(data_url));

    let cleared = harness
        .delete(&format!("/v1/users/{id}/profile_image"))
        .await;
    assert_eq!(cleared.value()["has_image"], json!(false));
    assert_ne!(cleared.value()["image_url"], json!(data_url));

    let refused = harness
        .get(&format!("/v1/users/{id}/oauth_access_tokens/google"))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&refused).as_deref(), Some("not_allowed_access"));
}

#[tokio::test]
async fn search_matches_case_insensitively_and_treats_wildcards_literally() {
    let harness = setup().await;
    let ada = create_user(
        &harness,
        json!({
            "email_address": ["Ada.Lovelace@Example.com"],
            "first_name": "Ada",
            "last_name": "Lovelace",
        }),
    )
    .await;
    create_user(
        &harness,
        json!({ "email_address": ["grace@example.com"], "first_name": "Grace", "last_name": "Hopper" }),
    )
    .await;
    let ada_id = b_id(&ada);

    for query in ["ADA", "lovelace@EXAMPLE", "ada lovelace"] {
        let encoded = query.replace(' ', "%20");
        let response = harness.get(&format!("/v1/users?query={encoded}")).await;
        assert_eq!(ids(&response.value()), vec![ada_id.clone()], "{query}");
    }
    for query in ["%25", "_da"] {
        let response = harness.get(&format!("/v1/users?query={query}")).await;
        assert!(ids(&response.value()).is_empty(), "{query}");
    }
}

#[tokio::test]
async fn enforces_required_profile_attributes() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({
            "attributes": {
                "firstName": { "enabled": true, "required": true },
                "lastName": { "enabled": true, "required": true },
            }
        }))
        .await
        .expect("settings");

    let missing_first = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["a@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(missing_first.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        missing_first.value()["errors"][0]["meta"]["param_name"],
        json!("first_name")
    );
    let missing_last = harness
        .post(
            "/v1/users",
            json!({
                "email_address": ["a@example.com"],
                "password": "Sup3r-secret!",
                "first_name": "Ada",
            }),
        )
        .await;
    assert_eq!(missing_last.status, StatusCode::UNPROCESSABLE_ENTITY);

    let created = create_user(
        &harness,
        json!({
            "email_address": ["a@example.com"],
            "password": "Sup3r-secret!",
            "first_name": "Ada",
            "last_name": "Lovelace",
        }),
    )
    .await;
    assert_eq!(created["first_name"], json!("Ada"));

    let cleared = harness
        .patch(
            &format!("/v1/users/{}", b_id(&created)),
            json!({ "last_name": null }),
        )
        .await;
    assert_eq!(cleared.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        cleared.value()["errors"][0]["meta"]["param_name"],
        json!("last_name")
    );

    assert_eq!(
        harness
            .post(
                "/v1/users",
                json!({ "email_address": ["import@example.com"], "skip_password_requirement": true }),
            )
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn enforces_a_required_username_and_refuses_to_clear_it() {
    let harness = setup().await;
    harness
        .state()
        .settings
        .update(json!({ "attributes": { "username": { "enabled": true, "required": true } } }))
        .await
        .expect("settings");
    let missing = harness
        .post(
            "/v1/users",
            json!({ "email_address": ["u@example.com"], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        missing.value()["errors"][0]["meta"]["param_name"],
        json!("username")
    );
    let created = create_user(
        &harness,
        json!({
            "email_address": ["u@example.com"],
            "password": "Sup3r-secret!",
            "username": "ada",
        }),
    )
    .await;
    assert_eq!(
        harness
            .patch(
                &format!("/v1/users/{}", b_id(&created)),
                json!({ "username": null })
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness
            .patch(
                &format!("/v1/users/{}", b_id(&created)),
                json!({ "username": "ada2" })
            )
            .await
            .status,
        StatusCode::OK
    );
}

/// A failure after the user insert must roll back the user, its identifiers
/// and the `user.created` event. Before the fix the user row committed on the
/// pool and the request left an orphan behind.
#[tokio::test]
async fn user_creation_is_atomic_when_an_identifier_insert_fails() {
    let harness = setup().await;
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_email_insert() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected identifier failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&harness.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_email_insert BEFORE INSERT ON email_addresses \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_email_insert()",
    )
    .execute(&harness.state().pool)
    .await
    .expect("trigger");

    let response = harness
        .post(
            "/v1/users",
            json!({
                "email_address": ["orphan-bapi@example.com"],
                "username": "orphan-bapi",
                "password": "Sup3r-secret!",
            }),
        )
        .await;
    assert_eq!(
        response.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        response.text()
    );
    let users: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username_lower = 'orphan-bapi'")
            .fetch_one(&harness.state().pool)
            .await
            .expect("users");
    assert_eq!(users, 0, "the failed creation must roll the user row back");
    let events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'user.created'")
            .fetch_one(&harness.state().pool)
            .await
            .expect("events");
    assert_eq!(events, 0, "no event may announce a rolled-back user");
}
