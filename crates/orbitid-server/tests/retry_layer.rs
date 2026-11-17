//! Layer 2: the request-level retry of deadlocked transactions.
//!
//! A test-only handler deadlocks two transactions deterministically and returns
//! the resulting 409 `transaction_conflict`. The retry layer replays the whole
//! request; the handler then succeeds. The separately-committed counters (rate
//! limit / failed attempts) check the replay flag and are not doubled, and the
//! "mail" write (post-commit in the real handlers) happens only on the attempt
//! whose transaction succeeded.
//!
//! It also proves the safety gates: a non-retryable 409 is never replayed, and
//! an external-effect path (OAuth code exchange) is never replayed.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::testing::EphemeralDb;
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tower::ServiceExt;

#[derive(Clone)]
struct Shared {
    pool: PgPool,
    calls: Arc<AtomicUsize>,
    separate_counter: Arc<AtomicUsize>,
    mail: Arc<AtomicUsize>,
}

async fn send(app: &Router, path: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// Two transactions that lock the same two rows in opposite orders. One is
/// aborted with SQLSTATE `40P01`; the other is rolled back.
async fn force_deadlock(pool: &PgPool) -> OrbitError {
    sqlx::query(
        "INSERT INTO rate_limit_windows (key, count, reset_at) \
         VALUES ('deadlock_a', 0, 0), ('deadlock_b', 0, 0) ON CONFLICT (key) DO NOTHING",
    )
    .execute(pool)
    .await
    .expect("seed deadlock rows");
    let mut first = pool.begin().await.expect("first transaction");
    let mut second = pool.begin().await.expect("second transaction");
    for tx in [&mut first, &mut second] {
        sqlx::query("SET LOCAL deadlock_timeout = '50ms'")
            .execute(&mut **tx)
            .await
            .expect("short deadlock timeout");
    }
    sqlx::query("UPDATE rate_limit_windows SET count = count WHERE key = 'deadlock_a'")
        .execute(&mut *first)
        .await
        .expect("lock a");
    sqlx::query("UPDATE rate_limit_windows SET count = count WHERE key = 'deadlock_b'")
        .execute(&mut *second)
        .await
        .expect("lock b");
    let upgrade_first =
        sqlx::query("UPDATE rate_limit_windows SET count = count WHERE key = 'deadlock_b'")
            .execute(&mut *first);
    let upgrade_second =
        sqlx::query("UPDATE rate_limit_windows SET count = count WHERE key = 'deadlock_a'")
            .execute(&mut *second);
    let (one, two) = tokio::join!(upgrade_first, upgrade_second);
    let error = match (one, two) {
        (Err(error), _) => error,
        (_, Err(error)) => error,
        _ => panic!("one transaction must be aborted as a deadlock"),
    };
    let _ = first.rollback().await;
    let _ = second.rollback().await;
    OrbitError::from(error)
}

async fn probe(State(shared): State<Shared>, Json(body): Json<Value>) -> Result<Response> {
    let attempt = shared.calls.fetch_add(1, Ordering::SeqCst) + 1;
    // A counter committed in its own statement *before* the transaction, like
    // the rate-limit budget and the failed-attempt counter. A replay must not
    // consume a second unit.
    if !orbitid_core::http::replay::is_replay() {
        shared.separate_counter.fetch_add(1, Ordering::SeqCst);
    }
    if attempt == 1 {
        return Err(force_deadlock(&shared.pool).await);
    }
    // Post-commit effect (mail): only the successful attempt reaches it.
    shared.mail.fetch_add(1, Ordering::SeqCst);
    Ok(Json(json!({ "ok": true, "value": body["value"] })).into_response())
}

async fn reject(State(shared): State<Shared>) -> Result<Response> {
    shared.calls.fetch_add(1, Ordering::SeqCst);
    Err(OrbitError::conflict(
        error_codes::DUPLICATE_RECORD,
        "That record already exists",
    ))
}

async fn always_conflict(State(shared): State<Shared>) -> Result<Response> {
    shared.calls.fetch_add(1, Ordering::SeqCst);
    Err(OrbitError::conflict(
        error_codes::TRANSACTION_CONFLICT,
        "conflict",
    ))
}

async fn external_effect(State(shared): State<Shared>) -> Result<Response> {
    let attempt = shared.calls.fetch_add(1, Ordering::SeqCst) + 1;
    if attempt == 1 {
        return Err(OrbitError::conflict(
            error_codes::TRANSACTION_CONFLICT,
            "conflict",
        ));
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn harness() -> (Router, Shared, EphemeralDb) {
    let db = EphemeralDb::create().await.expect("ephemeral database");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&db.url)
        .await
        .expect("pool");
    let shared = Shared {
        pool,
        calls: Arc::new(AtomicUsize::new(0)),
        separate_counter: Arc::new(AtomicUsize::new(0)),
        mail: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/probe", post(probe))
        .route("/conflict", post(reject))
        .route("/always", post(always_conflict))
        .route("/v1/oauth_callback/test", post(external_effect))
        .with_state(shared.clone())
        .layer(orbitid_server::retry::RetryLayer);
    (app, shared, db)
}

#[tokio::test]
async fn a_deadlocked_request_is_replayed_and_side_effects_are_not_doubled() {
    let (app, shared, _db) = harness().await;
    // Second attempt returns the ORIGINAL request body.
    let (status, body) = send(&app, "/probe", json!({ "value": 7 })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["value"], json!(7), "replayed body");
    assert_eq!(shared.calls.load(Ordering::SeqCst), 2, "one replay");
    assert_eq!(
        shared.separate_counter.load(Ordering::SeqCst),
        1,
        "the separately-committed counter is not doubled"
    );
    assert_eq!(
        shared.mail.load(Ordering::SeqCst),
        1,
        "the post-commit effect happens once"
    );
}

#[tokio::test]
async fn a_non_retryable_conflict_is_not_replayed() {
    let (app, shared, _db) = harness().await;
    let (status, _) = send(&app, "/conflict", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(shared.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn external_effect_routes_are_never_replayed() {
    let (app, shared, _db) = harness().await;
    let (status, _) = send(&app, "/v1/oauth_callback/test", json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "the 409 reaches the client");
    assert_eq!(
        shared.calls.load(Ordering::SeqCst),
        1,
        "an OAuth code exchange must not run twice"
    );
}

#[tokio::test]
async fn retries_are_bounded_and_the_last_conflict_reaches_the_client() {
    let (app, shared, _db) = harness().await;
    let (status, _) = send(&app, "/always", json!({})).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "the retryable 409 is preserved"
    );
    assert_eq!(
        shared.calls.load(Ordering::SeqCst),
        orbitid_server::retry::MAX_ATTEMPTS as usize,
        "attempts are bounded"
    );
}

// ───────────── replay-safe side effects ─────────────

use std::collections::HashSet;
use std::sync::Mutex;

use orbitid_core::AppState;
use orbitid_identity::testing::create_test_user;
use orbitid_platform::{captcha::set_captcha_verifier_for_tests, verify_captcha, CaptchaVerifier};

/// A CAPTCHA verifier that accepts each token once and rejects reuse, exactly
/// like the real single-use providers.
struct OnceVerifier {
    seen: Mutex<HashSet<String>>,
}

#[async_trait::async_trait]
impl CaptchaVerifier for OnceVerifier {
    async fn verify(&self, token: &str, _remote_ip: Option<&str>) -> bool {
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        seen.insert(token.to_string())
    }
}

#[derive(Clone)]
struct CaptchaShared {
    state: AppState,
    pool: PgPool,
    calls: Arc<AtomicUsize>,
    verifier: Arc<OnceVerifier>,
}

async fn captcha_probe(State(shared): State<CaptchaShared>) -> Result<Response> {
    let attempt = shared.calls.fetch_add(1, Ordering::SeqCst) + 1;
    // The single-use token succeeds on the first attempt. The handler then hits
    // a deadlock, and the replay must not submit the token again.
    verify_captcha(&shared.state, Some("one-time-token"), None).await?;
    if attempt == 1 {
        return Err(force_deadlock(&shared.pool).await);
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn captcha_harness() -> (Router, CaptchaShared) {
    // The deadlock helper opens two transactions; the state needs spare connections.
    let app = orbitid_identity::testing::test_app_state_with(
        orbitid_core::testing::test_pool_exemption(4),
    )
    .await;
    let state = app.state().clone();
    state
        .settings
        .update(json!({
            "security": {
                "captchaProvider": "turnstile",
                "captchaSecret": "turnstile-secret",
                "captchaSiteKey": "site-key"
            }
        }))
        .await
        .expect("enable captcha");
    let verifier = Arc::new(OnceVerifier {
        seen: Mutex::new(HashSet::new()),
    });
    set_captcha_verifier_for_tests(
        &state,
        Some(Arc::clone(&verifier) as Arc<dyn CaptchaVerifier>),
    );
    let shared = CaptchaShared {
        pool: state.pool.clone(),
        state,
        calls: Arc::new(AtomicUsize::new(0)),
        verifier,
    };
    let router = Router::new()
        .route("/probe", post(captcha_probe))
        .with_state(shared.clone())
        .layer(orbitid_server::retry::RetryLayer);
    (router, shared)
}

#[tokio::test]
async fn a_replayed_request_does_not_resubmit_a_single_use_captcha_token() {
    let (app, shared) = captcha_harness().await;
    let (status, body) = send(&app, "/probe", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(shared.calls.load(Ordering::SeqCst), 2, "one replay");
    let seen = shared
        .verifier
        .seen
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        seen.iter().collect::<Vec<_>>(),
        vec!["one-time-token"],
        "the provider must see the token exactly once"
    );
}

#[derive(Clone)]
struct AttemptShared {
    state: AppState,
    pool: PgPool,
    user_id: String,
    calls: Arc<AtomicUsize>,
    /// `true` records the counter before the deadlock; `false` deadlocks first.
    record_first: bool,
}

async fn failed_attempt_probe(State(shared): State<AttemptShared>) -> Result<Response> {
    let attempt = shared.calls.fetch_add(1, Ordering::SeqCst) + 1;
    if attempt == 1 && shared.record_first {
        orbitid_identity::users::record_failed_attempt(&shared.state, &shared.user_id).await?;
        return Err(force_deadlock(&shared.pool).await);
    }
    if attempt == 1 {
        return Err(force_deadlock(&shared.pool).await);
    }
    orbitid_identity::users::record_failed_attempt(&shared.state, &shared.user_id).await?;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn attempt_harness(record_first: bool) -> (Router, AttemptShared) {
    // The deadlock helper opens two transactions; the state needs spare connections.
    let app = orbitid_identity::testing::test_app_state_with(
        orbitid_core::testing::test_pool_exemption(4),
    )
    .await;
    let state = app.state().clone();
    let user = create_test_user(&state, "retry-attempt@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let shared = AttemptShared {
        pool: state.pool.clone(),
        state,
        user_id: user.user.id,
        calls: Arc::new(AtomicUsize::new(0)),
        record_first,
    };
    let router = Router::new()
        .route("/probe", post(failed_attempt_probe))
        .with_state(shared.clone())
        .layer(orbitid_server::retry::RetryLayer);
    (router, shared)
}

/// If the first attempt committed the failed-attempt counter and then hit a
/// retryable conflict, the replay must not count the same wrong guess twice.
#[tokio::test]
async fn a_committed_failed_attempt_is_not_counted_twice_on_replay() {
    let (app, shared) = attempt_harness(true).await;
    let (status, body) = send(&app, "/probe", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let attempts: i64 = sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = $1")
        .bind(&shared.user_id)
        .fetch_one(&shared.pool)
        .await
        .expect("counter");
    assert_eq!(attempts, 1, "the committed counter must not be doubled");
}

/// If the first attempt deadlocked *before* recording the counter, the replay
/// must record it; otherwise a wrong guess would go uncounted.
#[tokio::test]
async fn an_uncommitted_failed_attempt_is_recorded_on_replay() {
    let (app, shared) = attempt_harness(false).await;
    let (status, body) = send(&app, "/probe", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let attempts: i64 = sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = $1")
        .bind(&shared.user_id)
        .fetch_one(&shared.pool)
        .await
        .expect("counter");
    assert_eq!(attempts, 1, "the replay must record the uncounted failure");
}

#[derive(Clone)]
struct CodeAttemptShared {
    state: AppState,
    pool: PgPool,
    verification_id: String,
    calls: Arc<AtomicUsize>,
}

/// Mirrors a handler that commits a refused per-code increment and then hits a
/// retryable conflict while recording the account-level failure.
async fn code_attempt_probe(State(shared): State<CodeAttemptShared>) -> Result<Response> {
    let attempt = shared.calls.fetch_add(1, Ordering::SeqCst) + 1;
    let verification = sqlx::query_as::<_, orbitid_core::models::VerificationRow>(
        "SELECT * FROM verifications WHERE id = $1",
    )
    .bind(&shared.verification_id)
    .fetch_one(&shared.pool)
    .await?;
    let mut tx = shared.pool.begin().await?;
    let result = orbitid_identity::verifications::check_code_on(
        &mut tx,
        &shared.state,
        Some(&verification),
        Some("wrong-code"),
    )
    .await?;
    match result {
        orbitid_identity::verifications::CodeCheck::Verified(_) => {
            tx.commit().await?;
            Ok(Json(json!({ "ok": true })).into_response())
        }
        orbitid_identity::verifications::CodeCheck::Refused(refusal) => {
            let error = orbitid_identity::verifications::commit_code_refusal(tx, refusal).await?;
            if attempt == 1 {
                // The separately-committed account counter hits a deadlock and
                // the whole request is replayed.
                return Err(force_deadlock(&shared.pool).await);
            }
            Err(error)
        }
    }
}

async fn code_attempt_harness() -> (Router, CodeAttemptShared) {
    // The deadlock helper opens two transactions; the state needs spare connections.
    let app = orbitid_identity::testing::test_app_state_with(
        orbitid_core::testing::test_pool_exemption(4),
    )
    .await;
    let state = app.state().clone();
    let user = create_test_user(&state, "retry-code@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let verification_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, code_hash, \
         attempts, max_attempts, expires_at, created_at) \
         VALUES ($1,'sign_in','email_code','retry-code@example.com',$2,$3,0,5,$4,$5)",
    )
    .bind(&verification_id)
    .bind(&user.user.id)
    .bind(orbitid_core::crypto::hash_low_entropy(
        &state.env.encryption_key,
        "123456",
    ))
    .bind(now + 3_600_000)
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("verification");
    let shared = CodeAttemptShared {
        pool: state.pool.clone(),
        state,
        verification_id,
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let router = Router::new()
        .route("/probe", post(code_attempt_probe))
        .with_state(shared.clone())
        .layer(orbitid_server::retry::RetryLayer);
    (router, shared)
}

/// A per-code attempt counter committed before a retryable conflict must not be
/// counted again on the replay; the response is still the wrong-code error.
#[tokio::test]
async fn a_committed_code_attempt_is_not_counted_twice_on_replay() {
    let (app, shared) = code_attempt_harness().await;
    let (status, body) = send(&app, "/probe", json!({})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["errors"][0]["code"], "form_code_incorrect",
        "the replay must return the same wrong-code error"
    );
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM verifications WHERE id = $1")
        .bind(&shared.verification_id)
        .fetch_one(&shared.pool)
        .await
        .expect("attempts");
    assert_eq!(attempts, 1, "one wrong guess must count once");
    assert_eq!(shared.calls.load(Ordering::SeqCst), 2, "one replay");
}
