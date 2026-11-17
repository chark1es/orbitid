//! Ported from `test/core/{auth,auth-factors-email,first-factor-policy,
//! sign-in-method,password-recovery-sessions,mfa}.test.ts` and
//! `test/security/{first-factor-single-use,first-factor-strategy-switch}.test.ts`.

mod common;

use axum::http::StatusCode;
use common::{build, harness, password_sign_in, seed_user};
use orbitid_core::testing::TestClient;
use orbitid_platform::mail::latest_code_for;

fn code_for(h: &common::Harness, email: &str) -> String {
    latest_code_for(&h.app.app_state(), email, None).expect("verification code")
}

async fn create_sign_in(h: &common::Harness, body: serde_json::Value) -> serde_json::Value {
    let response = h.client.post("/v1/client/sign_ins", Some(body), &[]).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["response"].clone()
}

/// Drives a reset-password sign-in to `needs_new_password` and returns the id.
async fn start_reset(h: &common::Harness, email: &str) -> String {
    let sign_in = create_sign_in(
        h,
        serde_json::json!({
            "identifier": email,
            "strategy": "reset_password_email_code",
        }),
    )
    .await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = latest_code_for(
        &h.app.app_state(),
        email,
        Some(orbitid_platform::mail::EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    let verified = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(verified.value()["response"]["status"], "needs_new_password");
    sign_in_id
}

#[tokio::test]
async fn email_code_sign_in() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(&h, serde_json::json!({ "identifier": "user@example.com" })).await;
    assert_eq!(sign_in["status"], "needs_first_factor");
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    assert!(sign_in["supported_first_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "email_code"));

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(
        prepared.value()["response"]["first_factor_verification"]["strategy"],
        "email_code"
    );

    let code = code_for(&h, "user@example.com");
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn a_spent_code_cannot_be_replayed() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(&h, serde_json::json!({ "identifier": "user@example.com" })).await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    let code = code_for(&h, "user@example.com");
    let first = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code.clone() })),
            &[],
        )
        .await;
    assert_eq!(first.value()["response"]["status"], "complete");
    let replay = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(replay.error_codes(), vec!["client_state_invalid"]);
}

#[tokio::test]
async fn strategy_switch_is_refused_but_password_is_preparation_free() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(&h, serde_json::json!({ "identifier": "user@example.com" })).await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    let switched = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "phone_code", "code": "123456" })),
            &[],
        )
        .await;
    assert_eq!(switched.status, StatusCode::BAD_REQUEST);
    assert_eq!(switched.error_codes(), vec!["client_state_invalid"]);

    let password = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "password", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_eq!(password.status, StatusCode::OK, "{}", password.text());
    assert_eq!(password.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn email_link_sign_in_advances_the_origin_device() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(&h, serde_json::json!({ "identifier": "user@example.com" })).await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_link" })),
            &[],
        )
        .await;
    let link = orbitid_platform::mail::latest_link_for(&h.app.app_state(), "user@example.com")
        .expect("magic link");
    let token = url::Url::parse(&link)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap();
    let verified = h
        .client
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert_eq!(verified.status, StatusCode::FOUND);
    assert!(verified
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=verified"));

    // The link advanced the owning sign-in server-side; the origin device sees
    // the completed session on its next client poll.
    let client = h.client.get("/v1/client", &[]).await.value();
    assert!(client["response"]["sign_in"].is_null());
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
    let _ = sign_in_id;
}

#[tokio::test]
async fn two_concurrent_clicks_on_one_link_advance_the_sign_in_once() {
    let h = harness().await;
    seed_user(&h, "double@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({ "identifier": "double@example.com" }),
    )
    .await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_link" })),
            &[],
        )
        .await;
    let link = orbitid_platform::mail::latest_link_for(&h.app.app_state(), "double@example.com")
        .expect("magic link");
    let token = url::Url::parse(&link)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap();
    let path = format!("/v1/verify?token={token}");
    let (first, second) = tokio::join!(h.client.get(&path, &[]), h.client.get(&path, &[]));
    // Both clicks carry the same OLD client cookie. The winner advances the
    // sign-in and rotates the client token; a second click whose owner-client
    // check runs after that commit no longer matches and correctly answers
    // `different_browser`, while one that checks before it waits on the client
    // lock and answers `verified`. Which of the two happens is timing, so only
    // the winner (the response carrying the rotated cookie) must be `verified`.
    let mut rotations = 0;
    for response in [&first, &second] {
        assert_eq!(response.status, StatusCode::FOUND);
        let location = response.headers.get("location").unwrap().to_str().unwrap();
        if response.headers.get("set-cookie").is_some() {
            rotations += 1;
            assert!(location.contains("__orbit_status=verified"), "{location}");
        } else {
            assert!(
                location.contains("__orbit_status=verified")
                    || location.contains("__orbit_status=different_browser"),
                "{location}"
            );
        }
    }
    assert_eq!(rotations, 1, "exactly one click advances the attempt");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&h.app.app_state().pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

#[tokio::test]
async fn password_reset_flow_changes_the_password_once() {
    let h = harness().await;
    seed_user(&h, "reset@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({
            "identifier": "reset@example.com",
            "strategy": "reset_password_email_code",
        }),
    )
    .await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    assert_eq!(sign_in["status"], "needs_first_factor");
    assert!(sign_in["supported_first_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "reset_password_email_code"));

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = latest_code_for(
        &h.app.app_state(),
        "reset@example.com",
        Some(orbitid_platform::mail::EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    let verified = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(verified.value()["response"]["status"], "needs_new_password");

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/reset_password"),
            Some(serde_json::json!({ "password": "An0ther-secret!" })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    assert_eq!(reset.value()["response"]["status"], "complete");

    // The authorization is single-use.
    let again = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/reset_password"),
            Some(serde_json::json!({ "password": "Y3t-another!" })),
            &[],
        )
        .await;
    assert_eq!(again.status, StatusCode::BAD_REQUEST);
    assert_eq!(again.error_codes(), vec!["client_state_invalid"]);

    let old = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "reset@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(old.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(old.error_codes(), vec!["form_password_incorrect"]);
    let fresh = password_sign_in(&h, "reset@example.com", "An0ther-secret!").await;
    assert_eq!(fresh["status"], "complete");
}

#[tokio::test]
async fn password_reset_ends_other_sessions_and_revokes_trusted_devices() {
    let h = harness().await;
    let user = seed_user(&h, "reset-revoke@example.com", "Sup3r-secret!").await;
    let now = orbitid_core::http::now();
    let device_id = orbitid_core::ids::new_id("td");
    sqlx::query(
        "INSERT INTO trusted_devices (id, user_id, token_hash, expires_at, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&user.user.id)
    .bind("reset-revoke-device-hash")
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&h.state().pool)
    .await
    .expect("trusted device");

    // A second browser signs in so there is another live session to revoke.
    let other = h.other_browser();
    let other_sign_in = other
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "reset-revoke@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(
        other_sign_in.status,
        StatusCode::OK,
        "{}",
        other_sign_in.text()
    );
    let old_session: String = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE user_id = $1 AND status = 'active' LIMIT 1",
    )
    .bind(&user.user.id)
    .fetch_one(&h.state().pool)
    .await
    .expect("old session");

    let sign_in_id = start_reset(&h, "reset-revoke@example.com").await;
    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/reset_password"),
            Some(serde_json::json!({ "password": "An0ther-secret!" })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());

    let status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
        .bind(&old_session)
        .fetch_one(&h.state().pool)
        .await
        .expect("old session");
    assert_eq!(status, "revoked", "the other session must be revoked");
    assert!(
        orbitid_identity::tokens::sign_session_token(
            h.state(),
            &old_session,
            orbitid_identity::tokens::SignSessionTokenOptions::default(),
        )
        .await
        .is_err(),
        "the revoked session's token must no longer be mintable"
    );

    let revoked_at: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM trusted_devices WHERE id = $1")
            .bind(&device_id)
            .fetch_one(&h.state().pool)
            .await
            .expect("trusted device");
    assert!(
        revoked_at.is_some(),
        "a password reset must revoke every trusted device"
    );

    password_sign_in(&h, "reset-revoke@example.com", "An0ther-secret!").await;
}

#[tokio::test]
async fn reset_password_requires_a_verified_recovery() {
    let h = harness().await;
    seed_user(&h, "reset@example.com", "Sup3r-secret!").await;
    let sign_in =
        create_sign_in(&h, serde_json::json!({ "identifier": "reset@example.com" })).await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let response = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/reset_password"),
            Some(serde_json::json!({ "password": "An0ther-secret!" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_codes(), vec!["client_state_invalid"]);
}

#[tokio::test]
async fn totp_second_factor() {
    let h = harness().await;
    let user = seed_user(&h, "mfa@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "mfa@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor");
    assert!(sign_in["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "totp"));
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();

    let wrong = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": "000000" })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(wrong.error_codes(), vec!["form_code_incorrect"]);

    let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
        .expect("totp code");
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
    assert_eq!(
        attempted.value()["response"]["second_factor_verification"]["status"],
        "verified"
    );
}

#[tokio::test]
async fn trusted_device_skips_the_second_factor() {
    let h = harness().await;
    let user = seed_user(&h, "trusted@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();
    orbitid_identity::testing::enable_trusted_devices(h.state(), 30)
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "trusted@example.com", "Sup3r-secret!").await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
        .expect("totp code");
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({
                "strategy": "totp",
                "code": code,
                "trust_device": true,
            })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert!(h
        .client
        .cookie_header()
        .unwrap()
        .contains("__orbit_trusted="));

    let second = password_sign_in(&h, "trusted@example.com", "Sup3r-secret!").await;
    assert_eq!(second["status"], "complete");
    assert_eq!(
        second["second_factor_verification"]["strategy"],
        "trusted_device"
    );
}

#[tokio::test]
async fn banned_users_cannot_start_a_sign_in() {
    let h = harness().await;
    let user = seed_user(&h, "banned@example.com", "Sup3r-secret!").await;
    sqlx::query("UPDATE users SET banned = true WHERE id = $1")
        .bind(&user.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "banned@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.error_codes(), vec!["user_banned"]);
}

#[tokio::test]
async fn disabled_first_factors_are_refused_by_the_api() {
    let h = harness().await;
    seed_user(&h, "passkey@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({ "identifier": "passkey@example.com" }),
    )
    .await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let response = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "passkey" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_codes(), vec!["strategy_for_user_invalid"]);
}

#[tokio::test]
async fn password_sign_in_is_refused_once_the_instance_turns_it_off() {
    let h = harness().await;
    seed_user(&h, "password-off@example.com", "Sup3r-secret!").await;
    h.state()
        .settings
        .update(
            serde_json::json!({ "attributes": { "password": { "usedForFirstFactor": false } } }),
        )
        .await
        .unwrap();
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({ "identifier": "password-off@example.com" }),
    )
    .await;
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let response = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "password", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_codes(), vec!["strategy_for_user_invalid"]);
}

#[tokio::test]
async fn invalid_redirect_url_is_refused() {
    let h = harness().await;
    seed_user(&h, "user@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "user@example.com",
                "redirect_url": "https://evil.example/steal",
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["form_param_format_invalid"]);
}

#[tokio::test]
async fn operator_tickets_are_refused_instead_of_creating_a_session() {
    let h = harness().await;
    seed_user(&h, "ticket@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "ticket@example.com",
                "ticket": "tkt_operator_minted",
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["ticket_invalid"]);
}

#[tokio::test]
async fn too_many_failed_passwords_lock_the_account() {
    let h = harness().await;
    seed_user(&h, "lockout@example.com", "Sup3r-secret!").await;
    h.state()
        .settings
        .update(serde_json::json!({
            "mfa": { "maxAttempts": 3, "lockoutDurationSeconds": 60 }
        }))
        .await
        .unwrap();
    for attempt in 0..3 {
        let response = h
            .client
            .post(
                "/v1/client/sign_ins",
                Some(serde_json::json!({
                    "identifier": "lockout@example.com",
                    "password": format!("WrongPassword-{attempt}!"),
                })),
                &[],
            )
            .await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(response.error_codes(), vec!["form_password_incorrect"]);
    }

    let locked = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "lockout@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(locked.status, StatusCode::FORBIDDEN);
    assert_eq!(locked.error_codes(), vec!["user_locked"]);
    assert!(locked.value()["errors"][0]["meta"]["lockout_expires_in_seconds"].is_number());
}

#[tokio::test]
async fn wrong_verification_codes_count_against_the_attempt_limit() {
    let h = harness().await;
    seed_user(&h, "attempts@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({ "identifier": "attempts@example.com", "strategy": "email_code" }),
    )
    .await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;

    let mut last = String::new();
    for _ in 0..5 {
        let response = h
            .client
            .post(
                &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
                Some(serde_json::json!({ "strategy": "email_code", "code": "000000" })),
                &[],
            )
            .await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
        last = response.error_codes().first().cloned().unwrap_or_default();
    }
    assert_eq!(last, "too_many_attempts");

    // Even the right code is refused once the verification is exhausted.
    let right = code_for(&h, "attempts@example.com");
    let response = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": right })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["too_many_attempts"]);
}

#[tokio::test]
async fn sign_in_emits_exactly_one_client_cookie() {
    let h = harness().await;
    seed_user(&h, "cookie@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "cookie@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let client_cookies: Vec<&str> = response
        .headers
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter(|value| value.starts_with("__client="))
        .collect();
    assert_eq!(client_cookies.len(), 1, "got {client_cookies:?}");
    let clients: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clients")
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(clients, 1, "bootstrap must not leave an orphan client row");
}

#[tokio::test]
async fn a_totp_code_cannot_be_replayed_over_http() {
    let h = harness().await;
    let user = seed_user(&h, "totp-replay@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "totp-replay@example.com", "Sup3r-secret!").await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
        .expect("totp code");
    let first = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": code })),
            &[],
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());

    let second_sign_in = password_sign_in(&h, "totp-replay@example.com", "Sup3r-secret!").await;
    let second_id = second_sign_in["id"].as_str().unwrap().to_string();
    let replay = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{second_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": code })),
            &[],
        )
        .await;
    assert_eq!(replay.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(replay.error_codes(), vec!["form_code_incorrect"]);

    let next = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000 + 30)
        .expect("next totp code");
    let accepted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{second_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": next })),
            &[],
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
}

#[tokio::test]
async fn concurrent_completion_creates_one_session() {
    let h = harness().await;
    let user = seed_user(&h, "double@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "double@example.com", "Sup3r-secret!").await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
        .expect("totp code");
    let cookie = h.client.cookie_header().expect("cookie");
    let left = TestClient::with_cookie(build(h.state().clone()), &cookie);
    let right = TestClient::with_cookie(build(h.state().clone()), &cookie);
    let path = format!("/v1/client/sign_ins/{id}/attempt_second_factor");
    let body = serde_json::json!({ "strategy": "totp", "code": code });
    let (first, second) = tokio::join!(
        left.post(&path, Some(body.clone()), &[]),
        right.post(&path, Some(body), &[]),
    );
    let ok = [&first, &second]
        .into_iter()
        .filter(|response| response.status == StatusCode::OK)
        .count();
    assert_eq!(ok, 1, "first={} second={}", first.text(), second.text());
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions WHERE client_id = \
         (SELECT client_id FROM sign_ins WHERE id = $1)",
    )
    .bind(&id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(sessions, 1);
}

#[tokio::test]
async fn completing_the_same_sign_in_twice_is_atomic() {
    let h = harness().await;
    seed_user(&h, "atomic@example.com", "Sup3r-secret!").await;
    let sign_in = create_sign_in(
        &h,
        serde_json::json!({ "identifier": "atomic@example.com" }),
    )
    .await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    let row = sqlx::query_as::<_, orbitid_core::models::SignInRow>(
        "SELECT * FROM sign_ins WHERE id = $1",
    )
    .bind(&id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    let state = h.state().clone();
    let options = orbitid_fapi_auth::signin::complete::CompleteOptions::default();
    let (left, right) = tokio::join!(
        orbitid_fapi_auth::signin::complete::complete_sign_in(&state, &row, &options),
        orbitid_fapi_auth::signin::complete::complete_sign_in(&state, &row, &options),
    );
    let completed = [left.is_ok(), right.is_ok()]
        .into_iter()
        .filter(|ok| *ok)
        .count();
    assert_eq!(completed, 1);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE client_id = $1")
        .bind(&row.client_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

/// Regression for the "one sign-in can mint several sessions" race: every
/// writer of the attempt row is a guarded compare-and-swap, so a stale password
/// attempt can never restore `needs_first_factor` after another request
/// committed completion. Before the fix, the unconditional status write in
/// `attempt_password` produced several sessions (reproduced at 7/5/5).
#[tokio::test]
async fn concurrent_password_attempts_on_one_sign_in_mint_one_session() {
    for round in 0..5 {
        let h = harness().await;
        seed_user(&h, "race-password@example.com", "Sup3r-secret!").await;
        let sign_in = create_sign_in(
            &h,
            serde_json::json!({ "identifier": "race-password@example.com" }),
        )
        .await;
        let id = sign_in["id"].as_str().unwrap().to_string();
        let cookie = h.client.cookie_header().expect("client cookie");
        let path = format!("/v1/client/sign_ins/{id}/attempt_first_factor");
        let body = serde_json::json!({ "strategy": "password", "password": "Sup3r-secret!" });
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let client = TestClient::with_cookie(build(h.state().clone()), &cookie);
            let path = path.clone();
            let body = body.clone();
            tasks.push(tokio::spawn(async move {
                client.post(&path, Some(body), &[]).await
            }));
        }
        let mut ok = 0;
        for task in tasks {
            let response = task.await.unwrap();
            if response.status == StatusCode::OK {
                ok += 1;
            }
        }
        assert_eq!(ok, 1, "round {round}: exactly one password attempt wins");
        let complete: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sign_ins WHERE id = $1 AND status = 'complete'",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(complete, 1, "round {round}");
        let sessions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE client_id = \
             (SELECT client_id FROM sign_ins WHERE id = $1)",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(sessions, 1, "round {round}: one session only");
    }
}

/// Same invariant for the second factor. The TOTP step is consumed atomically,
/// and the attempt-state CAS means a stale attempt cannot complete a second
/// time even when its code check succeeded.
#[tokio::test]
async fn concurrent_second_factor_attempts_mint_one_session() {
    for round in 0..5 {
        let h = harness().await;
        let user = seed_user(&h, "race-mfa@example.com", "Sup3r-secret!").await;
        let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
            .await
            .unwrap();
        let sign_in = password_sign_in(&h, "race-mfa@example.com", "Sup3r-secret!").await;
        assert_eq!(sign_in["status"], "needs_second_factor");
        let id = sign_in["id"].as_str().unwrap().to_string();
        let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
            .expect("totp code");
        let cookie = h.client.cookie_header().expect("client cookie");
        let path = format!("/v1/client/sign_ins/{id}/attempt_second_factor");
        let body = serde_json::json!({ "strategy": "totp", "code": code });
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let client = TestClient::with_cookie(build(h.state().clone()), &cookie);
            let path = path.clone();
            let body = body.clone();
            tasks.push(tokio::spawn(async move {
                client.post(&path, Some(body), &[]).await
            }));
        }
        let mut ok = 0;
        for task in tasks {
            let response = task.await.unwrap();
            if response.status == StatusCode::OK {
                ok += 1;
            }
        }
        assert_eq!(ok, 1, "round {round}: exactly one second factor wins");
        let sessions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE client_id = \
             (SELECT client_id FROM sign_ins WHERE id = $1)",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(sessions, 1, "round {round}");
        let complete: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sign_ins WHERE id = $1 AND status = 'complete'",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(complete, 1, "round {round}");
    }
}
