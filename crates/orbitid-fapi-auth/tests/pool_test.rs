//! Regression tests for the "completion holds a transaction while taking more
//! pool connections" finding.
//!
//! A completion must run on exactly one connection. Before the fix, sign-up
//! with `ORBITID_DB_MAX_CONNECTIONS=1` timed out (the transaction held the only
//! connection while `create_user`/session helpers asked the pool for another),
//! and two concurrent completions on a pool of two deadlocked.

use axum::http::StatusCode;
use axum::Router;
use orbitid_core::config::EnvOverrides;
use orbitid_core::http::{csrf_protection, security_headers, upload_size_limit};
use orbitid_core::testing::TestClient;
use orbitid_core::AppState;
use orbitid_identity::testing::{enable_totp, test_app_state_with, TestApp};
use serde_json::{json, Value};

fn build(state: AppState) -> Router {
    orbitid_fapi_auth::router()
        .merge(orbitid_fapi_account::router())
        .with_state(state.clone())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            csrf_protection,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            upload_size_limit,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state,
            security_headers,
        ))
}

async fn app_with_pool(max_connections: u32) -> TestApp {
    // A one-connection state is stricter than any gate, so it is always
    // explicit; a test that needs two (concurrent completions) exempts itself
    // from the `ORBITID_TEST_POOL_MAX` gate and says why above its call.
    let overrides = match max_connections {
        1 => EnvOverrides {
            db_max_connections: Some(1),
            db_acquire_timeout_ms: Some(2_000),
            ..Default::default()
        },
        other => orbitid_core::testing::test_pool_exemption(other),
    };
    test_app_state_with(overrides).await
}

fn client(app: &TestApp) -> TestClient {
    TestClient::new(build(app.state().clone()))
}

fn expect_ok(response: orbitid_core::testing::TestResponse, what: &str) -> Value {
    assert_eq!(
        response.status,
        StatusCode::OK,
        "{what}: {}",
        response.text()
    );
    response.value()
}

/// Full email-code sign-up over HTTP, returning the completed sign-up resource.
async fn sign_up(app: &TestApp, browser: &TestClient, email: &str) -> Value {
    let created = expect_ok(
        browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": email, "password": "Sup3r-secret!" })),
                &[],
            )
            .await,
        "create sign-up",
    );
    let id = created["response"]["id"].as_str().expect("sign-up id");
    expect_ok(
        browser
            .post(
                &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                Some(json!({})),
                &[],
            )
            .await,
        "prepare verification",
    );
    let code = orbitid_platform::mail::latest_code_for(app.state(), email, None)
        .expect("verification code");
    expect_ok(
        browser
            .post(
                &format!("/v1/client/sign_ups/{id}/attempt_verification"),
                Some(json!({ "code": code })),
                &[],
            )
            .await,
        "complete sign-up",
    )
}

async fn password_sign_in(app: &TestApp, email: &str) -> Value {
    let browser = client(app);
    expect_ok(
        browser
            .post(
                "/v1/client/sign_ins",
                Some(json!({ "identifier": email, "password": "Sup3r-secret!" })),
                &[],
            )
            .await,
        "password sign-in",
    )
}

#[tokio::test]
async fn polling_an_unclicked_email_link_sign_up_uses_one_connection() {
    // The response serialisers (`respond` → client/in-flight lookups) take a
    // pool connection. An attempt that finds the email link unclicked writes
    // nothing, so it must release its transaction first; otherwise a poll on a
    // one-connection pool returns 500 after the acquire timeout (the live
    // `ORBITID_DB_MAX_CONNECTIONS=1` reproduction).
    let app = app_with_pool(1).await;
    let browser = client(&app);
    let created = expect_ok(
        browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": "poll@example.com", "password": "Sup3r-secret!" })),
                &[],
            )
            .await,
        "create sign-up",
    );
    let id = created["response"]["id"]
        .as_str()
        .expect("sign-up id")
        .to_string();
    expect_ok(
        browser
            .post(
                &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                Some(json!({ "strategy": "email_link" })),
                &[],
            )
            .await,
        "prepare email link",
    );
    for _ in 0..2 {
        let polled = expect_ok(
            browser
                .post(
                    &format!("/v1/client/sign_ups/{id}/attempt_verification"),
                    Some(json!({ "strategy": "email_link" })),
                    &[],
                )
                .await,
            "poll unclicked link",
        );
        assert_eq!(polled["response"]["status"], "missing_requirements");
        assert_eq!(
            polled["response"]["verifications"]["email_address"]["strategy"],
            "email_link"
        );
    }
}

#[tokio::test]
async fn every_flow_works_on_a_single_connection_pool() {
    let app = app_with_pool(1).await;
    app.state()
        .settings
        .update(json!({ "organizations": { "enabled": true } }))
        .await
        .expect("enable organizations");

    // 1. Full sign-up with an email code.
    let first = client(&app);
    let signed_up = sign_up(&app, &first, "one@example.com").await;
    assert_eq!(signed_up["response"]["status"], "complete");
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("created user")
        .to_string();

    // 2. Password sign-in from a second browser.
    let signed_in = password_sign_in(&app, "one@example.com").await;
    assert_eq!(signed_in["response"]["status"], "complete");

    // 3. Password sign-in followed by a TOTP second factor.
    let secret = enable_totp(app.state(), &user_id)
        .await
        .expect("enable totp");
    let mfa_browser = client(&app);
    let mfa_sign_in = expect_ok(
        mfa_browser
            .post(
                "/v1/client/sign_ins",
                Some(json!({ "identifier": "one@example.com", "password": "Sup3r-secret!" })),
                &[],
            )
            .await,
        "password sign-in with MFA",
    );
    assert_eq!(mfa_sign_in["response"]["status"], "needs_second_factor");
    let sign_in_id = mfa_sign_in["response"]["id"].as_str().expect("sign-in id");
    let code = orbitid_credentials::totp_code_at(&secret, orbitid_core::http::now() / 1000)
        .expect("totp code");
    let completed = expect_ok(
        mfa_browser
            .post(
                &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
                Some(json!({ "strategy": "totp", "code": code })),
                &[],
            )
            .await,
        "second factor",
    );
    assert_eq!(completed["response"]["status"], "complete");

    // 4. Create an organization.
    let org = expect_ok(
        first
            .post(
                "/v1/client/organizations",
                Some(json!({ "name": "Single Connection" })),
                &[],
            )
            .await,
        "create organization",
    );
    let org_id = org["response"]["id"].as_str().expect("organization id");

    // 5. Invite and accept an organization invitation from a second account.
    let second = client(&app);
    let second_sign_up = sign_up(&app, &second, "two@example.com").await;
    assert_eq!(second_sign_up["response"]["status"], "complete");
    let invitation = expect_ok(
        first
            .post(
                &format!("/v1/client/organizations/{org_id}/invitations"),
                Some(json!({ "email_address": "two@example.com" })),
                &[],
            )
            .await,
        "create invitation",
    );
    let invitation_id = invitation["response"]["id"]
        .as_str()
        .expect("invitation id");
    expect_ok(
        second
            .post(
                &format!("/v1/client/me/organization_invitations/{invitation_id}/accept"),
                None,
                &[],
            )
            .await,
        "accept invitation",
    );
}

#[tokio::test]
async fn two_concurrent_completions_succeed_on_a_pool_of_two() {
    let app = app_with_pool(2).await;

    let left = client(&app);
    let right = client(&app);
    let mut ids = Vec::new();
    for (browser, email) in [(&left, "left@example.com"), (&right, "right@example.com")] {
        let created = expect_ok(
            browser
                .post(
                    "/v1/client/sign_ups",
                    Some(json!({ "email_address": email, "password": "Sup3r-secret!" })),
                    &[],
                )
                .await,
            "create sign-up",
        );
        let id = created["response"]["id"]
            .as_str()
            .expect("sign-up id")
            .to_string();
        expect_ok(
            browser
                .post(
                    &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                    Some(json!({})),
                    &[],
                )
                .await,
            "prepare verification",
        );
        ids.push((id, email.to_string()));
    }
    let left_code =
        orbitid_platform::mail::latest_code_for(app.state(), &ids[0].1, None).expect("left code");
    let right_code =
        orbitid_platform::mail::latest_code_for(app.state(), &ids[1].1, None).expect("right code");
    let left_path = format!("/v1/client/sign_ups/{}/attempt_verification", ids[0].0);
    let right_path = format!("/v1/client/sign_ups/{}/attempt_verification", ids[1].0);
    let (left_result, right_result) = tokio::join!(
        left.post(&left_path, Some(json!({ "code": left_code })), &[]),
        right.post(&right_path, Some(json!({ "code": right_code })), &[],),
    );
    assert_eq!(
        left_result.status,
        StatusCode::OK,
        "left: {}",
        left_result.text()
    );
    assert_eq!(
        right_result.status,
        StatusCode::OK,
        "right: {}",
        right_result.text()
    );
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&app.state().pool)
        .await
        .expect("users");
    assert_eq!(users, 2);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&app.state().pool)
        .await
        .expect("sessions");
    assert_eq!(sessions, 2);
}

#[tokio::test]
async fn a_failure_after_user_creation_leaves_no_orphan_user() {
    // Pool of two so the pre-fix code (user insert on the pool, outside the
    // completion transaction) could actually commit an orphan before the
    // injected session failure.
    let app = app_with_pool(2).await;
    let browser = client(&app);
    let created = expect_ok(
        browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": "orphan@example.com", "password": "Sup3r-secret!" })),
                &[],
            )
            .await,
        "create sign-up",
    );
    let id = created["response"]["id"]
        .as_str()
        .expect("sign-up id")
        .to_string();
    expect_ok(
        browser
            .post(
                &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                Some(json!({})),
                &[],
            )
            .await,
        "prepare verification",
    );
    let code = orbitid_platform::mail::latest_code_for(app.state(), "orphan@example.com", None)
        .expect("verification code");

    // Fault injection after the user insert and before/at the session insert.
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_session() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected session failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&app.state().pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_session BEFORE INSERT ON sessions \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_session()",
    )
    .execute(&app.state().pool)
    .await
    .expect("trigger");

    let failed = browser
        .post(
            &format!("/v1/client/sign_ups/{id}/attempt_verification"),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_eq!(
        failed.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{}",
        failed.text()
    );
    let users: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE id IN \
         (SELECT user_id FROM email_addresses WHERE email = 'orphan@example.com')",
    )
    .fetch_one(&app.state().pool)
    .await
    .expect("users");
    assert_eq!(users, 0, "the failed completion must roll the user back");
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM webhook_events \
         WHERE type IN ('user.created', 'session.created', 'invitation.accepted')",
    )
    .fetch_one(&app.state().pool)
    .await
    .expect("events");
    assert_eq!(
        events, 0,
        "the failed completion must roll its webhook event rows back too"
    );
    let sign_up_status: String = sqlx::query_scalar("SELECT status FROM sign_ups WHERE id = $1")
        .bind(&id)
        .fetch_one(&app.state().pool)
        .await
        .expect("sign-up");
    assert_ne!(sign_up_status, "complete");
}

#[tokio::test]
async fn completing_a_sign_up_writes_user_and_session_events_in_one_transaction() {
    let app = app_with_pool(1).await;
    let browser = client(&app);
    let signed_up = sign_up(&app, &browser, "outbox@example.com").await;
    assert_eq!(signed_up["response"]["status"], "complete");

    let user_events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'user.created'")
            .fetch_one(&app.state().pool)
            .await
            .expect("user events");
    assert_eq!(user_events, 1, "exactly one user.created row");
    let session_events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.created'")
            .fetch_one(&app.state().pool)
            .await
            .expect("session events");
    assert_eq!(session_events, 1, "exactly one session.created row");

    // The payload still describes the committed resource.
    let payload: orbitid_core::models::WebhookEventRow =
        sqlx::query_as("SELECT * FROM webhook_events WHERE type = 'user.created'")
            .fetch_one(&app.state().pool)
            .await
            .expect("event row");
    assert_eq!(payload.event_type, "user.created");
    assert_eq!(payload.payload.0["data"]["object"], "user");
}

#[tokio::test]
async fn single_session_mode_writes_each_ended_event_once() {
    let app = app_with_pool(2).await;
    app.state()
        .settings
        .update(json!({ "session": { "multiSession": false } }))
        .await
        .expect("single-session mode");

    let browser = client(&app);
    let signed_up = sign_up(&app, &browser, "single@example.com").await;
    assert_eq!(signed_up["response"]["status"], "complete");
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("created user")
        .to_string();
    let client_id: String = sqlx::query_scalar("SELECT client_id FROM sessions WHERE user_id = $1")
        .bind(&user_id)
        .fetch_one(&app.state().pool)
        .await
        .expect("client");

    // A second session for the same client ends the first one.
    let created = orbitid_identity::sessions::create_session(
        app.state(),
        orbitid_identity::sessions::CreateSessionInput {
            client_id,
            user_id,
            first_factor: true,
            ..Default::default()
        },
    )
    .await
    .expect("second session");
    assert_eq!(created.ended_sessions.len(), 1);

    let ended: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.ended'")
            .fetch_one(&app.state().pool)
            .await
            .expect("ended events");
    assert_eq!(ended, 1, "the replaced session is announced exactly once");
    let created_events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.created'")
            .fetch_one(&app.state().pool)
            .await
            .expect("created events");
    assert_eq!(
        created_events, 2,
        "both committed sessions have one created event"
    );
}

#[tokio::test]
async fn email_second_factor_prepare_and_attempt_use_one_connection() {
    // Before the fix, both handlers read the user's emails through the pool
    // while holding their sign-in transaction, so a one-connection pool timed
    // out (and a two-connection pool could deadlock under concurrency).
    let app = app_with_pool(1).await;
    app.state()
        .settings
        .update(json!({
            "attributes": { "emailAddress": { "usedForSecondFactor": true } }
        }))
        .await
        .expect("enable email second factor");

    let browser = client(&app);
    let signed_up = sign_up(&app, &browser, "email-2fa@example.com").await;
    assert_eq!(signed_up["response"]["status"], "complete");
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("created user")
        .to_string();
    enable_totp(app.state(), &user_id)
        .await
        .expect("enable totp");

    let mfa_browser = client(&app);
    let started = expect_ok(
        mfa_browser
            .post(
                "/v1/client/sign_ins",
                Some(json!({
                    "identifier": "email-2fa@example.com",
                    "password": "Sup3r-secret!"
                })),
                &[],
            )
            .await,
        "password sign-in with MFA",
    );
    assert_eq!(started["response"]["status"], "needs_second_factor");
    let sign_in_id = started["response"]["id"].as_str().expect("sign-in id");

    expect_ok(
        mfa_browser
            .post(
                &format!("/v1/client/sign_ins/{sign_in_id}/prepare_second_factor"),
                Some(json!({ "strategy": "email_code" })),
                &[],
            )
            .await,
        "prepare email second factor",
    );
    let code = orbitid_platform::mail::latest_code_for(app.state(), "email-2fa@example.com", None)
        .expect("email second-factor code");
    let completed = expect_ok(
        mfa_browser
            .post(
                &format!("/v1/client/sign_ins/{sign_in_id}/attempt_second_factor"),
                Some(json!({ "strategy": "email_code", "code": code })),
                &[],
            )
            .await,
        "attempt email second factor",
    );
    assert_eq!(completed["response"]["status"], "complete");
}

#[tokio::test]
async fn magic_link_and_sign_out_of_all_work_on_a_single_connection_pool() {
    let app = app_with_pool(1).await;
    let browser = client(&app);
    let signed_up = sign_up(&app, &browser, "link-pool@example.com").await;
    assert_eq!(signed_up["response"]["status"], "complete");

    // Start a magic-link sign-in from a second browser and click it: consuming
    // the link and advancing/completing the attempt must use one connection.
    let link_browser = client(&app);
    let created = expect_ok(
        link_browser
            .post(
                "/v1/client/sign_ins",
                Some(json!({ "identifier": "link-pool@example.com" })),
                &[],
            )
            .await,
        "create sign-in",
    );
    let id = created["response"]["id"]
        .as_str()
        .expect("sign-in id")
        .to_string();
    expect_ok(
        link_browser
            .post(
                &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
                Some(json!({ "strategy": "email_link" })),
                &[],
            )
            .await,
        "prepare magic link",
    );
    let link = orbitid_platform::mail::latest_link_for(app.state(), "link-pool@example.com")
        .expect("link");
    let token = url::Url::parse(&link)
        .expect("url")
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .expect("token");
    let verified = link_browser
        .get(&format!("/v1/verify?token={token}"), &[])
        .await;
    assert_eq!(verified.status, StatusCode::FOUND, "{}", verified.text());
    let location = verified
        .headers
        .get("location")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert!(
        location.contains("__orbit_status=verified"),
        "location: {location}"
    );

    // Signing out of every session (per-session end + client pointer) is one
    // transaction and must work on the single connection too.
    expect_ok(
        link_browser.delete("/v1/client", None, &[]).await,
        "sign out all",
    );
    expect_ok(
        browser.delete("/v1/client", None, &[]).await,
        "sign out all",
    );
    let active: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE status IN ('active','pending')")
            .fetch_one(&app.state().pool)
            .await
            .expect("sessions");
    assert_eq!(active, 0);
}
