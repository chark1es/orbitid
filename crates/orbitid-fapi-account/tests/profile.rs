//! HTTP tests for the profile routes (`test/core/profile.test.ts`,
//! `test/avatar.test.ts`, parts of `test/core/sessions.test.ts`).

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::http::now;
use orbitid_platform::mail::EmailTemplate;
use serde_json::json;

#[tokio::test]
async fn profile_updates_names_username_and_unsafe_metadata() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "attributes": { "username": { "enabled": true, "usedForFirstFactor": true } } }))
        .await
        .expect("settings");
    let user = h.signed_in("profile@example.com", "Sup3r-secret!").await;

    let updated = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({
                "first_name": "Grace",
                "last_name": "Hopper",
                "username": "ghopper",
                "unsafe_metadata": { "plan": "pro" },
            })),
            &[],
        )
        .await;
    assert_status(&updated, StatusCode::OK);
    assert_eq!(updated.value()["response"]["first_name"], "Grace");
    assert_eq!(updated.value()["response"]["last_name"], "Hopper");
    assert_eq!(updated.value()["response"]["username"], "ghopper");
    assert_eq!(
        updated.value()["response"]["unsafe_metadata"]["plan"],
        "pro"
    );

    let me = get_json(&user.client, "/v1/client/me").await;
    assert_eq!(me.value()["response"]["first_name"], "Grace");
}

#[tokio::test]
async fn profile_ignores_privileged_fields() {
    let h = harness().await;
    let user = h.signed_in("mass@example.com", "Sup3r-secret!").await;
    let response = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({
                "first_name": "Ada",
                "banned": true,
                "locked": true,
                "password_hash": "x",
                "is_anonymous": true,
                "private_metadata": { "secret": "leak" },
                "unsafe_metadata": { "plan": "free" },
                "delete_self_enabled": false,
                "create_organizations_limit": 99,
                "external_id": "chosen",
            })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::OK);

    let row =
        sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(&user.user_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("user row");
    assert!(!row.banned);
    assert!(!row.locked);
    assert!(!row.is_anonymous);
    assert!(row.private_metadata.0.is_empty());
    assert!(row.external_id.is_none());
    assert!(row.create_organizations_limit.is_none());
    assert!(row.delete_self_enabled);
    assert_ne!(row.password_hash.as_deref(), Some("x"));
    assert_eq!(row.first_name.as_deref(), Some("Ada"));
    assert_eq!(row.unsafe_metadata.0.get("plan"), Some(&json!("free")));
}

#[tokio::test]
async fn profile_rejects_oversized_fields() {
    let h = harness().await;
    let user = h.signed_in("huge@example.com", "Sup3r-secret!").await;
    let response = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": "x".repeat(10_000) })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::UNPROCESSABLE_ENTITY);

    let metadata: serde_json::Map<String, serde_json::Value> = (0..500)
        .map(|index| (format!("k{index}"), json!("x".repeat(100))))
        .collect();
    let response = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "unsafe_metadata": metadata })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn adds_verifies_and_promotes_an_email_address() {
    let h = harness().await;
    let user = h.signed_in("primary@example.com", "Sup3r-secret!").await;

    let created = user
        .client
        .request(
            "POST",
            "/v1/client/me/email_addresses",
            Some(json!({ "email_address": "Second@Example.com" })),
            &[],
        )
        .await;
    assert_status(&created, StatusCode::OK);
    assert_eq!(
        created.value()["response"]["verification"]["status"],
        "unverified"
    );
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let prepared = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/prepare_verification"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_status(&prepared, StatusCode::OK);
    assert_eq!(
        prepared.value()["response"]["verification"]["status"],
        "unverified"
    );

    let code = orbitid_platform::mail::latest_code_for(
        h.state(),
        "second@example.com",
        Some(EmailTemplate::VerificationCode),
    )
    .expect("verification code");
    let verified = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
    assert_eq!(
        verified.value()["response"]["verification"]["status"],
        "verified"
    );
    assert_eq!(
        verified.value()["response"]["email_address"],
        "second@example.com"
    );

    let listed = get_json(&user.client, "/v1/client/me/email_addresses").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(2));

    let promoted = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "primary_email_address_id": id })),
            &[],
        )
        .await;
    assert_status(&promoted, StatusCode::OK);
    assert_eq!(promoted.value()["response"]["primary_email_address_id"], id);
}

#[tokio::test]
async fn refuses_to_remove_the_last_identification() {
    let h = harness().await;
    let user = h.signed_in("last@example.com", "Sup3r-secret!").await;
    let me = get_json(&user.client, "/v1/client/me").await;
    let id = me.value()["response"]["primary_email_address_id"]
        .as_str()
        .expect("primary email")
        .to_string();
    let response = user
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/email_addresses/{id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&response).first().map(String::as_str),
        Some("last_identification_cannot_be_removed")
    );
}

#[tokio::test]
async fn changes_the_password_and_signs_out_other_sessions() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "session": { "multiSession": true } }))
        .await
        .expect("settings");
    let user = h.signed_in("password@example.com", "Sup3r-secret!").await;
    let other = orbitid_identity::testing::create_test_client_session(h.state(), &user.user_id)
        .await
        .expect("second session");

    let wrong = user
        .client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({ "current_password": "not-it", "new_password": "N3wPassword!" })),
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&wrong).first().map(String::as_str),
        Some("form_password_incorrect")
    );

    let changed = user
        .client
        .request(
            "POST",
            "/v1/client/me/change_password",
            Some(json!({
                "current_password": user.password,
                "new_password": "N3wPassword!",
                "sign_out_of_other_sessions": true,
            })),
            &[],
        )
        .await;
    assert_status(&changed, StatusCode::OK);
    assert_eq!(changed.value()["response"]["id"], user.user_id);
    assert!(orbitid_platform::mail::latest_email(
        h.state(),
        &user.email,
        Some(EmailTemplate::PasswordChanged)
    )
    .is_some());

    let other_row = orbitid_identity::sessions::get_session(h.state(), &other.session.id)
        .await
        .expect("session")
        .expect("exists");
    assert_eq!(other_row.status, "revoked");
    let own = orbitid_identity::sessions::get_session(h.state(), &user.auth.session.id)
        .await
        .expect("session")
        .expect("exists");
    assert_eq!(own.status, "active");
}

#[tokio::test]
async fn uploads_and_serves_a_profile_image() {
    let h = harness().await;
    let user = h.signed_in("avatar@example.com", "Sup3r-secret!").await;
    let data = data_url("image/png", PNG_1X1);

    let uploaded = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": data })),
            &[],
        )
        .await;
    assert_status(&uploaded, StatusCode::OK);
    assert_eq!(uploaded.value()["response"]["has_image"], true);
    let image_url = uploaded.value()["response"]["image_url"]
        .as_str()
        .expect("image url")
        .to_string();
    assert!(image_url.contains("/v1/client/images/"));
    assert!(image_url.ends_with(".png"));

    let path = url::Url::parse(&image_url).expect("url").path().to_string();
    let served = user.client.get(&path, &[]).await;
    assert_status(&served, StatusCode::OK);
    assert_eq!(served.headers.get("content-type").unwrap(), "image/png");
    assert_eq!(
        served.headers.get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(
        served.headers.get("content-security-policy").unwrap(),
        "sandbox"
    );

    // Multipart (the SDK's FormData upload).
    let boundary = "orbitid-test-boundary";
    let body = multipart_body(boundary, "avatar.png", "image/png", &decode_base64(PNG_1X1));
    let cookie = user.client.cookie_header().expect("cookie");
    let multipart = raw_request(
        &h.app,
        "POST",
        "/v1/client/me/profile_image",
        &[
            ("cookie", &cookie),
            ("content-type", &multipart_content_type(boundary)),
        ],
        body,
    )
    .await;
    assert_status(&multipart, StatusCode::OK);
    assert_eq!(multipart.value()["response"]["has_image"], true);

    let removed = user
        .client
        .request("DELETE", "/v1/client/me/profile_image", None, &[])
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["has_image"], false);
}

#[tokio::test]
async fn refuses_svg_uploads_and_traversal_paths() {
    let h = harness().await;
    let user = h.signed_in("svg@example.com", "Sup3r-secret!").await;
    let svg = data_url("image/png", SVG_PAYLOAD);
    let response = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": svg })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(response.text().contains("SVG"));

    let empty = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": "" })),
            &[],
        )
        .await;
    assert_status(&empty, StatusCode::UNPROCESSABLE_ENTITY);

    for path in [
        "/v1/client/images/..%2F..%2Fetc%2Fpasswd",
        "/v1/client/images/evil.svg",
        "/v1/client/images/a..b.png",
        "/v1/client/images/missing.png",
    ] {
        let response = user.client.get(path, &[]).await;
        assert_status(&response, StatusCode::NOT_FOUND);
    }
}

#[tokio::test]
async fn deletes_the_account_when_self_deletion_is_enabled() {
    let h = harness().await;
    let user = h.signed_in("delete-me@example.com", "Sup3r-secret!").await;
    let response = user
        .client
        .request("DELETE", "/v1/client/me", None, &[])
        .await;
    assert_status(&response, StatusCode::OK);
    assert_eq!(response.value()["response"]["deleted"], true);

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&user.user_id)
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(remaining, 0);

    let me = get_json(&user.client, "/v1/client/me").await;
    assert_eq!(
        error_codes(&me).first().map(String::as_str),
        Some("authentication_invalid")
    );
}

#[tokio::test]
async fn lists_and_revokes_other_active_sessions() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "session": { "multiSession": true } }))
        .await
        .expect("settings");
    let user = h.signed_in("sessions@example.com", "Sup3r-secret!").await;
    // A second session owned by the same client (monotonic last-active order).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let created = orbitid_identity::sessions::create_session(
        h.state(),
        orbitid_identity::sessions::CreateSessionInput::new(
            user.auth.client.id.clone(),
            user.user_id.clone(),
        ),
    )
    .await
    .expect("second session");

    let active = get_json(&user.client, "/v1/client/me/sessions/active").await;
    assert_status(&active, StatusCode::OK);
    let sessions = active.value()["response"].as_array().expect("list").clone();
    assert!(sessions
        .iter()
        .all(|session| session["id"] != json!(created.id)));
    let older = sessions
        .iter()
        .find(|session| session["id"] == json!(user.auth.session.id))
        .expect("older session listed");

    let revoked = user
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/sessions/{}/revoke",
                older["id"].as_str().expect("id")
            ),
            Some(json!({})),
            &[],
        )
        .await;
    assert_status(&revoked, StatusCode::OK);
    assert_eq!(revoked.value()["response"]["status"], "revoked");

    let after = get_json(&user.client, "/v1/client/me/sessions/active").await;
    assert!(!after.value()["response"]
        .as_array()
        .expect("list")
        .iter()
        .any(|session| session["id"] == older["id"]));
}

#[tokio::test]
async fn reverification_is_enforced_for_sensitive_mutations() {
    let h = harness().await;
    let user = h.signed_in("reverify@example.com", "Sup3r-secret!").await;
    sqlx::query("UPDATE sessions SET first_factor_verified_at = $1 WHERE id = $2")
        .bind(now() - 60 * 60_000)
        .bind(&user.auth.session.id)
        .execute(&h.state().pool)
        .await
        .expect("update");

    let denied = user
        .client
        .request(
            "POST",
            "/v1/client/me/email_addresses",
            Some(json!({ "email_address": "second@example.com" })),
            &[],
        )
        .await;
    assert_status(&denied, StatusCode::FORBIDDEN);
    let error = &denied.value()["errors"][0];
    assert_eq!(error["code"], "session_reverification_required");
    assert_eq!(error["meta"]["level"], "first_factor");
    assert_eq!(error["meta"]["after_minutes"], 10);
    assert_eq!(error["meta"]["session_id"], user.auth.session.id);
}

#[tokio::test]
async fn trusted_devices_are_listed_and_revoked_per_owner() {
    let h = harness().await;
    let owner = h
        .signed_in("device-owner@example.com", "Sup3r-secret!")
        .await;
    let other = h
        .signed_in("device-other@example.com", "Sup3r-secret!")
        .await;
    let now_ms = now();
    for (id, user_id) in [
        ("tdev_owner", &owner.user_id),
        ("tdev_other", &other.user_id),
    ] {
        sqlx::query(
            "INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at, created_at, \
             updated_at) VALUES ($1,$2,$3,'Laptop',$4,$5,$5)",
        )
        .bind(id)
        .bind(user_id)
        .bind(format!("hash-{id}"))
        .bind(now_ms + 30 * 24 * 3_600_000)
        .bind(now_ms)
        .execute(&h.state().pool)
        .await
        .expect("device");
    }

    let list = get_json(&owner.client, "/v1/client/me/trusted_devices").await;
    assert_status(&list, StatusCode::OK);
    let devices = list.value()["response"].as_array().expect("list").clone();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["user_id"], owner.user_id);
    assert!(!list.text().contains("hash-"));

    let denied = owner
        .client
        .request(
            "DELETE",
            "/v1/client/me/trusted_devices/tdev_other",
            None,
            &[],
        )
        .await;
    assert_status(&denied, StatusCode::NOT_FOUND);

    let removed = owner
        .client
        .request(
            "DELETE",
            "/v1/client/me/trusted_devices/tdev_owner",
            None,
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["deleted"], true);
    let after = get_json(&owner.client, "/v1/client/me/trusted_devices").await;
    assert_eq!(after.value()["response"].as_array().map(Vec::len), Some(0));
}
