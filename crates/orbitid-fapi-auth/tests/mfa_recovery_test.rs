//! Ported from `test/core/{mfa-recovery,password-recovery-sessions}.test.ts`
//! and the recovery cases of `test/security/{first-factor-single-use,
//! enterprise-additional-identifications}.test.ts`.

mod common;

use axum::http::StatusCode;
use common::{harness, password_sign_in, seed_user, Harness};
use orbitid_platform::mail::{get_sms_outbox, latest_code_for, EmailTemplate};

async fn add_verified_phone(h: &Harness, user_id: &str, phone: &str, second_factor: bool) {
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, \
         reserved_for_second_factor, default_second_factor, created_at, updated_at) \
         VALUES ($1, $2, $3, true, $4, $5, $5, $4, $4)",
    )
    .bind(format!("idn_p_{}", phone.replace('+', "")))
    .bind(user_id)
    .bind(phone)
    .bind(orbitid_core::http::now())
    .bind(second_factor)
    .execute(&h.state().pool)
    .await
    .unwrap();
}

fn email_and_phone_second_factors() -> serde_json::Value {
    serde_json::json!({
        "attributes": {
            "emailAddress": {
                "enabled": true,
                "usedForFirstFactor": true,
                "usedForSecondFactor": true,
                "verifications": ["email_code"],
                "verifyAtSignUp": true,
            },
            "phoneNumber": {
                "enabled": true,
                "usedForFirstFactor": true,
                "usedForSecondFactor": true,
                "verifications": ["phone_code"],
            },
        }
    })
}

async fn create(h: &Harness, body: serde_json::Value) -> serde_json::Value {
    let response = h.client.post("/v1/client/sign_ins", Some(body), &[]).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["response"].clone()
}

fn sms_code(h: &Harness) -> String {
    let sms = get_sms_outbox(&h.app.app_state());
    let body = sms.last().expect("sms").body.clone();
    body.split_whitespace()
        .find(|part| part.len() == 6 && part.chars().all(|c| c.is_ascii_digit()))
        .expect("code in sms")
        .to_string()
}

#[tokio::test]
async fn email_recovery_cannot_be_relabelled_as_phone_recovery() {
    let h = harness().await;
    h.state()
        .settings
        .update(email_and_phone_second_factors())
        .await
        .unwrap();
    let user = seed_user(&h, "recovery-email@example.com", "Sup3r-secret!").await;
    add_verified_phone(&h, &user.user.id, "+15550004444", true).await;

    let sign_in = create(
        &h,
        serde_json::json!({
            "identifier": "recovery-email@example.com",
            "strategy": "reset_password_email_code",
        }),
    )
    .await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "reset_password_email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        &h.app.app_state(),
        "recovery-email@example.com",
        Some(EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");

    let spoofed = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_phone_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(spoofed.status, StatusCode::BAD_REQUEST);
    assert_eq!(spoofed.error_codes(), vec!["client_state_invalid"]);

    let pending = h
        .client
        .get(&format!("/v1/client/sign_ins/{id}"), &[])
        .await;
    assert_eq!(pending.value()["response"]["status"], "needs_first_factor");
    assert_eq!(
        pending.value()["response"]["first_factor_verification"]["strategy"],
        "reset_password_email_code"
    );
    assert_eq!(
        pending.value()["response"]["first_factor_verification"]["status"],
        "unverified"
    );

    let verified = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
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
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({
                "password": "N3wSup3rSecret!",
                "sign_out_of_other_sessions": false,
            })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    let response = &reset.value()["response"];
    assert_eq!(response["status"], "needs_second_factor");
    let strategies: Vec<&str> = response["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|factor| factor["strategy"].as_str().unwrap())
        .collect();
    assert!(!strategies.contains(&"email_code"), "{strategies:?}");
    assert!(strategies.contains(&"phone_code"), "{strategies:?}");

    // The recovery authorization is single-use.
    let replay = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(replay.error_codes(), vec!["client_state_invalid"]);

    let second_reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({
                "password": "Hij4cked-Pass!",
                "sign_out_of_other_sessions": false,
            })),
            &[],
        )
        .await;
    assert_eq!(second_reset.status, StatusCode::BAD_REQUEST);
    assert_eq!(second_reset.error_codes(), vec!["client_state_invalid"]);

    // The hijacked password never took effect.
    let hijacked = h
        .other_browser()
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "recovery-email@example.com",
                "password": "Hij4cked-Pass!",
            })),
            &[],
        )
        .await;
    assert_eq!(hijacked.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        hijacked.error_codes(),
        vec!["form_password_incorrect".to_string()]
    );
}

#[tokio::test]
async fn phone_recovery_excludes_the_recovered_handset_from_the_second_factor() {
    let h = harness().await;
    h.state()
        .settings
        .update(email_and_phone_second_factors())
        .await
        .unwrap();
    let user = seed_user(&h, "recovery-phone@example.com", "Sup3r-secret!").await;
    add_verified_phone(&h, &user.user.id, "+15550005555", true).await;

    let sign_in = create(
        &h,
        serde_json::json!({
            "identifier": "+15550005555",
            "strategy": "reset_password_phone_code",
        }),
    )
    .await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_phone_code",
                "phone_number_id": format!("idn_p_{}", "15550005555"),
            })),
            &[],
        )
        .await;
    let code = sms_code(&h);

    let spoofed = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(spoofed.status, StatusCode::BAD_REQUEST);
    assert_eq!(spoofed.error_codes(), vec!["client_state_invalid"]);

    let verified = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_phone_code",
                "code": code,
            })),
            &[],
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(verified.value()["response"]["status"], "needs_new_password");
    assert_eq!(
        verified.value()["response"]["first_factor_verification"]["strategy"],
        "reset_password_phone_code"
    );

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({
                "password": "N3wSup3rSecret!",
                "sign_out_of_other_sessions": false,
            })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    let value = reset.value();
    let strategies: Vec<&str> = value["response"]["supported_second_factors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|factor| factor["strategy"].as_str().unwrap())
        .collect();
    assert!(!strategies.contains(&"phone_code"), "{strategies:?}");
    assert!(strategies.contains(&"email_code"), "{strategies:?}");
}

#[tokio::test]
async fn recovery_fails_closed_when_it_used_the_only_enrolled_second_factor() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({
            "mfa": { "required": true },
            "attributes": {
                "emailAddress": {
                    "enabled": true,
                    "usedForFirstFactor": true,
                    "usedForSecondFactor": true,
                    "verifications": ["email_code"],
                    "verifyAtSignUp": true,
                },
            },
        }))
        .await
        .unwrap();
    seed_user(&h, "only-recovery@example.com", "Sup3r-secret!").await;

    // The normal password flow really does require MFA through the mailbox.
    let normal = password_sign_in(&h, "only-recovery@example.com", "Sup3r-secret!").await;
    assert_eq!(normal["status"], "needs_second_factor");

    let sign_in = create(
        &h,
        serde_json::json!({
            "identifier": "only-recovery@example.com",
            "strategy": "reset_password_email_code",
        }),
    )
    .await;
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "reset_password_email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        &h.app.app_state(),
        "only-recovery@example.com",
        Some(EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({
                "password": "N3wSup3rSecret!",
                "sign_out_of_other_sessions": false,
            })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    let response = &reset.value()["response"];
    assert_eq!(response["status"], "needs_first_factor");
    assert!(response["created_session_id"].is_null());
    assert_eq!(
        response["first_factor_verification"]["strategy"],
        "password"
    );
    assert_eq!(
        response["first_factor_verification"]["status"],
        "unverified"
    );
    assert_eq!(
        response["first_factor_verification"]["error"]["code"],
        "needs_second_factor"
    );

    let client = h.client.get("/v1/client", &[]).await.value();
    assert!(client["response"]["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(client["response"]["last_active_session_id"].is_null());

    // The password was still changed; the normal flow now passes MFA via the mailbox.
    let old = h
        .other_browser()
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "only-recovery@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(old.status, StatusCode::UNPROCESSABLE_ENTITY);

    let retry = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "password",
                "password": "N3wSup3rSecret!",
            })),
            &[],
        )
        .await;
    assert_eq!(retry.status, StatusCode::OK, "{}", retry.text());
    assert_eq!(retry.value()["response"]["status"], "needs_second_factor");
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(&h.app.app_state(), "only-recovery@example.com", None)
        .expect("second-factor code");
    let done = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    assert_eq!(done.value()["response"]["status"], "complete");
}

#[tokio::test]
async fn reset_ends_other_sessions_before_completing() {
    let h = harness().await;
    seed_user(&h, "victim@example.com", "Sup3r-secret!").await;
    let attacker = h.other_browser();
    let attacker_session = attacker
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "victim@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await
        .value()["response"]
        .clone();
    assert_eq!(attacker_session["status"], "complete");

    let sign_in = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "victim@example.com",
                "strategy": "reset_password_email_code",
            })),
            &[],
        )
        .await
        .value()["response"]
        .clone();
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "reset_password_email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        &h.app.app_state(),
        "victim@example.com",
        Some(EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({ "password": "N3wSup3rSecret!" })),
            &[],
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.text());
    assert_eq!(reset.value()["response"]["status"], "complete");

    // The attacker's browser is signed out...
    let attacker_client = attacker.get("/v1/client", &[]).await.value();
    let active = attacker_client["response"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|session| session["status"] == "active")
        .count();
    assert_eq!(active, 0, "{}", attacker_client);

    // ...and the recovering browser is signed in with the new password.
    let recovered = h.client.get("/v1/client", &[]).await.value();
    let active = recovered["response"]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|session| session["status"] == "active")
        .count();
    assert_eq!(active, 1);
    let fresh = password_sign_in(&h, "victim@example.com", "N3wSup3rSecret!").await;
    assert_eq!(fresh["status"], "complete");
}

/// The post-reset attempt state commits with the password change. If session
/// completion then fails (here: the `session.created` insert is rejected), the
/// row must not stay in `resetting_password` after the new password is already
/// stored. The old code saved its state only after commit, so this left the
/// attempt permanently stuck.
#[tokio::test]
async fn a_failed_post_reset_completion_never_leaves_resetting_password() {
    let h = harness().await;
    seed_user(&h, "stuck@example.com", "Sup3r-secret!").await;
    let sign_in = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "identifier": "stuck@example.com",
                "strategy": "reset_password_email_code",
            })),
            &[],
        )
        .await
        .value()["response"]
        .clone();
    let id = sign_in["id"].as_str().unwrap().to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(serde_json::json!({ "strategy": "reset_password_email_code" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        &h.app.app_state(),
        "stuck@example.com",
        Some(EmailTemplate::ResetPasswordCode),
    )
    .expect("reset code");
    h.client
        .post(
            &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
            Some(serde_json::json!({
                "strategy": "reset_password_email_code",
                "code": code,
            })),
            &[],
        )
        .await;

    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&h.state().pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&h.state().pool)
    .await
    .unwrap();

    let reset = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/reset_password"),
            Some(serde_json::json!({ "password": "N3wSup3rSecret!" })),
            &[],
        )
        .await;
    assert!(reset.status.is_server_error(), "{}", reset.text());
    let status: String = sqlx::query_scalar("SELECT status FROM sign_ins WHERE id = $1")
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_ne!(status, "resetting_password");
    assert_eq!(status, "needs_first_factor");
}

/// A wrong second-factor code must persist the per-code attempt increment even
/// though the request is refused. Before the fix the transaction that ran
/// `check_code_on` was dropped, so five wrong codes still left `attempts` at
/// zero and a sixth, correct code was accepted. The TypeScript server refuses
/// the sixth attempt with `too_many_attempts`.
#[tokio::test]
async fn five_wrong_second_factor_codes_exhaust_the_verification() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({
            "attributes": {
                "emailAddress": {
                    "enabled": true,
                    "usedForFirstFactor": true,
                    "usedForSecondFactor": true,
                    "verifications": ["email_code"],
                    "verifyAtSignUp": true,
                },
            }
        }))
        .await
        .unwrap();
    seed_user(&h, "exhaust-2fa@example.com", "Sup3r-secret!").await;
    let sign_in = password_sign_in(&h, "exhaust-2fa@example.com", "Sup3r-secret!").await;
    assert_eq!(sign_in["status"], "needs_second_factor", "{sign_in}");
    let id = sign_in["id"].as_str().expect("sign-in id").to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_second_factor"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let correct = latest_code_for(&h.app.app_state(), "exhaust-2fa@example.com", None)
        .expect("second-factor code");
    let wrong = if correct == "000000" {
        "111111"
    } else {
        "000000"
    };
    let path = format!("/v1/client/sign_ins/{id}/attempt_second_factor");
    for attempt in 1..=5 {
        let refused = h
            .client
            .post(
                &path,
                Some(serde_json::json!({ "strategy": "email_code", "code": wrong })),
                &[],
            )
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "attempt {attempt}: {}",
            refused.text()
        );
        // The fifth wrong code has just reached the limit, so `check_code_on`
        // reports `too_many_attempts`; the first four report the wrong code.
        let expected = if attempt == 5 {
            vec!["too_many_attempts"]
        } else {
            vec!["form_code_incorrect"]
        };
        assert_eq!(refused.error_codes(), expected, "attempt {attempt}");
    }
    let attempts: i64 = sqlx::query_scalar(
        "SELECT attempts FROM verifications \
         WHERE purpose = 'sign_in_second_factor' AND owner_id = $1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert_eq!(
        attempts, 5,
        "every wrong code must commit its attempt increment"
    );

    // The sixth attempt is refused even with the right code, exactly like the
    // TypeScript server.
    let sixth = h
        .client
        .post(
            &path,
            Some(serde_json::json!({ "strategy": "email_code", "code": correct })),
            &[],
        )
        .await;
    assert_eq!(sixth.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(sixth.error_codes(), vec!["too_many_attempts"]);
    let verified: Option<i64> = sqlx::query_scalar(
        "SELECT verified_at FROM verifications \
         WHERE purpose = 'sign_in_second_factor' AND owner_id = $1 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_one(&h.state().pool)
    .await
    .unwrap();
    assert!(
        verified.is_none(),
        "the exhausted verification must not be marked verified"
    );
}
