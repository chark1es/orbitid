//! Ported from `test/core/auth.test.ts` (sign-up flows).

mod common;

use axum::http::StatusCode;
use common::{harness, seed_user};
use orbitid_platform::mail::{latest_code_for, latest_link_for};

fn code_for(h: &common::Harness, email: &str) -> String {
    latest_code_for(&h.app.app_state(), email, None).expect("verification code")
}

#[tokio::test]
async fn email_code_sign_up_completes_a_session() {
    let h = harness().await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "email_address": "new@example.com",
                "password": "Sup3r-secret!",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let value = created.value();
    assert_eq!(value["response"]["object"], "sign_up");
    assert_eq!(value["response"]["status"], "missing_requirements");
    assert_eq!(value["response"]["unverified_fields"][0], "email_address");
    assert_eq!(value["response"]["password_enabled"], true);
    let sign_up_id = value["response"]["id"].as_str().unwrap().to_string();

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/prepare_verification"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(
        prepared.value()["response"]["verifications"]["email_address"]["status"],
        "unverified"
    );

    let code = code_for(&h, "new@example.com");
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/attempt_verification"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
    let value = attempted.value();
    assert_eq!(value["response"]["status"], "complete");
    assert!(value["response"]["created_user_id"].is_string());
    assert!(value["response"]["created_session_id"].is_string());
    assert_eq!(value["client"]["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["client"]["sessions"][0]["user"]["email_addresses"][0]["email_address"],
        "new@example.com"
    );
}

#[tokio::test]
async fn wrong_code_is_refused_and_counts_an_attempt() {
    let h = harness().await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "new@example.com" })),
            &[],
        )
        .await;
    let sign_up_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/prepare_verification"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    let attempted = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/attempt_verification"),
            Some(serde_json::json!({ "code": "000000" })),
            &[],
        )
        .await;
    assert_eq!(attempted.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(attempted.error_codes(), vec!["form_code_incorrect"]);
}

#[tokio::test]
async fn email_link_sign_up_verifies_in_the_starting_browser_only() {
    let h = harness().await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "link@example.com", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    let sign_up_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/prepare_verification"),
            Some(serde_json::json!({ "strategy": "email_link" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let link = latest_link_for(&h.app.app_state(), "link@example.com").expect("magic link");
    let token = url::Url::parse(&link)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .unwrap();

    // Another browser cannot complete somebody else's sign-up.
    let other = h.other_browser();
    let different = other.get(&format!("/v1/verify?token={token}"), &[]).await;
    assert_eq!(different.status, StatusCode::FOUND);
    assert!(different
        .headers
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("__orbit_status=different_browser"));

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

    let client = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
    let user_id = client["response"]["sessions"][0]["user"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let verified_email: (bool,) =
        sqlx::query_as("SELECT verified FROM email_addresses WHERE user_id = $1")
            .bind(&user_id)
            .fetch_one(&h.state().pool)
            .await
            .unwrap();
    assert!(verified_email.0);
}

#[tokio::test]
async fn identifiers_already_in_use_are_refused() {
    let h = harness().await;
    seed_user(&h, "taken@example.com", "Sup3r-secret!").await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "taken@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["form_identifier_exists"]);
}

#[tokio::test]
async fn patch_revalidates_identifiers_and_drops_old_verifications() {
    let h = harness().await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "first@example.com" })),
            &[],
        )
        .await;
    let sign_up_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/prepare_verification"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    let code = code_for(&h, "first@example.com");
    h.client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/attempt_verification"),
            Some(serde_json::json!({ "code": code })),
            &[],
        )
        .await;

    let patched = h
        .client
        .request(
            "PATCH",
            &format!("/v1/client/sign_ups/{sign_up_id}"),
            Some(serde_json::json!({ "email_address": "second@example.com" })),
            &[],
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    let value = patched.value();
    assert_eq!(value["response"]["email_address"], "second@example.com");
    assert!(value["response"]["verifications"]["email_address"].is_null());
    assert_eq!(value["response"]["unverified_fields"][0], "email_address");
}

#[tokio::test]
async fn invalid_email_and_disabled_attributes_are_form_errors() {
    let h = harness().await;
    let invalid = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "not-an-email" })),
            &[],
        )
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(invalid.error_codes(), vec!["form_param_format_invalid"]);

    let username = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "username": "someone" })),
            &[],
        )
        .await;
    assert_eq!(username.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(username.error_codes(), vec!["form_param_unknown"]);
}

#[tokio::test]
async fn anonymous_sign_up_creates_a_guest_session() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({ "anonymous": { "enabled": true } }))
        .await
        .unwrap();
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let value = response.value();
    assert_eq!(value["response"]["status"], "complete");
    assert_eq!(value["client"]["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(value["client"]["sessions"][0]["user"]["is_anonymous"], true);
}

#[tokio::test]
async fn anonymous_sign_up_is_refused_when_disabled() {
    let h = harness().await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "strategy": "anonymous" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.error_codes(), vec!["sign_up_restricted"]);
}

#[tokio::test]
async fn legal_consent_is_required_when_configured() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "legalConsentRequired": true } }))
        .await
        .unwrap();
    let refused = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "legal@example.com" })),
            &[],
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(refused.error_codes(), vec!["form_param_missing"]);

    let accepted = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "email_address": "legal@example.com",
                "legal_accepted": true,
            })),
            &[],
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
    assert!(accepted.value()["response"]["legal_accepted_at"].is_number());
}

#[tokio::test]
async fn a_bad_ticket_is_refused() {
    let h = harness().await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "email_address": "ticket@example.com",
                "ticket": "inv_bogus",
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(response.error_codes(), vec!["ticket_invalid"]);
}

#[tokio::test]
async fn completed_sign_ups_cannot_be_patched() {
    let h = harness().await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "done@example.com", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    let sign_up_id = created.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    h.client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/prepare_verification"),
            Some(serde_json::json!({})),
            &[],
        )
        .await;
    let code = code_for(&h, "done@example.com");
    h.client
        .post(
            &format!("/v1/client/sign_ups/{sign_up_id}/attempt_verification"),
            Some(serde_json::json!({ "code": code })),
            &[],
        )
        .await;
    let patched = h
        .client
        .request(
            "PATCH",
            &format!("/v1/client/sign_ups/{sign_up_id}"),
            Some(serde_json::json!({ "first_name": "Ada" })),
            &[],
        )
        .await;
    assert_eq!(patched.status, StatusCode::BAD_REQUEST);
    assert_eq!(patched.error_codes(), vec!["client_state_invalid"]);
}

#[tokio::test]
async fn waitlist_restricted_and_allowlist_modes_gate_sign_up() {
    let h = harness().await;

    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "waitlist" } }))
        .await
        .unwrap();
    let waitlisted = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "wait@example.com" })),
            &[],
        )
        .await;
    assert_eq!(waitlisted.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        waitlisted.error_codes(),
        vec!["sign_up_restricted_waitlist"]
    );

    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "restricted" } }))
        .await
        .unwrap();
    let restricted = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "plain@example.com" })),
            &[],
        )
        .await;
    assert_eq!(restricted.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(restricted.error_codes(), vec!["sign_up_restricted"]);

    // An allowlist row is only an invitation when the allowlist is switched on.
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO allowlist_identifiers (id, identifier, identifier_type, created_at, updated_at) \
         VALUES ('idn_al_1', 'invited@example.com', 'email_address', $1, $1)",
    )
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
    h.state()
        .settings
        .update(serde_json::json!({
            "restrictions": { "allowlistEnabled": true },
        }))
        .await
        .unwrap();
    let invited = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "invited@example.com" })),
            &[],
        )
        .await;
    assert_eq!(invited.status, StatusCode::OK, "{}", invited.text());
    assert_eq!(
        invited.value()["response"]["status"],
        "missing_requirements"
    );

    // The allowlist toggle alone also gates public sign-ups.
    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "public" } }))
        .await
        .unwrap();
    let blocked = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "email_address": "someone@example.com" })),
            &[],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(blocked.error_codes(), vec!["sign_up_restricted"]);
}

#[tokio::test]
async fn an_invitation_ticket_admits_a_restricted_sign_up_and_is_accepted() {
    let h = harness().await;
    h.state()
        .settings
        .update(serde_json::json!({ "signUp": { "mode": "restricted" } }))
        .await
        .unwrap();
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO invitations (id, email, status, token_hash, public_metadata, created_at, updated_at) \
         VALUES ('inv_test', 'invitee@example.com', 'pending', $1, '{}'::jsonb, $2, $2)",
    )
    .bind(orbitid_core::crypto::sha256("inv_ticket_1"))
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();

    // The email must match the invitation.
    let mismatch = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "email_address": "other@example.com",
                "ticket": "inv_ticket_1",
            })),
            &[],
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(mismatch.error_codes(), vec!["form_param_value_invalid"]);

    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "email_address": "invitee@example.com",
                "password": "Sup3r-secret!",
                "ticket": "inv_ticket_1",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let response = &created.value()["response"];
    assert_eq!(response["status"], "missing_requirements");
    assert_eq!(response["email_address"], "invitee@example.com");
    let id = response["id"].as_str().unwrap().to_string();

    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{id}/prepare_verification"),
            Some(serde_json::json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    let code =
        latest_code_for(&h.app.app_state(), "invitee@example.com", None).expect("sign-up code");
    let done = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{id}/attempt_verification"),
            Some(serde_json::json!({ "strategy": "email_code", "code": code })),
            &[],
        )
        .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.text());
    assert_eq!(done.value()["response"]["status"], "complete");

    let status: String = sqlx::query_scalar("SELECT status FROM invitations WHERE id = 'inv_test'")
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
    assert_eq!(status, "accepted");
}

/// Regression for the attempt-state race: concurrent verifications of the same
/// sign-up must create exactly one user/session and leave the row `complete`.
/// Stale writers are rejected by the version CAS instead of rewriting the row.
#[tokio::test]
async fn concurrent_sign_up_verifications_create_one_user() {
    for round in 0..5 {
        let h = harness().await;
        let created = h
            .client
            .post(
                "/v1/client/sign_ups",
                Some(serde_json::json!({
                    "email_address": "race-signup@example.com",
                    "password": "Sup3r-secret!",
                })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let id = created.value()["response"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        h.client
            .post(
                &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                Some(serde_json::json!({})),
                &[],
            )
            .await;
        let code = code_for(&h, "race-signup@example.com");
        let cookie = h.client.cookie_header().expect("client cookie");
        let path = format!("/v1/client/sign_ups/{id}/attempt_verification");
        let body = serde_json::json!({ "code": code });
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let client = orbitid_core::testing::TestClient::with_cookie(
                common::build(h.state().clone()),
                &cookie,
            );
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
        assert_eq!(ok, 1, "round {round}: exactly one verification wins");
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&h.state().pool)
            .await
            .unwrap();
        assert_eq!(users, 1, "round {round}: one user only");
        let complete: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sign_ups WHERE id = $1 AND status = 'complete'",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(complete, 1, "round {round}");
        let sessions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE client_id = \
             (SELECT client_id FROM sign_ups WHERE id = $1)",
        )
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(sessions, 1, "round {round}");
    }
}
