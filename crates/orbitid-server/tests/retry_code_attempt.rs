//! A database failure in the per-code attempt increment must never be
//! remembered as a committed attempt.
//!
//! The first increment is aborted with SQLSTATE `40001` by a test trigger. The
//! transaction is aborted, so Postgres would answer `COMMIT` with `ROLLBACK`
//! and no error; the handler must propagate the failure (never mark the replay
//! memo), and the replay must evaluate the code for real.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use orbitid_core::error::Result;
use orbitid_core::AppState;
use orbitid_identity::testing::create_test_user;
use orbitid_identity::verifications::{check_code_on, commit_code_refusal, CodeCheck};
use serde_json::{json, Value};
use tower::ServiceExt;

#[derive(Clone)]
struct Shared {
    state: AppState,
    verification_id: String,
    calls: Arc<AtomicUsize>,
}

async fn probe(State(shared): State<Shared>, Json(body): Json<Value>) -> Result<Response> {
    shared.calls.fetch_add(1, Ordering::SeqCst);
    let code = body["code"].as_str().unwrap_or("").to_string();
    let mut tx = shared.state.pool.begin().await?;
    let verification = orbitid_identity::verifications::get_verification_by_id_on(
        &mut tx,
        &shared.verification_id,
    )
    .await?;
    match check_code_on(&mut tx, &shared.state, verification.as_ref(), Some(&code)).await? {
        CodeCheck::Verified(_) => {
            tx.commit().await?;
            Ok(Json(json!({ "ok": true })).into_response())
        }
        CodeCheck::Refused(refusal) => Err(commit_code_refusal(tx, refusal).await?),
    }
}

async fn harness() -> (Router, Shared, orbitid_identity::testing::TestApp) {
    let app = orbitid_identity::testing::test_app_state().await;
    let state = app.state().clone();
    let user = create_test_user(&state, "retry-inc@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::VERIFICATION);
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, code_hash, \
         attempts, max_attempts, expires_at, created_at) \
         VALUES ($1,'sign_in','email_code','retry-inc@example.com',$2,$3,0,5,$4,$5)",
    )
    .bind(&id)
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
    // The first attempts-increment fails with a serialization failure; every
    // later one succeeds (a sequence is not rolled back with the transaction).
    for statement in [
        "CREATE SEQUENCE fail_once_seq",
        "CREATE FUNCTION fail_first_increment() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF nextval('fail_once_seq') = 1 THEN \
         RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$",
        "CREATE TRIGGER fail_first_increment BEFORE UPDATE ON verifications \
         FOR EACH ROW WHEN (NEW.attempts > OLD.attempts) EXECUTE FUNCTION fail_first_increment()",
    ] {
        sqlx::query(statement)
            .execute(&state.pool)
            .await
            .expect("inject failure");
    }
    let shared = Shared {
        state,
        verification_id: id,
        calls: Arc::new(AtomicUsize::new(0)),
    };
    let router = Router::new()
        .route("/probe", post(probe))
        .with_state(shared.clone())
        .layer(orbitid_server::retry::RetryLayer);
    (router, shared, app)
}

async fn send(app: &Router, code: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri("/probe")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({ "code": code }).to_string()))
        .expect("request");
    let response = app.clone().oneshot(request).await.expect("router");
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("body");
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn attempts(shared: &Shared) -> i64 {
    sqlx::query_scalar("SELECT attempts FROM verifications WHERE id = $1")
        .bind(&shared.verification_id)
        .fetch_one(&shared.state.pool)
        .await
        .expect("attempts")
}

#[tokio::test]
async fn a_correct_code_succeeds_after_the_first_increment_failed_retryably() {
    let (app, shared, _guard) = harness().await;
    let (status, body) = send(&app, "123456").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(shared.calls.load(Ordering::SeqCst), 2, "one replay");
    assert_eq!(attempts(&shared).await, 1);
}

#[tokio::test]
async fn a_wrong_code_is_refused_and_counted_exactly_once_after_a_failed_increment() {
    let (app, shared, _guard) = harness().await;
    let (status, body) = send(&app, "000000").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["errors"][0]["code"], "form_code_incorrect");
    assert_eq!(shared.calls.load(Ordering::SeqCst), 2, "one replay");
    assert_eq!(attempts(&shared).await, 1, "counted exactly once");
}
