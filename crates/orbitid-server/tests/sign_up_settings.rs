//! Sign-up completion as an operator actually configures it: settings changed
//! through `PATCH /v1/instance` over HTTP, then the very next Frontend API
//! request must observe them.
//!
//! These tests exist because the unit and domain suites build settings directly
//! in-process (`state.settings.update(...)`) and only ever signed up with the
//! default "verify the email at sign-up" configuration. That combination never
//! exercised a sign-up whose requirements are satisfied without a verification
//! snapshot, so the create-time completion path could stop completing without
//! any suite noticing — which is exactly what the container smoke test caught.
//!
//! The flow mirrors `scripts/smoke-container.sh`: PATCH the instance with the
//! secret key, create the sign-up (it must be complete immediately and return a
//! session), read `/v1/client/me` with that session, sign in one-shot from a
//! fresh client, and upload a profile image.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::{json, Value};
use std::time::Duration;

const PASSWORD: &str = "Sup3rSecret!";
// The 1x1 PNG the smoke script uploads.
const PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn instance_patch_without_email_verification() -> Value {
    json!({
        "attributes": {
            "emailAddress": {
                "verifyAtSignUp": false,
                "usedForFirstFactor": false,
                "usedForSecondFactor": false
            }
        }
    })
}

/// PATCHes the instance and fails loudly if the operator's write is refused.
async fn patch_instance(e2e: &E2e, patch: Value) {
    let response = e2e
        .client
        .patch("/v1/instance", Some(patch), bearer())
        .await;
    assert_eq!(
        response.status,
        StatusCode::OK,
        "instance PATCH failed: {}",
        response.text()
    );
}

fn assert_session_sign_up(value: &Value, label: &str) {
    assert_eq!(
        value["response"]["status"], "complete",
        "{label}: sign-up did not complete on create: {value}"
    );
    let session = value["response"]["created_session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{label}: no created_session_id: {value}"));
    assert!(
        session.starts_with("sess_"),
        "{label}: created_session_id is not a session: {session}"
    );
    let user = value["response"]["created_user_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{label}: no created_user_id: {value}"));
    assert!(
        user.starts_with("user_"),
        "{label}: created_user_id is not a user: {user}"
    );
}

fn created_session_id(value: &Value, label: &str) -> String {
    assert_eq!(
        value["response"]["status"], "complete",
        "{label}: sign-in did not complete: {value}"
    );
    let session = value["response"]["created_session_id"]
        .as_str()
        .unwrap_or_else(|| panic!("{label}: no created_session_id: {value}"));
    assert!(
        session.starts_with("sess_"),
        "{label}: created_session_id is not a session: {session}"
    );
    session.to_string()
}

async fn assert_me_ok(client: &orbitid_core::testing::TestClient, user_id: &str, label: &str) {
    let me = client.get("/v1/client/me", &[]).await;
    assert_eq!(me.status, StatusCode::OK, "{label}: {}", me.text());
    assert_eq!(me.value()["response"]["id"], user_id, "{label}: {me:?}");
}

async fn assert_profile_image_upload_ok(
    client: &orbitid_core::testing::TestClient,
    label: &str,
) -> String {
    let upload = client
        .post(
            "/v1/client/me/profile_image",
            Some(json!({ "file": PNG_BASE64 })),
            &[],
        )
        .await;
    assert_eq!(upload.status, StatusCode::OK, "{label}: {}", upload.text());
    let image_url = upload.value()["response"]["image_url"]
        .as_str()
        .unwrap_or_else(|| panic!("{label}: no image_url: {}", upload.text()))
        .to_string();
    assert!(
        image_url.starts_with("http"),
        "{label}: image_url is not absolute: {image_url}"
    );
    image_url
}

/// The smoke flow: operator turns email verification off through the API, and
/// the next sign-up completes on create with a session.
#[tokio::test]
async fn settings_patch_makes_the_next_sign_up_complete_on_create() {
    let e2e = E2e::new().await;
    let browser = e2e.browser();

    patch_instance(&e2e, instance_patch_without_email_verification()).await;

    // The setting must be in effect for requests after the PATCH, not only
    // stored: the public environment projection is what the SDK reads.
    let environment = browser.get("/v1/client/environment", &[]).await;
    assert_eq!(environment.status, StatusCode::OK, "{}", environment.text());
    assert_eq!(
        environment.value()["user_settings"]["attributes"]["email_address"]["verify_at_sign_up"],
        false,
        "the instance PATCH is not visible to the next request"
    );

    let created = browser
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "email_address": "smoke@example.test", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let created = created.value();
    assert_eq!(
        created["response"]["missing_fields"],
        json!([]),
        "{created}"
    );
    assert_eq!(
        created["response"]["unverified_fields"],
        json!([]),
        "{created}"
    );
    assert_session_sign_up(&created, "sign-up");
    let user_id = created["response"]["created_user_id"]
        .as_str()
        .expect("created_user_id")
        .to_string();

    assert_me_ok(&browser, &user_id, "the new session reads its own user").await;

    // A fresh browser (the smoke test's empty sign-in cookie jar) signs in with
    // just identifier + password: one-shot creation + password attempt.
    let fresh = e2e.browser();
    let signed_in = fresh
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "smoke@example.test", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(signed_in.status, StatusCode::OK, "{}", signed_in.text());
    let signed_in = signed_in.value();
    created_session_id(&signed_in, "one-shot password sign-in");
    assert_me_ok(&fresh, &user_id, "one-shot password session").await;

    assert_profile_image_upload_ok(&fresh, "profile image upload").await;
}

/// The same flow when the PATCH lands on replica A and the sign-up on replica B:
/// settings propagate over `LISTEN/NOTIFY`, and B must complete the sign-up from
/// its own reloaded snapshot.
#[tokio::test]
async fn settings_patch_on_one_replica_governs_sign_up_on_another() {
    let first = E2e::new().await;
    let second_state = replica_state(&first.app.context.db.url).await;
    let second =
        orbitid_core::testing::TestClient::new(orbitid_server::build_app(second_state.clone()));

    // The operator's PATCH always goes to replica A.
    patch_instance(&first, instance_patch_without_email_verification()).await;

    // Replica B has its own settings store; wait for it to observe the commit
    // (normally one NOTIFY wake-up, seconds at worst from the periodic refresh).
    let mut observed = false;
    for _ in 0..100 {
        let environment = second.get("/v1/client/environment", &[]).await;
        if environment.status == StatusCode::OK
            && environment.value()["user_settings"]["attributes"]["email_address"]
                ["verify_at_sign_up"]
                == false
        {
            observed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        observed,
        "replica B never observed the settings change made on replica A"
    );

    // Sign up through replica B.
    let created = second
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "email_address": "replica@example.test", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let created = created.value();
    assert_session_sign_up(&created, "replica sign-up");
    let user_id = created["response"]["created_user_id"]
        .as_str()
        .expect("created_user_id")
        .to_string();

    // The session was minted on B; it is valid on B (and, sharing the database,
    // on A).
    assert_me_ok(&second, &user_id, "replica B session").await;

    let fresh = orbitid_core::testing::TestClient::new(orbitid_server::build_app(second_state));
    let signed_in = fresh
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "replica@example.test", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(signed_in.status, StatusCode::OK, "{}", signed_in.text());
    created_session_id(&signed_in.value(), "replica one-shot sign-in");

    assert_profile_image_upload_ok(&fresh, "replica profile image upload").await;
}

/// Phone sign-up with verification off is the same class of bug: the phone is a
/// required identifier the instance does not verify, so the sign-up completes on
/// create and a fresh client can sign in one-shot by phone.
#[tokio::test]
async fn phone_sign_up_completes_on_create_when_verification_is_off() {
    let e2e = E2e::new().await;

    patch_instance(
        &e2e,
        json!({
            "attributes": {
                "emailAddress": { "required": false },
                "phoneNumber": {
                    "enabled": true,
                    "required": true,
                    "usedForFirstFactor": true,
                    "verifyAtSignUp": false
                }
            }
        }),
    )
    .await;

    let browser = e2e.browser();
    let created = browser
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "phone_number": "+15551234567", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let created = created.value();
    assert_session_sign_up(&created, "phone sign-up");
    let user_id = created["response"]["created_user_id"]
        .as_str()
        .expect("created_user_id")
        .to_string();
    assert_eq!(created["response"]["phone_number"], "+15551234567");

    assert_me_ok(&browser, &user_id, "phone sign-up session").await;

    let fresh = e2e.browser();
    let signed_in = fresh
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "+15551234567", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(signed_in.status, StatusCode::OK, "{}", signed_in.text());
    let signed_in = signed_in.value();
    created_session_id(&signed_in, "one-shot phone sign-in");
    assert_me_ok(&fresh, &user_id, "one-shot phone session").await;

    assert_profile_image_upload_ok(&fresh, "phone profile image upload").await;
}

/// A username-only sign-up has no identifier to verify at all; it must complete
/// on create too, and sign in one-shot by username + password.
#[tokio::test]
async fn username_only_sign_up_completes_on_create() {
    let e2e = E2e::new().await;

    patch_instance(
        &e2e,
        json!({
            "attributes": {
                "emailAddress": { "enabled": false },
                "username": {
                    "enabled": true,
                    "required": true,
                    "usedForFirstFactor": true
                }
            }
        }),
    )
    .await;

    let browser = e2e.browser();
    let created = browser
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "username": "ada_lovelace", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let created = created.value();
    assert_session_sign_up(&created, "username sign-up");
    let user_id = created["response"]["created_user_id"]
        .as_str()
        .expect("created_user_id")
        .to_string();
    assert_eq!(created["response"]["username"], "ada_lovelace");

    assert_me_ok(&browser, &user_id, "username sign-up session").await;

    let fresh = e2e.browser();
    let signed_in = fresh
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "ada_lovelace", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(signed_in.status, StatusCode::OK, "{}", signed_in.text());
    let signed_in = signed_in.value();
    created_session_id(&signed_in, "one-shot username sign-in");
    assert_me_ok(&fresh, &user_id, "one-shot username session").await;

    assert_profile_image_upload_ok(&fresh, "username profile image upload").await;
}
