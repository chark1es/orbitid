//! Layer 1 proof for the background workers: retention and anonymous cleanup
//! run concurrently with foreground auth traffic on the same rows without a
//! single Postgres deadlock. The retry layer is **off** for these tests, so a
//! success cannot be explained by a replay hiding the conflict.

use axum::http::StatusCode;
use orbitid_core::http::now;
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::retention::{sweep_once, RETENTION_GRACE_MS, SESSION_RETENTION_MS};
use orbitid_identity::testing::{
    create_test_client_session, create_test_guest, create_test_user, test_app_state_with, TestApp,
};
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

fn router(state: &AppState) -> axum::Router {
    orbitid_server::build_app_without_retry(state.clone())
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

async fn insert_dead_verification(state: &AppState, owner_id: &str, identifier: &str) {
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
         max_attempts, expires_at, created_at) \
         VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$4)",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::VERIFICATION,
    ))
    .bind(identifier)
    .bind(owner_id)
    .bind(now() - RETENTION_GRACE_MS - 60_000)
    .execute(&state.pool)
    .await
    .expect("dead verification");
}

/// A row held by a foreground transaction must not end the retention drain:
/// the rest of the backlog behind it is deleted in the same tick.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_drains_past_a_row_locked_by_foreground() {
    // Concurrency test: the test holds a row lock while the sweep runs.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(4)).await;
    let state = app.state();
    let before = deadlocks(state).await;
    let now_ms = now();
    let batch = 3;
    let mut ids = Vec::new();
    for index in 0..12 {
        let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
        let expires_at = now_ms - RETENTION_GRACE_MS - (120 - index) * 60_000;
        sqlx::query(
            "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
             max_attempts, expires_at, created_at) \
             VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$5)",
        )
        .bind(&id)
        .bind(format!("locked-{index}@example.com"))
        .bind(format!("usr_locked_{index}"))
        .bind(expires_at)
        .bind(expires_at)
        .execute(&state.pool)
        .await
        .expect("dead verification");
        ids.push(id);
    }
    // Hold the oldest candidate; `SKIP LOCKED` must leave it for the next tick
    // without ending this one.
    let mut held = state.pool.begin().await.expect("hold a row");
    sqlx::query("SELECT id FROM verifications WHERE id = $1 FOR UPDATE")
        .bind(&ids[0])
        .fetch_one(&mut *held)
        .await
        .expect("lock the oldest verification");

    let sweep = sweep_once(state, Some(now_ms), Some(batch))
        .await
        .expect("retention tick");
    assert_eq!(
        sweep.verifications, 11,
        "every other eligible verification is deleted in one tick: {sweep:?}"
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_one(&state.pool)
            .await
            .expect("count");
    assert_eq!(remaining, 1, "only the held row remains");
    held.rollback().await.ok();
    assert_eq!(deadlocks(state).await - before, 0);
}

/// A busy client must not end the session sweep: the remaining eligible
/// sessions are still deleted in the same tick.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_drains_sessions_past_a_busy_client() {
    // Concurrency test: the test holds a client lock while the sweep runs.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(4)).await;
    let state = app.state();
    let before = deadlocks(state).await;
    let user = create_test_user(state, "retention-busy-client@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let now_ms = now();
    let batch = 3;
    let mut sessions = Vec::new();
    let mut held_client = None;
    for index in 0..10 {
        let auth = create_test_client_session(state, &user.user.id)
            .await
            .expect("session");
        sqlx::query("UPDATE sessions SET status = 'ended', updated_at = $1 WHERE id = $2")
            .bind(now_ms - SESSION_RETENTION_MS - (120 - index) * 60_000)
            .bind(&auth.session.id)
            .execute(&state.pool)
            .await
            .expect("age the session");
        if index == 0 {
            held_client = Some(auth.client.id.clone());
        }
        sessions.push(auth.session.id);
    }
    let held_client = held_client.expect("a client");
    let mut held = state.pool.begin().await.expect("hold a client");
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&held_client)
        .fetch_one(&mut *held)
        .await
        .expect("lock the busy client");

    let sweep = sweep_once(state, Some(now_ms), Some(batch))
        .await
        .expect("retention tick");
    assert_eq!(
        sweep.sessions, 9,
        "every session of another client is deleted: {sweep:?}"
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ANY($1)")
        .bind(&sessions)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(remaining, 1, "only the busy client's session remains");
    held.rollback().await.ok();
    assert_eq!(deadlocks(state).await - before, 0);
}

/// A *full* candidate page of rows held by foreground traffic must not end the
/// drain: the cursor advances past the whole page and the backlog behind it is
/// deleted in the same tick.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_drains_past_a_fully_locked_page() {
    // Concurrency test: the test holds a whole candidate page while the sweep runs.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(4)).await;
    let state = app.state();
    let before = deadlocks(state).await;
    let now_ms = now();
    let batch = 3;
    let mut locked_ids = Vec::new();
    for index in 0..batch {
        let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
        let expires_at = now_ms - RETENTION_GRACE_MS - 600_000 - index * 1_000;
        sqlx::query(
            "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
             max_attempts, expires_at, created_at) \
             VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$5)",
        )
        .bind(&id)
        .bind(format!("locked-page-{index}@example.com"))
        .bind(format!("usr_locked_page_{index}"))
        .bind(expires_at)
        .bind(expires_at)
        .execute(&state.pool)
        .await
        .expect("locked verification");
        locked_ids.push(id);
    }
    let mut eligible_ids = Vec::new();
    for index in 0..5 {
        let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
        let expires_at = now_ms - RETENTION_GRACE_MS - 300_000 + index * 1_000;
        sqlx::query(
            "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
             max_attempts, expires_at, created_at) \
             VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$5)",
        )
        .bind(&id)
        .bind(format!("behind-locked-{index}@example.com"))
        .bind(format!("usr_behind_locked_{index}"))
        .bind(expires_at)
        .bind(expires_at)
        .execute(&state.pool)
        .await
        .expect("eligible verification");
        eligible_ids.push(id);
    }
    let mut held = state.pool.begin().await.expect("hold the page");
    sqlx::query("SELECT id FROM verifications WHERE id = ANY($1) FOR UPDATE")
        .bind(&locked_ids)
        .fetch_all(&mut *held)
        .await
        .expect("lock the oldest page");

    let sweep = orbitid_identity::retention::sweep_with_budget(
        state,
        Some(now_ms),
        Some(batch),
        std::time::Duration::from_secs(10),
    )
    .await
    .expect("retention tick");
    assert_eq!(
        sweep.verifications, 5,
        "the backlog behind a fully locked page is deleted: {sweep:?}"
    );
    let behind: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE id = ANY($1)")
        .bind(&eligible_ids)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(behind, 0);
    let still_held: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE id = ANY($1)")
            .bind(&locked_ids)
            .fetch_one(&state.pool)
            .await
            .expect("count");
    assert_eq!(still_held, 3);
    held.rollback().await.ok();
    assert_eq!(deadlocks(state).await - before, 0);
}

/// When every candidate is locked the drain must return promptly (no
/// re-selecting the same page until the runtime budget expires).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_all_candidates_locked_returns_promptly() {
    // Concurrency test: the test holds every candidate while the sweep runs.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(4)).await;
    let state = app.state();
    let before = deadlocks(state).await;
    let now_ms = now();
    let batch = 3;
    let mut ids = Vec::new();
    for index in 0..batch {
        let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
        let expires_at = now_ms - RETENTION_GRACE_MS - 120_000 - index * 1_000;
        sqlx::query(
            "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
             max_attempts, expires_at, created_at) \
             VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$5)",
        )
        .bind(&id)
        .bind(format!("all-locked-{index}@example.com"))
        .bind(format!("usr_all_locked_{index}"))
        .bind(expires_at)
        .bind(expires_at)
        .execute(&state.pool)
        .await
        .expect("locked verification");
        ids.push(id);
    }
    let mut held = state.pool.begin().await.expect("hold all candidates");
    sqlx::query("SELECT id FROM verifications WHERE id = ANY($1) FOR UPDATE")
        .bind(&ids)
        .fetch_all(&mut *held)
        .await
        .expect("lock all candidates");

    let started = std::time::Instant::now();
    let sweep = orbitid_identity::retention::sweep_with_budget(
        state,
        Some(now_ms),
        Some(batch),
        std::time::Duration::from_secs(10),
    )
    .await
    .expect("retention tick");
    let elapsed = started.elapsed();
    assert_eq!(sweep.verifications, 0);
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "a fully locked candidate page must not spin through the budget: {elapsed:?}"
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE id = ANY($1)")
            .bind(&ids)
            .fetch_one(&state.pool)
            .await
            .expect("count");
    assert_eq!(remaining, 3);
    held.rollback().await.ok();
    assert_eq!(deadlocks(state).await - before, 0);
}

/// The session sweep behaves the same when a whole page of sessions belongs to
/// busy clients: the cursor advances past them and the other sessions drain.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_drains_sessions_past_a_fully_busy_page() {
    // Concurrency test: the test holds a whole page of clients while the sweep runs.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(4)).await;
    let state = app.state();
    let before = deadlocks(state).await;
    let user = create_test_user(state, "retention-busy-page@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let now_ms = now();
    let batch = 3;
    let mut busy_sessions = Vec::new();
    let mut busy_clients = Vec::new();
    for index in 0..batch {
        let auth = create_test_client_session(state, &user.user.id)
            .await
            .expect("busy session");
        sqlx::query("UPDATE sessions SET status = 'ended', updated_at = $1 WHERE id = $2")
            .bind(now_ms - SESSION_RETENTION_MS - 600_000 - index * 1_000)
            .bind(&auth.session.id)
            .execute(&state.pool)
            .await
            .expect("age the busy session");
        busy_clients.push(auth.client.id.clone());
        busy_sessions.push(auth.session.id);
    }
    let mut eligible_sessions = Vec::new();
    for index in 0..5 {
        let auth = create_test_client_session(state, &user.user.id)
            .await
            .expect("eligible session");
        sqlx::query("UPDATE sessions SET status = 'ended', updated_at = $1 WHERE id = $2")
            .bind(now_ms - SESSION_RETENTION_MS - 60_000 + index * 1_000)
            .bind(&auth.session.id)
            .execute(&state.pool)
            .await
            .expect("age the eligible session");
        eligible_sessions.push(auth.session.id);
    }
    let mut held = state.pool.begin().await.expect("hold the busy clients");
    sqlx::query("SELECT id FROM clients WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&busy_clients)
        .fetch_all(&mut *held)
        .await
        .expect("lock the busy clients");

    let sweep = orbitid_identity::retention::sweep_with_budget(
        state,
        Some(now_ms),
        Some(batch),
        std::time::Duration::from_secs(10),
    )
    .await
    .expect("retention tick");
    assert_eq!(
        sweep.sessions, 5,
        "sessions behind a fully busy page still drain: {sweep:?}"
    );
    let behind: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ANY($1)")
        .bind(&eligible_sessions)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(behind, 0);
    let still_busy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = ANY($1)")
        .bind(&busy_sessions)
        .fetch_one(&state.pool)
        .await
        .expect("count");
    assert_eq!(still_busy, 3);
    held.rollback().await.ok();
    assert_eq!(deadlocks(state).await - before, 0);
}

/// Retention deletes dead verifications while a sign-up issues and then
/// consumes a live one for the same attempt. The old sweep deleted
/// verifications and updated the client in one transaction, which deadlocked
/// against verification preparation.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_does_not_deadlock_with_sign_up_verification() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let browser = TestClient::new(router(state));
        let email = format!("retention-signup-{iteration}@example.com");
        let created = browser
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
        insert_dead_verification(state, &id, &email).await;

        let prepare_path = format!("/v1/client/sign_ups/{id}/prepare_verification");
        let prepared = browser.post(
            &prepare_path,
            Some(json!({ "strategy": "email_code" })),
            &[],
        );
        let swept = sweep_once(state, Some(now()), Some(5));
        let (prepared, swept) = tokio::join!(prepared, swept);
        assert_no_conflict("prepare verification", &prepared);
        assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
        swept.expect("retention tick");

        let code = orbitid_platform::mail::latest_code_for(state, &email, None)
            .expect("verification code");
        insert_dead_verification(state, &id, &email).await;
        let attempt_path = format!("/v1/client/sign_ups/{id}/attempt_verification");
        let attempted = browser.post(
            &attempt_path,
            Some(json!({ "strategy": "email_code", "code": code })),
            &[],
        );
        let swept = sweep_once(state, Some(now()), Some(5));
        let (attempted, swept) = tokio::join!(attempted, swept);
        assert_no_conflict("sign-up completion", &attempted);
        assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
        swept.expect("retention tick");
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "retention vs verification preparation/completion"
    );
}

/// Retention deletes dead verifications while a password sign-in completes for
/// the same client.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retention_does_not_deadlock_with_sign_in_completion() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let user = create_test_user(state, "retention-signin@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let before = deadlocks(state).await;

    for _ in 0..20 {
        let browser = TestClient::new(router(state));
        let created = browser
            .post(
                "/v1/client/sign_ins",
                Some(json!({ "identifier": "retention-signin@example.com" })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let id = created.value()["response"]["id"]
            .as_str()
            .expect("sign-in id")
            .to_string();
        insert_dead_verification(state, &id, "retention-signin@example.com").await;
        // An aged, ended session on the same client makes the retention tick
        // run its clients → sign_ups → sign_ins → sessions sweep while the
        // sign-in completion holds the same rows.
        let auth = create_test_client_session(state, &user.user.id)
            .await
            .expect("ended session");
        let client_id: String = sqlx::query_scalar("SELECT client_id FROM sign_ins WHERE id = $1")
            .bind(&id)
            .fetch_one(&state.pool)
            .await
            .expect("sign-in client");
        sqlx::query(
            "UPDATE sessions SET client_id = $1, status = 'ended', updated_at = $2 WHERE id = $3",
        )
        .bind(&client_id)
        .bind(now() - SESSION_RETENTION_MS - 60_000)
        .bind(&auth.session.id)
        .execute(&state.pool)
        .await
        .expect("age the session");

        let attempt_path = format!("/v1/client/sign_ins/{id}/attempt_first_factor");
        let attempted = browser.post(
            &attempt_path,
            Some(json!({ "strategy": "password", "password": "Sup3r-secret!" })),
            &[],
        );
        let swept = sweep_once(state, Some(now()), Some(5));
        let (attempted, swept) = tokio::join!(attempted, swept);
        assert_no_conflict("sign-in completion", &attempted);
        assert_eq!(attempted.status, StatusCode::OK, "{}", attempted.text());
        swept.expect("retention tick");
    }

    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND status = 'active'",
    )
    .bind(&user.user.id)
    .fetch_one(&state.pool)
    .await
    .expect("sessions");
    assert!(sessions >= 1);
    assert_eq!(
        deadlocks(state).await - before,
        0,
        "retention vs sign-in completion"
    );
}

/// Anonymous cleanup takes one guest's clients and user rows at a time; a
/// concurrent sign-out of the guest's session must never cycle with it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn anonymous_cleanup_does_not_deadlock_with_guest_sign_out() {
    // Concurrency test: simultaneous requests/worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    state
        .settings
        .update(json!({ "anonymous": { "enabled": true, "retentionSeconds": 60 } }))
        .await
        .expect("enable guest cleanup");
    let before = deadlocks(state).await;

    for _ in 0..30 {
        let guest = create_test_guest(state).await.expect("guest");
        let auth = create_test_client_session(state, &guest.id)
            .await
            .expect("guest session");
        sqlx::query("UPDATE users SET last_active_at = $1 WHERE id = $2")
            .bind(now() - 3_600_000)
            .bind(&guest.id)
            .execute(&state.pool)
            .await
            .expect("age the guest");
        let stored = orbitid_identity::sessions::get_session(state, &auth.session.id)
            .await
            .expect("load")
            .expect("session");
        let cleanup = orbitid_identity::anonymous::cleanup_tick(state);
        let sign_out = orbitid_identity::sessions::end_session(state, &stored, "ended");
        let (cleanup, sign_out) = tokio::join!(cleanup, sign_out);
        cleanup.expect("cleanup tick");
        sign_out.expect("sign-out");
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "anonymous cleanup vs guest sign-out"
    );
}
