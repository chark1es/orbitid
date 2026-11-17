//! HTTP tests for TOTP, backup codes and phone-number second factors
//! (`test/core/mfa.test.ts`, the `/me` parts of
//! `test/core/auth-factors-trusted-devices.test.ts`).

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::http::now;
use orbitid_credentials::mfa::totp_code_at;
use serde_json::json;

fn code_now(secret: &str) -> String {
    totp_code_at(secret, now() / 1000).expect("totp code")
}

async fn enable_totp(client: &orbitid_core::testing::TestClient) -> (String, Vec<String>) {
    let setup = client
        .request("POST", "/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_status(&setup, StatusCode::OK);
    let uri = setup.value()["response"]["uri"]
        .as_str()
        .expect("uri")
        .to_string();
    assert!(uri.starts_with("otpauth://totp/"));
    assert!(setup.value()["response"]["qr_code"]
        .as_str()
        .expect("qr")
        .starts_with("data:image/png;base64,"));
    let secret = setup.value()["response"]["secret"]
        .as_str()
        .expect("secret")
        .to_string();
    let verified = client
        .request(
            "POST",
            "/v1/client/me/totp/attempt_verification",
            Some(json!({ "code": code_now(&secret) })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
    assert_eq!(verified.value()["response"]["verified"], true);
    let codes = verified.value()["response"]["backup_codes"]
        .as_array()
        .expect("backup codes")
        .iter()
        .map(|code| code["code"].as_str().expect("code").to_string())
        .collect::<Vec<_>>();
    assert_eq!(codes.len(), 10);
    (secret, codes)
}

#[tokio::test]
async fn pending_sessions_may_only_enrol_a_factor() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "mfa": { "required": true },
            "attributes": { "authenticatorApp": { "enabled": true } },
        }))
        .await
        .expect("settings");
    let user = h.signed_in("pending@example.com", "Sup3r-secret!").await;
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&user.auth.session.id)
        .fetch_one(&h.state().pool)
        .await
        .expect("status");
    assert_eq!(status, "pending");

    let me = get_json(&user.client, "/v1/client/me").await;
    assert_status(&me, StatusCode::OK);
    assert_eq!(me.value()["response"]["id"], user.user_id);

    let blocked = user
        .client
        .request(
            "PATCH",
            "/v1/client/me",
            Some(json!({ "first_name": "Mallory" })),
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&blocked).first().map(String::as_str),
        Some("session_pending")
    );

    let blocked = user
        .client
        .request(
            "POST",
            "/v1/client/me/external_accounts",
            Some(json!({ "strategy": "oauth_google" })),
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&blocked).first().map(String::as_str),
        Some("session_pending")
    );

    let totp = user
        .client
        .request("POST", "/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_status(&totp, StatusCode::OK);
    assert!(totp.value()["response"]["uri"]
        .as_str()
        .expect("uri")
        .starts_with("otpauth://"));

    enable_totp(&user.client).await;
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&user.auth.session.id)
        .fetch_one(&h.state().pool)
        .await
        .expect("status");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn required_mfa_without_enrollable_factor_stays_active() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "mfa": { "required": true } }))
        .await
        .expect("settings");
    let user = h.signed_in("no-factor@example.com", "Sup3r-secret!").await;
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&user.auth.session.id)
        .fetch_one(&h.state().pool)
        .await
        .expect("status");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn enrols_totp_and_exposes_backup_codes() {
    let h = harness().await;
    let user = h.signed_in("totp@example.com", "Sup3r-secret!").await;
    let (secret, codes) = enable_totp(&user.client).await;
    assert_eq!(codes.len(), 10);

    let row =
        sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(&user.user_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("user");
    assert!(row.totp_verified);
    let stored = row.totp_secret_enc.expect("secret");
    assert!(!stored.contains(&secret));
    assert!(stored.starts_with("v1."));
    assert_eq!(row.backup_codes.map(|codes| codes.0.len()), Some(10));

    let totp = get_json(&user.client, "/v1/client/me/totp").await;
    assert_status(&totp, StatusCode::OK);
    assert_eq!(totp.value()["response"]["verified"], true);
    assert_eq!(totp.value()["response"]["secret"], serde_json::Value::Null);
    assert_eq!(totp.value()["response"]["backup_code_enabled"], true);
}

#[tokio::test]
async fn regenerates_backup_codes_and_disables_totp() {
    let h = harness().await;
    let user = h.signed_in("regen@example.com", "Sup3r-secret!").await;
    enable_totp(&user.client).await;

    let regenerated = user
        .client
        .request("POST", "/v1/client/me/backup_codes", Some(json!({})), &[])
        .await;
    assert_status(&regenerated, StatusCode::OK);
    assert_eq!(
        regenerated.value()["response"].as_array().map(Vec::len),
        Some(10)
    );

    let disabled = user
        .client
        .request("DELETE", "/v1/client/me/totp", None, &[])
        .await;
    assert_status(&disabled, StatusCode::OK);
    assert_eq!(disabled.value()["response"]["verified"], false);
}

#[tokio::test]
async fn backup_codes_require_totp() {
    let h = harness().await;
    let user = h.signed_in("nocodes@example.com", "Sup3r-secret!").await;
    let response = user
        .client
        .request("POST", "/v1/client/me/backup_codes", Some(json!({})), &[])
        .await;
    assert_status(&response, StatusCode::BAD_REQUEST);
    assert_eq!(
        error_codes(&response).first().map(String::as_str),
        Some("totp_not_enabled")
    );
}

#[tokio::test]
async fn disabling_totp_revokes_trusted_devices() {
    let h = harness().await;
    let user = h
        .signed_in("revoke-devices@example.com", "Sup3r-secret!")
        .await;
    enable_totp(&user.client).await;
    let now_ms = now();
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at, created_at, \
         updated_at) VALUES ('tdev_totp',$1,'hash','Laptop',$2,$3,$3)",
    )
    .bind(&user.user_id)
    .bind(now_ms + 30 * 24 * 3_600_000)
    .bind(now_ms)
    .execute(&h.state().pool)
    .await
    .expect("device");

    user.client
        .request("DELETE", "/v1/client/me/totp", None, &[])
        .await;

    let revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM trusted_devices WHERE id = 'tdev_totp'")
            .fetch_one(&h.state().pool)
            .await
            .expect("device row");
    assert!(revoked.is_some());
}

fn sms_code(state: &orbitid_core::AppState) -> String {
    let sms = orbitid_platform::mail::get_sms_outbox(state)
        .pop()
        .expect("sms");
    sms.body
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
}

#[tokio::test]
async fn uses_a_verified_phone_number_as_a_second_factor() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "attributes": {
                "phoneNumber": {
                    "enabled": true,
                    "usedForFirstFactor": true,
                    "usedForSecondFactor": true,
                    "verifications": ["phone_code"],
                }
            }
        }))
        .await
        .expect("settings");
    let user = h.signed_in("phone@example.com", "Sup3r-secret!").await;

    let phone = user
        .client
        .request(
            "POST",
            "/v1/client/me/phone_numbers",
            Some(json!({ "phone_number": "+15550001111" })),
            &[],
        )
        .await;
    assert_status(&phone, StatusCode::OK);
    let phone_id = phone.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    assert!(phone_id.starts_with("idn_p_"));

    let prepared = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/phone_numbers/{phone_id}/prepare_verification"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_status(&prepared, StatusCode::OK);
    let code = sms_code(h.state());
    let verified = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/phone_numbers/{phone_id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
    assert_eq!(
        verified.value()["response"]["verification"]["status"],
        "verified"
    );

    let patched = user
        .client
        .request(
            "PATCH",
            &format!("/v1/client/me/phone_numbers/{phone_id}"),
            Some(json!({
                "reserved_for_second_factor": true,
                "default_second_factor": true,
            })),
            &[],
        )
        .await;
    assert_status(&patched, StatusCode::OK);
    assert_eq!(
        patched.value()["response"]["reserved_for_second_factor"],
        true
    );
    assert_eq!(patched.value()["response"]["default_second_factor"], true);

    let listed = get_json(&user.client, "/v1/client/me/phone_numbers").await;
    assert_eq!(listed.value()["response"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn enrolling_a_verified_phone_activates_a_pending_session() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "mfa": { "required": true },
            "attributes": {
                "phoneNumber": { "enabled": true, "usedForSecondFactor": true }
            }
        }))
        .await
        .expect("settings");
    let user = h
        .signed_in("pending-phone@example.com", "Sup3r-secret!")
        .await;
    let now_ms = now();
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, \
         reserved_for_second_factor, default_second_factor, created_at, updated_at) \
         VALUES ('idn_p_pending',$1,'+15551230000',true,$2,false,false,$2,$2)",
    )
    .bind(&user.user_id)
    .bind(now_ms)
    .execute(&h.state().pool)
    .await
    .expect("phone");

    let patched = user
        .client
        .request(
            "PATCH",
            "/v1/client/me/phone_numbers/idn_p_pending",
            Some(json!({ "reserved_for_second_factor": true })),
            &[],
        )
        .await;
    assert_status(&patched, StatusCode::OK);
    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&user.auth.session.id)
        .fetch_one(&h.state().pool)
        .await
        .expect("status");
    assert_eq!(status, "active");
}

#[tokio::test]
async fn totp_setup_shape_and_refuses_a_second_setup() {
    let h = harness().await;
    let user = h.signed_in("totp-shape@example.com", "Sup3r-secret!").await;

    let initial = get_json(&user.client, "/v1/client/me/totp").await;
    assert_status(&initial, StatusCode::OK);
    assert_eq!(initial.value()["response"]["object"], "totp");
    assert_eq!(initial.value()["response"]["id"], user.user_id);
    assert_eq!(initial.value()["response"]["verified"], false);
    assert_eq!(
        initial.value()["response"]["secret"],
        serde_json::Value::Null
    );
    assert_eq!(initial.value()["response"]["uri"], serde_json::Value::Null);
    assert_eq!(
        initial.value()["response"]["qr_code"],
        serde_json::Value::Null
    );
    assert_eq!(initial.value()["response"]["backup_code_enabled"], false);

    let setup = user
        .client
        .request("POST", "/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_status(&setup, StatusCode::OK);
    assert!(setup.value()["response"]["uri"]
        .as_str()
        .expect("uri")
        .starts_with("otpauth://totp/"));
    assert!(setup.value()["response"]["qr_code"]
        .as_str()
        .expect("qr")
        .starts_with("data:image/png;base64,"));
    assert_eq!(setup.value()["response"]["verified"], false);

    // Enrol, then a second setup is refused.
    let secret = setup.value()["response"]["secret"]
        .as_str()
        .expect("secret")
        .to_string();
    let enabled = enable_totp_code(&user.client, &secret).await;
    assert_eq!(enabled, StatusCode::OK);
    let again = user
        .client
        .request("POST", "/v1/client/me/totp", Some(json!({})), &[])
        .await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error_codes(&again).first().map(String::as_str),
        Some("totp_not_enabled")
    );
}

async fn enable_totp_code(client: &orbitid_core::testing::TestClient, secret: &str) -> StatusCode {
    client
        .request(
            "POST",
            "/v1/client/me/totp/attempt_verification",
            Some(json!({ "code": code_now(secret) })),
            &[],
        )
        .await
        .status
}
