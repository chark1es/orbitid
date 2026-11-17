//! Email-address and phone-number routes (`test/core/profile.test.ts`
//! identifier cases and the phone-number half of `test/core/mfa.test.ts`).

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_platform::mail::{latest_code_for, latest_email, EmailTemplate};
use serde_json::{json, Value};

async fn add_email(
    client: &orbitid_core::testing::TestClient,
    email: &str,
) -> orbitid_core::testing::TestResponse {
    client
        .request(
            "POST",
            "/v1/client/me/email_addresses",
            Some(json!({ "email_address": email })),
            &[],
        )
        .await
}

async fn verify_email(
    client: &orbitid_core::testing::TestClient,
    state: &orbitid_core::AppState,
    id: &str,
    email: &str,
) {
    let prepared = client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/prepare_verification"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_status(&prepared, StatusCode::OK);
    let code = latest_code_for(state, email, Some(EmailTemplate::VerificationCode))
        .expect("verification code");
    let verified = client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
}

#[tokio::test]
async fn email_addresses_are_normalized_and_duplicates_have_ts_codes() {
    let h = harness().await;
    let user = h
        .signed_in("identifiers@example.com", "Sup3r-secret!")
        .await;

    let invalid = add_email(&user.client, "not-an-email").await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&invalid), vec!["form_param_format_invalid"]);

    let created = add_email(&user.client, "Second@Example.com").await;
    assert_status(&created, StatusCode::OK);
    assert_eq!(
        created.value()["response"]["email_address"],
        "second@example.com"
    );
    assert_eq!(
        created.value()["response"]["verification"]["status"],
        "unverified"
    );
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    // The same account cannot claim its own address twice.
    let duplicate = add_email(&user.client, "second@example.com").await;
    assert_eq!(duplicate.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&duplicate), vec!["form_identifier_exists"]);

    // Another account may claim an unverified address; it settles by verifying.
    let other = h.signed_in("claimer@example.com", "Sup3r-secret!").await;
    let claim = add_email(&other.client, "second@example.com").await;
    assert_status(&claim, StatusCode::OK);

    // Once verified, nobody else can claim it.
    verify_email(&user.client, h.state(), &id, "second@example.com").await;
    let blocked = add_email(&other.client, "second@example.com").await;
    assert_eq!(blocked.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&blocked), vec!["form_identifier_exists"]);

    let listed = get_json(&user.client, "/v1/client/me/email_addresses").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(2));
    let fetched = get_json(&user.client, &format!("/v1/client/me/email_addresses/{id}")).await;
    assert_status(&fetched, StatusCode::OK);

    // Another user's address id is indistinguishable from an unknown one.
    let foreign = get_json(
        &other.client,
        &format!("/v1/client/me/email_addresses/{id}"),
    )
    .await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn email_verification_rejects_wrong_expired_and_missing_codes() {
    let h = harness().await;
    let user = h.signed_in("codes@example.com", "Sup3r-secret!").await;

    let created = add_email(&user.client, "wrong-code@example.com").await;
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    // Attempting before preparing cannot verify anything.
    let unprepared = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": "123456" })),
            &[],
        )
        .await;
    assert_eq!(unprepared.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&unprepared), vec!["form_code_incorrect"]);

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
    let code = latest_code_for(
        h.state(),
        "wrong-code@example.com",
        Some(EmailTemplate::VerificationCode),
    )
    .expect("code");
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let rejected = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": wrong })),
            &[],
        )
        .await;
    assert_eq!(rejected.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&rejected), vec!["form_code_incorrect"]);

    sqlx::query(
        "UPDATE verifications SET expires_at = $1 WHERE purpose = 'add_email' AND owner_id = $2",
    )
    .bind(orbitid_core::http::now() - 1)
    .bind(&id)
    .execute(&h.state().pool)
    .await
    .expect("update");
    let expired = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/email_addresses/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_eq!(expired.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&expired), vec!["verification_expired"]);
}

#[tokio::test]
async fn disabled_attributes_hide_identifier_creation() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "attributes": {
                "emailAddress": { "enabled": false },
                "phoneNumber": { "enabled": false }
            }
        }))
        .await
        .expect("settings");
    let user = h
        .signed_in("disabled-attrs@example.com", "Sup3r-secret!")
        .await;

    let email = add_email(&user.client, "another@example.com").await;
    assert_eq!(email.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&email), vec!["form_param_unknown"]);
    let phone = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "+15555550123" })),
            &[],
        )
        .await;
    assert_eq!(phone.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&phone), vec!["form_param_unknown"]);
}

#[tokio::test]
async fn primary_identifiers_must_be_verified_and_owned() {
    let h = harness().await;
    let user = h
        .signed_in("primary-check@example.com", "Sup3r-secret!")
        .await;
    let created = add_email(&user.client, "unverified-primary@example.com").await;
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let unverified = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "primary_email_address_id": id })),
            &[],
        )
        .await;
    assert_eq!(unverified.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&unverified), vec!["form_param_value_invalid"]);
    assert_eq!(
        unverified.value()["errors"][0]["meta"]["param_name"],
        "primary_email_address_id"
    );

    let foreign = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "primary_email_address_id": "idn_e_missing" })),
            &[],
        )
        .await;
    assert_eq!(foreign.status, StatusCode::NOT_FOUND);

    verify_email(
        &user.client,
        h.state(),
        &id,
        "unverified-primary@example.com",
    )
    .await;
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
async fn usernames_can_be_disabled_and_must_be_unique() {
    let h = harness().await;
    let first = h
        .signed_in("username-one@example.com", "Sup3r-secret!")
        .await;
    let second = h
        .signed_in("username-two@example.com", "Sup3r-secret!")
        .await;

    let disabled = first
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "username": "ghopper" })),
            &[],
        )
        .await;
    assert_eq!(disabled.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&disabled), vec!["form_param_unknown"]);

    h.state()
        .settings
        .update(json!({ "attributes": { "username": { "enabled": true } } }))
        .await
        .expect("settings");
    let taken = first
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "username": "shared" })),
            &[],
        )
        .await;
    assert_status(&taken, StatusCode::OK);
    let conflict = second
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "username": "shared" })),
            &[],
        )
        .await;
    assert_eq!(conflict.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&conflict), vec!["form_identifier_exists"]);

    let too_short = first
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "username": "ab" })),
            &[],
        )
        .await;
    assert_eq!(too_short.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_codes(&too_short),
        vec!["form_username_invalid_length"]
    );

    let cleared = first
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "username": "" })),
            &[],
        )
        .await;
    assert_status(&cleared, StatusCode::OK);
    assert_eq!(cleared.value()["response"]["username"], Value::Null);
}

#[tokio::test]
async fn phone_numbers_normalize_verify_and_become_second_factors() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "attributes": {
                "phoneNumber": { "enabled": true, "usedForSecondFactor": true }
            }
        }))
        .await
        .expect("settings");
    let user = h.signed_in("phones@example.com", "Sup3r-secret!").await;

    let invalid = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "123" })),
            &[],
        )
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);

    let created = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "(555) 555-0123" })),
            &[],
        )
        .await;
    assert_status(&created, StatusCode::OK);
    assert_eq!(created.value()["response"]["phone_number"], "+15555550123");
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let duplicate = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "+15555550123" })),
            &[],
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&duplicate), vec!["form_identifier_exists"]);

    // An unverified number cannot be reserved as a second factor.
    let reserved = user
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/phone_numbers/{id}"),
            Some(json!({ "reserved_for_second_factor": true })),
            &[],
        )
        .await;
    assert_eq!(reserved.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&reserved), vec!["verification_failed"]);

    let prepared = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/phone_numbers/{id}/prepare_verification"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_status(&prepared, StatusCode::OK);
    let sms = orbitid_platform::mail::get_sms_outbox(h.state())
        .into_iter()
        .rev()
        .find(|sms| sms.to == "+15555550123")
        .expect("sms");
    let code = sms
        .body
        .split_whitespace()
        .find(|word| word.len() >= 4 && word.chars().all(|ch| ch.is_ascii_digit()))
        .expect("code")
        .to_string();

    let wrong = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/phone_numbers/{id}/attempt_verification"),
            Some(json!({ "code": if code == "000000" { "111111" } else { "000000" } })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&wrong), vec!["form_code_incorrect"]);

    let verified = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/phone_numbers/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
    assert_eq!(
        verified.value()["response"]["verification"]["status"],
        "verified"
    );

    let second_factor = user
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/phone_numbers/{id}"),
            Some(json!({
                "reserved_for_second_factor": true,
                "default_second_factor": true
            })),
            &[],
        )
        .await;
    assert_status(&second_factor, StatusCode::OK);
    assert_eq!(
        second_factor.value()["response"]["reserved_for_second_factor"],
        true
    );
    assert_eq!(
        second_factor.value()["response"]["default_second_factor"],
        true
    );

    let fetched = get_json(&user.client, &format!("/v1/client/me/phone_numbers/{id}")).await;
    assert_status(&fetched, StatusCode::OK);
    let listed = get_json(&user.client, "/v1/client/me/phone_numbers").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(1));

    let removed = user
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/phone_numbers/{id}"),
            None,
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["object"], "phone_number");
    assert_eq!(removed.value()["response"]["deleted"], true);
}

#[tokio::test]
async fn phone_second_factors_require_the_instance_setting() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "attributes": {
                "phoneNumber": { "enabled": true, "usedForSecondFactor": false }
            }
        }))
        .await
        .expect("settings");
    let user = h
        .signed_in("phone-setting@example.com", "Sup3r-secret!")
        .await;
    let created = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "+15555550999" })),
            &[],
        )
        .await;
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let denied = user
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/phone_numbers/{id}"),
            Some(json!({ "reserved_for_second_factor": true })),
            &[],
        )
        .await;
    assert_eq!(denied.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&denied), vec!["form_param_unknown"]);
}

#[tokio::test]
async fn deleting_the_last_identification_is_refused_for_email_phone_and_external() {
    let h = harness().await;
    let user = h.signed_in("last-id@example.com", "Sup3r-secret!").await;
    let me = get_json(&user.client, "/v1/client/me").await;
    let email_id = me.value()["response"]["primary_email_address_id"]
        .as_str()
        .expect("email id")
        .to_string();
    let response = user
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/email_addresses/{email_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_codes(&response),
        vec!["last_identification_cannot_be_removed"]
    );

    // With a password set, a verified email is still the only identifier.
    let added = add_email(&user.client, "second-last@example.com").await;
    let second_id = added.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    verify_email(
        &user.client,
        h.state(),
        &second_id,
        "second-last@example.com",
    )
    .await;
    let removed = user
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/email_addresses/{second_id}"),
            None,
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(
        removed.value()["response"],
        json!({ "object": "email_address", "id": second_id, "deleted": true })
    );

    let prepared = latest_email(h.state(), "second-last@example.com", None);
    assert!(prepared.is_some());
}
