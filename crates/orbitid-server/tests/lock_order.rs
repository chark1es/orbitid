//! Layer 1 proof: the reviewer's live deadlock probe and the concurrency
//! combinations behind it, driven through the composed server.
//!
//! Each test reads `pg_stat_database.deadlocks` before and after and asserts a
//! delta of **zero**, so a success cannot be explained by Layer 2 replaying a
//! conflict: a deadlock would still be counted even when the replay hides it.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::http::StatusCode;
use axum::Router;
use common::*;
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::testing::{
    add_test_member, create_test_organization, create_test_user, test_app_state, TestApp,
};
use serde_json::json;

fn router(state: &AppState, retry: bool) -> Router {
    if retry {
        orbitid_server::build_app(state.clone())
    } else {
        orbitid_server::build_app_without_retry(state.clone())
    }
}

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

fn assert_no_conflict(label: &str, response: &TestResponse) {
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

fn assert_ok(label: &str, response: &TestResponse) {
    assert!(
        response.status.is_success(),
        "{label} returned {}: {}",
        response.status,
        response.text()
    );
}

async fn session_id_of(browser: &TestClient) -> String {
    browser.get("/v1/client", &[]).await.value()["response"]["sessions"][0]["id"]
        .as_str()
        .expect("session id")
        .to_string()
}

async fn password_sign_in(browser: &TestClient, email: &str, password: &str) -> TestResponse {
    browser
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": email, "password": password })),
            &[],
        )
        .await
}

/// The reviewer's probe: 40 iterations of unban → password sign-in → 4 touch
/// loops + one ban, all through the composed HTTP app.
async fn reviewer_probe(retry: bool) {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "probe@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let backend = TestClient::new(router(state, retry));
    let before = deadlocks(state).await;
    let conflicts = Arc::new(AtomicUsize::new(0));
    let server_errors = Arc::new(AtomicUsize::new(0));
    let touches = Arc::new(AtomicUsize::new(0));

    for iteration in 0..40 {
        let unban = backend
            .post(&format!("/v1/users/{}/unban", user.id()), None, bearer())
            .await;
        assert_ok("unban", &unban);
        let browser = TestClient::new(router(state, retry));
        let signed_in = password_sign_in(&browser, "probe@example.com", "Sup3r-secret!").await;
        assert_ok(&format!("sign-in {iteration}"), &signed_in);
        let session_id = session_id_of(&browser).await;
        let browser = Arc::new(browser);

        let mut handles = Vec::new();
        for _ in 0..4 {
            let browser = Arc::clone(&browser);
            let session_id = session_id.clone();
            let conflicts = Arc::clone(&conflicts);
            let server_errors = Arc::clone(&server_errors);
            let touches = Arc::clone(&touches);
            handles.push(tokio::spawn(async move {
                for _ in 0..8 {
                    let response = browser
                        .post(
                            &format!("/v1/client/sessions/{session_id}/touch"),
                            Some(json!({})),
                            &[],
                        )
                        .await;
                    touches.fetch_add(1, Ordering::SeqCst);
                    if response.status == StatusCode::CONFLICT {
                        conflicts.fetch_add(1, Ordering::SeqCst);
                    }
                    if response.status.is_server_error() {
                        server_errors.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }));
        }
        let ban = backend
            .post(&format!("/v1/users/{}/ban", user.id()), None, bearer())
            .await;
        assert_ok(&format!("ban {iteration}"), &ban);
        for handle in handles {
            handle.await.expect("touch task");
        }
        let banned: bool = sqlx::query_scalar("SELECT banned FROM users WHERE id = $1")
            .bind(user.id())
            .fetch_one(&state.pool)
            .await
            .expect("read banned");
        assert!(banned, "iteration {iteration}: the ban was rolled back");
    }

    let after = deadlocks(state).await;
    assert_eq!(conflicts.load(Ordering::SeqCst), 0, "touch/ban 409s");
    assert_eq!(server_errors.load(Ordering::SeqCst), 0, "touch/ban 500s");
    assert!(touches.load(Ordering::SeqCst) > 0);
    assert_eq!(
        after - before,
        0,
        "Postgres reported {} deadlock(s); Layer 1 alone must remove them",
        after - before
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn touch_and_ban_never_conflict_with_both_layers() {
    reviewer_probe(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn touch_and_ban_do_not_deadlock_without_the_request_retry() {
    reviewer_probe(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_sign_up_patch_and_completion() {
    let e2e = E2e::new().await;
    let state = e2e.state();
    let before = deadlocks(state).await;
    let browser = Arc::new(e2e.browser());
    let created = browser
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "email_address": "patch@example.com", "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_ok("create sign-up", &created);
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("sign-up id")
        .to_string();
    let prepared = browser
        .post(
            &format!("/v1/client/sign_ups/{id}/prepare_verification"),
            Some(json!({ "strategy": "email_code" })),
            &[],
        )
        .await;
    assert_ok("prepare verification", &prepared);
    let code = orbitid_platform::mail::latest_code_for(state, "patch@example.com", None)
        .expect("verification code");

    let patch_path = format!("/v1/client/sign_ups/{id}");
    let attempt_path = format!("/v1/client/sign_ups/{id}/attempt_verification");
    let patched = browser.patch(&patch_path, Some(json!({ "first_name": "Grace" })), &[]);
    let attempted = browser.post(
        &attempt_path,
        Some(json!({ "strategy": "email_code", "code": code })),
        &[],
    );
    let (patched, attempted) = tokio::join!(patched, attempted);
    assert_no_conflict("sign-up patch", &patched);
    assert_no_conflict("sign-up completion", &attempted);
    let status: String = sqlx::query_scalar("SELECT status FROM sign_ups WHERE id = $1")
        .bind(&id)
        .fetch_one(&state.pool)
        .await
        .expect("sign-up status");
    // Either request may win the CAS; the loser is a 400 `client_state_invalid`,
    // which is not a deadlock. Retry the completion once if it lost (the code
    // was not consumed, because the loser's transaction rolled back).
    if status != "complete" {
        let retried = browser
            .post(
                &attempt_path,
                Some(json!({ "strategy": "email_code", "code": code })),
                &[],
            )
            .await;
        assert_no_conflict("sign-up completion retry", &retried);
        assert_ok("sign-up completion retry", &retried);
    }
    let status: String = sqlx::query_scalar("SELECT status FROM sign_ups WHERE id = $1")
        .bind(&id)
        .fetch_one(&state.pool)
        .await
        .expect("sign-up status");
    assert_eq!(status, "complete");
    assert_eq!(deadlocks(state).await - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_password_attempts_and_session_creation() {
    let app: TestApp = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "attempts@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let before = deadlocks(state).await;
    let browser = Arc::new(TestClient::new(router(state, true)));
    let created = browser
        .post(
            "/v1/client/sign_ins",
            Some(json!({ "identifier": "attempts@example.com" })),
            &[],
        )
        .await;
    assert_ok("create sign-in", &created);
    let id = created.value()["response"]["id"]
        .as_str()
        .expect("sign-in id")
        .to_string();
    let prepared = browser
        .post(
            &format!("/v1/client/sign_ins/{id}/prepare_first_factor"),
            Some(json!({ "strategy": "password" })),
            &[],
        )
        .await;
    assert_ok("prepare password factor", &prepared);

    let mut handles = Vec::new();
    for _ in 0..4 {
        let browser = Arc::clone(&browser);
        let id = id.clone();
        handles.push(tokio::spawn(async move {
            browser
                .post(
                    &format!("/v1/client/sign_ins/{id}/attempt_first_factor"),
                    Some(json!({ "strategy": "password", "password": "Sup3r-secret!" })),
                    &[],
                )
                .await
        }));
    }
    let mut failures = 0;
    for handle in handles {
        let response = handle.await.expect("attempt task");
        if response.status == StatusCode::CONFLICT || response.status.is_server_error() {
            failures += 1;
            eprintln!("attempt failed: {} {}", response.status, response.text());
        }
    }
    assert_eq!(failures, 0, "an attempt hit 409/500");
    let active: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND status = 'active'",
    )
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .expect("sessions");
    assert_eq!(active, 1, "exactly one attempt may create a session");
    assert_eq!(deadlocks(state).await - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_user_deletion_and_touch() {
    let e2e = E2e::new().await;
    let state = e2e.state();
    let before = deadlocks(state).await;
    let browser = e2e.browser();
    let signed_up = sign_up(&e2e, &browser, "delete-touch@example.com", "Sup3r-secret!").await;
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("user id")
        .to_string();
    let session_id = session_id_of(&browser).await;
    let browser = Arc::new(browser);
    let touch_path = format!("/v1/client/sessions/{session_id}/touch");
    let delete_path = format!("/v1/users/{user_id}");
    let touch = browser.post(&touch_path, Some(json!({})), &[]);
    let delete = e2e.client.delete(&delete_path, None, bearer());
    let (touch, delete) = tokio::join!(touch, delete);
    assert_no_conflict("touch during deletion", &touch);
    assert_no_conflict("user deletion", &delete);
    assert_ok("user deletion", &delete);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = $1")
        .bind(&user_id)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(remaining, 0);
    assert_eq!(deadlocks(state).await - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_ban_and_sign_in() {
    let e2e = E2e::new().await;
    let state = e2e.state();
    let user = create_test_user(state, "ban-signin@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let before = deadlocks(state).await;
    let browser = Arc::new(e2e.browser());
    let ban_path = format!("/v1/users/{}/ban", user.id());
    let ban = e2e.client.post(&ban_path, None, bearer());
    let sign_in = password_sign_in(&browser, "ban-signin@example.com", "Sup3r-secret!");
    let (ban, sign_in) = tokio::join!(ban, sign_in);
    assert_ok("ban", &ban);
    assert_no_conflict("sign-in during ban", &sign_in);
    let banned: bool = sqlx::query_scalar("SELECT banned FROM users WHERE id = $1")
        .bind(user.id())
        .fetch_one(&state.pool)
        .await
        .expect("read banned");
    assert!(banned);
    assert_eq!(deadlocks(state).await - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_member_removal_and_role_change() {
    let e2e = E2e::new().await;
    let state = e2e.state();
    let owner = create_test_user(state, "owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let first = create_test_user(state, "member-one@example.com", "Sup3r-secret!")
        .await
        .expect("member one");
    let second = create_test_user(state, "member-two@example.com", "Sup3r-secret!")
        .await
        .expect("member two");
    let org = create_test_organization(state, "Lock Order Org", None, &owner.user.id)
        .await
        .expect("organization");
    add_test_member(state, &org.id, &first.user.id, "org:member")
        .await
        .expect("first membership");
    add_test_member(state, &org.id, &second.user.id, "org:member")
        .await
        .expect("second membership");
    let before = deadlocks(state).await;

    let remove_path = format!("/v1/organizations/{}/memberships/{}", org.id, first.user.id);
    let promote_path = format!(
        "/v1/organizations/{}/memberships/{}",
        org.id, second.user.id
    );
    let remove = e2e.client.delete(&remove_path, None, bearer());
    let promote = e2e.client.patch(
        &promote_path,
        Some(json!({ "role": "org:admin" })),
        bearer(),
    );
    let (remove, promote) = tokio::join!(remove, promote);
    assert_no_conflict("membership removal", &remove);
    assert_no_conflict("role change", &promote);
    assert_ok("membership removal", &remove);
    assert_ok("role change", &promote);
    let role: String = sqlx::query_scalar(
        "SELECT role_key FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(&org.id)
    .bind(&second.user.id)
    .fetch_one(&state.pool)
    .await
    .expect("promoted role");
    assert_eq!(role, "org:admin");
    assert_eq!(deadlocks(state).await - before, 0);
}
