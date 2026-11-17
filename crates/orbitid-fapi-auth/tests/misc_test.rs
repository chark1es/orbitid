//! Reverting, second factors, cookie renewal and session policy.

mod common;

use axum::http::StatusCode;
use common::{harness, password_sign_in, seed_user};
use orbitid_platform::mail::{get_sms_outbox, latest_code_for};

fn code_for(h: &common::Harness, email: &str) -> String {
    latest_code_for(&h.app.app_state(), email, None).expect("verification code")
}

#[tokio::test]
async fn reverification_with_password_and_email_code() {
    let h = harness().await;
    seed_user(&h, "reverify@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "reverify@example.com", "Sup3r-secret!").await;
    let session_id = sign_in["created_session_id"].as_str().unwrap().to_string();

    let initial = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(initial.status, StatusCode::OK, "{}", initial.text());
    let value = initial.value();
    assert_eq!(value["response"]["verification"]["status"], "unverified");
    assert_eq!(
        value["response"]["verification"]["strategy"],
        "first_factor"
    );

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "password" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(prepared.value()["response"]["strategy"], "password");

    let wrong = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "password", "password": "nope" })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(wrong.error_codes(), vec!["form_password_incorrect"]);

    let ok = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "password",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert_eq!(ok.value()["response"]["verification"]["status"], "verified");

    let ages = h
        .client
        .get(
            &format!("/v1/client/sessions/{session_id}/verification"),
            &[],
        )
        .await;
    assert_eq!(ages.status, StatusCode::OK);
    assert_eq!(ages.value()["response"]["first_factor"], 0);
    assert!(ages.value()["response"]["second_factor"].is_null());

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code = code_for(&h, "reverify@example.com");
    let ok = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert_eq!(ok.value()["response"]["verification"]["status"], "verified");
}

#[tokio::test]
async fn email_code_as_a_second_factor() {
    let h = harness().await;
    seed_user(&h, "second@example.com", "Sup3r-secret!").await;
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": { "emailAddress": { "usedForSecondFactor": true } }
        }))
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "second@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor");
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    assert!(sign_in["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "email_code"));

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(
        prepared.value()["response"]["second_factor_verification"]["strategy"],
        "email_code"
    );
    let code = code_for(&h, "second@example.com");
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn phone_code_as_a_second_factor() {
    let h = harness().await;
    let user = seed_user(&h, "phone@example.com", "Sup3r-secret!").await;
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": { "phoneNumber": {
                "enabled": true,
                "usedForSecondFactor": true,
                "verifyAtSignUp": true,
            } }
        }))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, reserved_for_second_factor, \
         default_second_factor, created_at, updated_at) \
         VALUES ('idn_p_test', $1, '+15555550100', true, $2, true, true, $2, $2)",
    )
    .bind(&user.user.id)
    .bind(orbitid_core::http::now())
    .execute(&h.state().pool)
    .await
    .unwrap();

    let sign_in = password_sign_in(&h, "phone@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor");
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "phone_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let sms = get_sms_outbox(&h.app.app_state());
    let body = sms.last().expect("sms").body.clone();
    let code = body
        .split_whitespace()
        .find(|part| part.len() == 6 && part.chars().all(|c| c.is_ascii_digit()))
        .expect("code in sms")
        .to_string();
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "phone_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    assert_eq!(attempted.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn client_cookie_is_reissued_when_old() {
    let h = harness().await;
    let first = h.client.get("/v1/client", &[]).await;
    assert_eq!(first.status, StatusCode::OK);
    let client_id = first.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let old = orbitid_core::http::now() - 2 * 24 * 60 * 60 * 1000;
    sqlx::query("UPDATE clients SET token_issued_at = $1, updated_at = $1 WHERE id = $2")
        .bind(old)
        .bind(&client_id)
        .execute(&h.state().pool)
        .await
        .unwrap();
    let renewed = h.client.get("/v1/client", &[]).await;
    assert_eq!(renewed.status, StatusCode::OK);
    let set_cookie = renewed
        .headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(set_cookie.contains("__client="), "{set_cookie}");
}

#[tokio::test]
async fn single_session_mode_refuses_a_second_sign_in() {
    let h = harness().await;
    seed_user(&h, "single@example.com", "Sup3r-secret!").await;
    h.state()
        .settings
        .update(serde_json::json!({ "session": { "multiSession": false } }))
        .await
        .unwrap();
    let first = password_sign_in(&h, "single@example.com", "Sup3r-secret!").await;
    assert_eq!(first["status"], "complete");
    let second = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "single@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(second.status, StatusCode::BAD_REQUEST);
    assert_eq!(second.error_codes(), vec!["identifier_already_signed_in"]);
}

#[tokio::test]
async fn redirect_urls_are_bounded_to_configured_origins() {
    let h = harness().await;
    seed_user(&h, "redirect@example.com", "Sup3r-secret!").await;
    let allowed = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "redirect@example.com",
                "strategy": "email_link",
                "redirect_url": "http://localhost:5173/app",
            })),
            &[],
        )
        .await;
    assert_eq!(allowed.status, StatusCode::OK, "{}", allowed.text());
    let sign_in_id = allowed.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_first_factor"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let link = orbitid_platform::mail::latest_link_for(&h.app.app_state(), "redirect@example.com")
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
    let location = verified.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.starts_with("http://localhost:5173/app"),
        "{location}"
    );

    let refused = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "redirect@example.com",
                "action_complete_redirect_url": "https://evil.example/after",
            })),
            &[],
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(refused.error_codes(), vec!["form_param_format_invalid"]);
}

#[tokio::test]
async fn reverification_bodies_are_validated_like_the_ts_schemas() {
    let h = harness().await;
    seed_user(&h, "schema@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "schema@example.com", "Sup3r-secret!").await;
    let session_id = sign_in["created_session_id"].as_str().unwrap().to_string();

    let bad_level = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify"),
            Some(serde_json::json!({ "level": "everything" })),
            &[],
        )
        .await;
    assert_eq!(bad_level.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(bad_level.error_codes(), vec!["form_param_format_invalid"]);

    let bad_strategy = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "pigeon" })),
            &[],
        )
        .await;
    assert_eq!(bad_strategy.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        bad_strategy.value()["errors"][0]["meta"]["param_name"],
        "strategy"
    );

    let missing_strategy = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_second_factor"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    assert_eq!(missing_strategy.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(missing_strategy.error_codes(), vec!["form_param_missing"]);

    let no_mfa = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "totp" })),
            &[],
        )
        .await;
    assert_eq!(no_mfa.status, StatusCode::BAD_REQUEST);
    assert_eq!(no_mfa.error_codes(), vec!["mfa_not_enabled"]);

    let empty_code = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": "" })),
            &[],
        )
        .await;
    assert_eq!(empty_code.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(empty_code.error_codes(), vec!["form_param_format_invalid"]);
}

#[tokio::test]
async fn session_second_factor_reverification_with_totp() {
    let h = harness().await;
    let user = seed_user(&h, "reverify-totp@example.com", "Sup3r-secret!").await;
    let secret = orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();
    let sign_in = password_sign_in(&h, "reverify-totp@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor");
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();
    let totp =
        orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000).expect("totp");
    let done = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": totp })),
            &[],
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    let session_id = done.value()["response"]["created_session_id"]
        .as_str()
        .unwrap()
        .to_string();

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "totp" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(prepared.value()["response"]["strategy"], "totp");

    let wrong = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": "000000" })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(wrong.error_codes(), vec!["form_code_incorrect"]);

    // Re-verification needs a fresh TOTP step: the sign-in above already
    // consumed the current one (replay protection).
    let totp = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000 + 30)
        .expect("totp");
    let ok = h
        .client
        .post(
            &format!("/v1/client/sessions/{session_id}/verify/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "totp", "code": totp })),
            &[],
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert_eq!(ok.value()["response"]["verification"]["status"], "verified");

    let ages = h
        .client
        .get(
            &format!("/v1/client/sessions/{session_id}/verification"),
            &[],
        )
        .await;
    assert_eq!(ages.value()["response"]["second_factor"], 0);
}

#[tokio::test]
async fn backup_code_second_factor_is_single_use() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": { "backupCode": { "enabled": true } }
        }))
        .await
        .unwrap();
    let user = seed_user(&h, "backup@example.com", "Sup3r-secret!").await;
    let codes = orbitid_credentials::generate_backup_codes(3);
    sqlx::query("UPDATE users SET backup_codes = $1 WHERE id = $2")
        .bind(sqlx::types::Json(serde_json::json!(codes.hashed)))
        .bind(&user.user.id)
        .execute(&h.state().pool)
        .await
        .unwrap();

    let sign_in = password_sign_in(&h, "backup@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor");
    assert!(sign_in["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "backup_code"));
    let sign_in_id = sign_in["id"].as_str().unwrap().to_string();

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "backup_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(
        prepared.value()["response"]["second_factor_verification"]["strategy"],
        "backup_code"
    );

    let code = codes.plain[0].clone();
    let done = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "backup_code", "code": code.clone() })),
            &[],
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    assert_eq!(done.value()["response"]["status"], "complete");

    // The spent code cannot be replayed on a new sign-in.
    let second = password_sign_in(&h, "backup@example.com", "Sup3r-secret!").await;
    assert_eq!(second["status"], "needs_second_factor");
    let second_id = second["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{second_id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "backup_code" })),
            &[],
        )
        .await;
    let replay = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{second_id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "backup_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(replay.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(replay.error_codes(), vec!["form_code_incorrect"]);
}

#[tokio::test]
async fn a_second_factor_must_differ_from_the_first_channel() {
    let h = harness().await;
    // Email is offered as a second factor, but the first factor is an email code.
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": { "emailAddress": { "usedForSecondFactor": true } }
        }))
        .await
        .unwrap();
    let user = seed_user(&h, "same-channel@example.com", "Sup3r-secret!").await;
    orbitid_identity::testing::enable_totp(h.state(), &user.user.id)
        .await
        .unwrap();

    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "same-channel@example.com",
                "strategy": "email_code",
            })),
            &[],
        )
        .await
        .value()["response"]
        .clone();
    let id = created["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    let code = code_for(&h, "same-channel@example.com");
    let escalated = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(escalated.status, StatusCode::OK, "{}", escalated.text());
    assert_eq!(
        escalated.value()["response"]["status"],
        "needs_second_factor"
    );
    assert!(!escalated.value()["response"]["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "email_code"));
    assert!(escalated.value()["response"]["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|factor| factor["strategy"] == "totp"));

    let blocked = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::BAD_REQUEST);
    assert_eq!(blocked.error_codes(), vec!["strategy_for_user_invalid"]);
}
