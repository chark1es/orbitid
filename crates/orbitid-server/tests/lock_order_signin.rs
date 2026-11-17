//! Lock-order proofs for the sign-in / sign-up attempt rows against their
//! verification rows (rank 4/5 before rank 6).
//!
//! Every path here also takes the client row first, so these tests guard the
//! rank order (and prove the new row locks neither deadlock nor break the
//! commit-on-refusal path) rather than reproduce a cycle that the client lock
//! already serialises.
//!
//! The retry layer is off, so a deadlock cannot be hidden by a replay, and each
//! test asserts the `pg_stat_database.deadlocks` delta stays at zero.

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{create_test_user, test_app_state_with, TestApp};
use orbitid_platform::mail::{latest_code_for, latest_link_for, EmailTemplate};
use serde_json::json;

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

fn browser(state: &AppState) -> TestClient {
    TestClient::new(orbitid_server::build_app_without_retry(state.clone()))
}

fn assert_no_server_error(label: &str, response: &TestResponse) {
    assert_ne!(
        response.status,
        StatusCode::CONFLICT,
        "{label} returned 409: {}",
        response.text()
    );
    assert!(
        !response.status.is_server_error(),
        "{label} returned {}: {}",
        response.status,
        response.text()
    );
}

/// Re-submitted recovery codes racing the password POST on the same sign-in:
/// the attempt used to take the verification row before the sign-in row, the
/// completion the reverse.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resubmitted_reset_code_does_not_deadlock_with_reset_password() {
    // Concurrency test: two simultaneous requests per iteration need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let email = "reset-race@example.com";
    create_test_user(state, email, "Sup3r-secret!")
        .await
        .expect("user");
    // Holding the verification row for a moment after the attempt counter moved
    // widens the window between the verification write and the sign-in write.
    for statement in [
        "CREATE FUNCTION slow_code_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN PERFORM pg_sleep(0.25); RETURN NEW; END $$",
        "CREATE TRIGGER slow_code_attempt BEFORE UPDATE ON verifications \
         FOR EACH ROW WHEN (NEW.attempts > OLD.attempts) EXECUTE FUNCTION slow_code_attempt()",
    ] {
        sqlx::query(statement)
            .execute(&state.pool)
            .await
            .expect("slow the attempt counter");
    }
    let before = deadlocks(state).await;

    for iteration in 0..10 {
        let client = Arc::new(browser(state));
        let created = client
            .post(
                "/v1/client/sign_ins",
                Some(json!({ "identifier": email, "strategy": "reset_password_email_code" })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let id = created.value()["response"]["id"]
            .as_str()
            .expect("sign-in id")
            .to_string();
        let prepared = client
            .post(
                &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
                Some(json!({ "strategy": "reset_password_email_code" })),
                &[],
            )
            .await;
        assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
        let code = latest_code_for(state, email, Some(EmailTemplate::ResetPasswordCode))
            .expect("reset code");
        let attempt_body = json!({ "strategy": "reset_password_email_code", "code": code });
        let attempt_path = format!("/v1/client/sign_ins/{id}/attempt_first_factor");
        let reset_path = format!("/v1/client/sign_ins/{id}/reset_password");
        // Two submissions of the same code read the sign-in while it still
        // needs a first factor; the slower one reaches their transaction after
        // the winner verified the code and the sign-in moved on, which is where
        // they meet the password POST.
        let mut handles = Vec::new();
        for _ in 0..2 {
            let client = Arc::clone(&client);
            let path = attempt_path.clone();
            let body = attempt_body.clone();
            handles.push(tokio::spawn(async move {
                client.post(&path, Some(body), &[]).await
            }));
        }
        let reset = {
            let client = Arc::clone(&client);
            tokio::spawn(async move {
                let mut last = None;
                for _ in 0..200 {
                    let response = client
                        .post(
                            &reset_path,
                            Some(json!({
                                "password": format!("N3wSup3rSecret-{iteration}!"),
                                "sign_out_of_other_sessions": false,
                            })),
                            &[],
                        )
                        .await;
                    let done = response.status.is_success();
                    last = Some(response);
                    if done {
                        break;
                    }
                }
                last.expect("one reset attempt")
            })
        };
        for handle in handles {
            let response = handle.await.expect("attempt task");
            assert_no_server_error("code attempt", &response);
        }
        let reset = reset.await.expect("reset task");
        assert_no_server_error("reset password", &reset);
    }
    assert_eq!(deadlocks(state).await - before, 0, "deadlock counter moved");
}

/// A verification-link click racing a re-issued verification on the same
/// sign-up: the click consumed the verification (rank 6) before locking the
/// sign-up (rank 4), the re-issue the reverse.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn link_click_does_not_deadlock_with_a_reissued_sign_up_verification() {
    // Concurrency test: two simultaneous requests per iteration need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    // Thirty sign-ups from one address would trip the per-IP limiter.
    state
        .settings
        .update(json!({ "security": { "rateLimitEnabled": false } }))
        .await
        .expect("disable rate limiting");
    let before = deadlocks(state).await;

    for iteration in 0..30 {
        let email = format!("link-race-{iteration}@example.com");
        let client = Arc::new(browser(state));
        let created = client
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": email, "password": "Sup3r-secret!" })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let id = created.value()["response"]["id"]
            .as_str()
            .expect("sign-up id")
            .to_string();
        let prepare_path = format!("/v1/client/sign_ups/{id}/prepare_verification");
        let body = json!({ "strategy": "email_link" });
        let prepared = client.post(&prepare_path, Some(body.clone()), &[]).await;
        assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
        let link = latest_link_for(state, &email).expect("magic link");
        let token = url::Url::parse(&link)
            .expect("url")
            .query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
            .expect("token");

        let click_path = format!("/v1/verify?token={token}");
        let click = client.get(&click_path, &[]);
        let reissue = client.post(&prepare_path, Some(body), &[]);
        let (click, reissue) = tokio::join!(click, reissue);
        assert_no_server_error("link click", &click);
        assert_no_server_error("re-issued verification", &reissue);
    }
    assert_eq!(deadlocks(state).await - before, 0, "deadlock counter moved");
}
