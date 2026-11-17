//! Regression tests for lost updates on in-flight sign-ups and for completing
//! a sign-up from a stale snapshot.

mod common;

use axum::http::StatusCode;
use common::harness;
use orbitid_core::models::SignUpRow;
use orbitid_fapi_auth::signup::core::{complete_sign_up, CompleteSignUpOptions};
use serde_json::{json, Value};

async fn create_sign_up(h: &common::Harness, body: Value) -> (String, Value) {
    let created = h.client.post("/v1/client/sign_ups", Some(body), &[]).await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let value = created.value();
    let id = value["response"]["id"]
        .as_str()
        .expect("sign-up id")
        .to_string();
    (id, value)
}

async fn stored_fields(h: &common::Harness, id: &str) -> Value {
    let fields: sqlx::types::Json<Value> =
        sqlx::query_scalar("SELECT fields FROM sign_ups WHERE id = $1")
            .bind(id)
            .fetch_one(&h.state().pool)
            .await
            .expect("fields");
    fields.0
}

/// N rounds of concurrent `PATCH {password}` + `PATCH {first_name}` on one
/// sign-up. Before the CAS fix both returned 200 and one field was silently
/// lost (the writer reloaded the row and merged its stale replacement into it).
#[tokio::test]
async fn concurrent_password_and_first_name_patches_never_lose_a_field() {
    let h = harness().await;
    for round in 0..10 {
        let email = format!("race-{round}@example.com");
        let (id, _) = create_sign_up(&h, json!({ "email_address": email })).await;
        let path = format!("/v1/client/sign_ups/{id}");
        let first_name = format!("Round{round}");
        let password = "Sup3r-secret!";

        let left = h.client.clone();
        let right = h.client.clone();
        let (password_result, name_result) = tokio::join!(
            left.patch(&path, Some(json!({ "password": password })), &[]),
            right.patch(&path, Some(json!({ "first_name": first_name })), &[]),
        );

        // A loser must say `client_state_invalid`; retrying it serially must
        // succeed. A silent 200 that dropped the other field is the bug.
        for (result, retry_body, label) in [
            (password_result, json!({ "password": password }), "password"),
            (
                name_result,
                json!({ "first_name": first_name }),
                "first_name",
            ),
        ] {
            if result.status == StatusCode::BAD_REQUEST {
                assert_eq!(
                    result.error_codes(),
                    vec!["client_state_invalid"],
                    "round {round} {label}: {}",
                    result.text()
                );
                let retried = h.client.patch(&path, Some(retry_body), &[]).await;
                assert_eq!(
                    retried.status,
                    StatusCode::OK,
                    "round {round} {label} retry: {}",
                    retried.text()
                );
            } else {
                assert_eq!(
                    result.status,
                    StatusCode::OK,
                    "round {round} {label}: {}",
                    result.text()
                );
            }
        }

        let fields = stored_fields(&h, &id).await;
        assert_eq!(
            fields["firstName"], first_name,
            "round {round}: first_name was lost by the concurrent patch"
        );
        assert!(
            fields["passwordHash"].is_string(),
            "round {round}: password was lost by the concurrent patch"
        );
    }
}

/// A completion must refuse a snapshot that another writer advanced, even when
/// that snapshot looked completable. Deterministic: load+validate the row, then
/// change the email (which clears verification) through SQL, then complete.
#[tokio::test]
async fn completion_refuses_a_snapshot_whose_row_was_advanced() {
    let h = harness().await;
    let (id, _) = create_sign_up(
        &h,
        json!({ "email_address": "stale@example.com", "password": "Sup3r-secret!" }),
    )
    .await;
    // Make the row look completable: a verified email plus a password.
    sqlx::query(
        "UPDATE sign_ups SET fields = $1, verifications = $2, version = version + 1 \
         WHERE id = $3",
    )
    .bind(sqlx::types::Json(json!({
        "email_address": "stale@example.com",
        "password_hash": "hash",
    })))
    .bind(sqlx::types::Json(json!({
        "email_address": {
            "status": "verified",
            "strategy": "email_code",
            "identifier": "stale@example.com"
        }
    })))
    .bind(&id)
    .execute(&h.state().pool)
    .await
    .expect("make completable");

    // Request A's validated snapshot.
    let snapshot: SignUpRow = sqlx::query_as("SELECT * FROM sign_ups WHERE id = $1")
        .bind(&id)
        .fetch_one(&h.state().pool)
        .await
        .expect("snapshot");

    // Request B changes the email and therefore clears its verification.
    sqlx::query(
        "UPDATE sign_ups SET fields = jsonb_set(fields, '{email_address}', \
         '\"changed@example.com\"'::jsonb), \
         verifications = jsonb_set(verifications, '{email_address}', 'null'::jsonb), \
         version = version + 1 WHERE id = $1",
    )
    .bind(&id)
    .execute(&h.state().pool)
    .await
    .expect("conflicting write");

    let refused = complete_sign_up(
        h.state(),
        &snapshot,
        &CompleteSignUpOptions {
            rotate_client_token: true,
            ..Default::default()
        },
    )
    .await;
    let error = match refused {
        Ok(_) => panic!("stale completion must be refused"),
        Err(error) => error,
    };
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code, "client_state_invalid");

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&h.state().pool)
        .await
        .expect("users");
    assert_eq!(users, 0, "a refused completion must create no user");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&h.state().pool)
        .await
        .expect("sessions");
    assert_eq!(sessions, 0, "a refused completion must create no session");
}

/// Concurrent email change + code attempt: if a session is created at all, the
/// email it was created for must be the verified one, never the changed,
/// unverified address.
#[tokio::test]
async fn concurrent_email_change_and_verification_never_yields_an_unverified_session() {
    let h = harness().await;
    for round in 0..8 {
        let email = format!("verify-race-{round}@example.com");
        let (id, _) = create_sign_up(
            &h,
            json!({ "email_address": email, "password": "Sup3r-secret!" }),
        )
        .await;
        let prepared = h
            .client
            .post(
                &format!("/v1/client/sign_ups/{id}/prepare_verification"),
                Some(json!({ "strategy": "email_code" })),
                &[],
            )
            .await;
        assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
        let code = orbitid_platform::mail::latest_code_for(h.state(), &email, None)
            .expect("verification code");

        let path = format!("/v1/client/sign_ups/{id}");
        let attempt_path = format!("/v1/client/sign_ups/{id}/attempt_verification");
        let changed_email = format!("changed-race-{round}@example.com");
        let left = h.client.clone();
        let right = h.client.clone();
        let (changed, attempted) = tokio::join!(
            left.patch(&path, Some(json!({ "email_address": changed_email })), &[]),
            right.post(
                &attempt_path,
                Some(json!({ "strategy": "email_code", "code": code })),
                &[],
            ),
        );
        // Either request may lose the client-token rotation race: the
        // completion rotates the browser token, so a sibling request that
        // resolved the old cookie is refused with `client_state_invalid`.
        let lost_token_rotation = |response: &orbitid_core::testing::TestResponse| {
            response.status == StatusCode::UNAUTHORIZED
                && response.error_codes() == vec!["client_state_invalid"]
        };
        assert!(
            changed.status == StatusCode::OK
                || changed.status == StatusCode::BAD_REQUEST
                || lost_token_rotation(&changed),
            "round {round} email patch: {}",
            changed.text()
        );
        assert!(
            attempted.status == StatusCode::OK
                || attempted.status == StatusCode::BAD_REQUEST
                || attempted.status == StatusCode::UNPROCESSABLE_ENTITY
                || lost_token_rotation(&attempted),
            "round {round} attempt: {}",
            attempted.text()
        );

        // Whatever won, the invariant is: no session for an unverified address.
        let sessions: Vec<(String, String, bool)> = sqlx::query_as(
            "SELECT s.user_id, e.email, e.verified FROM sessions s \
             JOIN email_addresses e ON e.user_id = s.user_id \
             WHERE s.client_id = (SELECT client_id FROM sign_ups WHERE id = $1)",
        )
        .bind(&id)
        .fetch_all(&h.state().pool)
        .await
        .expect("sessions");
        for (user_id, session_email, verified) in sessions {
            assert!(
                verified,
                "round {round}: session for user {user_id} has unverified email {session_email}"
            );
        }
    }
}

async fn make_completable(h: &common::Harness, id: &str, email: &str) {
    sqlx::query(
        "UPDATE sign_ups SET status = 'missing_requirements', abandon_at = $1, \
         fields = $2, verifications = $3, version = version + 1 WHERE id = $4",
    )
    .bind(orbitid_core::http::now() + 60_000)
    .bind(sqlx::types::Json(json!({
        "emailAddress": email,
        "passwordHash": "hash",
    })))
    .bind(sqlx::types::Json(json!({
        "email_address": {
            "status": "verified",
            "strategy": "email_code",
            "identifier": email
        }
    })))
    .bind(id)
    .execute(&h.state().pool)
    .await
    .expect("make sign-up completable");
}

async fn sign_up_row(h: &common::Harness, id: &str) -> SignUpRow {
    sqlx::query_as("SELECT * FROM sign_ups WHERE id = $1")
        .bind(id)
        .fetch_one(&h.state().pool)
        .await
        .expect("sign-up row")
}

/// Two sibling sign-ups on one client completed at the same time. Before the
/// client-first lock order each transaction locked its own sign-up row and then
/// updated the sibling's, so Postgres aborted one with `40P01` (a 500).
#[tokio::test]
async fn concurrent_sibling_sign_up_completions_never_deadlock() {
    for round in 0..20 {
        let h = harness().await;
        let browser = h.other_browser();
        let first_email = format!("sibling-a-{round}@example.com");
        let second_email = format!("sibling-b-{round}@example.com");
        let first = browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": first_email })),
                &[],
            )
            .await;
        assert_eq!(first.status, StatusCode::OK, "{}", first.text());
        let second = browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": second_email })),
                &[],
            )
            .await;
        assert_eq!(second.status, StatusCode::OK, "{}", second.text());
        let first_id = first.value()["response"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let second_id = second.value()["response"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        make_completable(&h, &first_id, &first_email).await;
        make_completable(&h, &second_id, &second_email).await;
        let first_row = sign_up_row(&h, &first_id).await;
        let second_row = sign_up_row(&h, &second_id).await;
        let client_id = first_row.client_id.clone();

        let state = h.state().clone();
        let options = CompleteSignUpOptions::default();
        let left = {
            let state = state.clone();
            let options = options.clone();
            tokio::spawn(async move { complete_sign_up(&state, &first_row, &options).await })
        };
        let right = {
            let state = state.clone();
            tokio::spawn(async move { complete_sign_up(&state, &second_row, &options).await })
        };
        let results = [left.await.unwrap(), right.await.unwrap()];
        let errors: Vec<String> = results
            .iter()
            .filter_map(|result| result.as_ref().err().map(|error| format!("{error}")))
            .collect();
        assert_eq!(
            results.iter().filter(|result| result.is_ok()).count(),
            1,
            "round {round}: exactly one sibling completion wins ({errors:?})"
        );
        for result in results {
            if let Err(error) = result {
                assert!(
                    error.status.as_u16() < 500,
                    "round {round}: a lost completion must not be a 500: {error}"
                );
            }
        }
        let statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM sign_ups WHERE client_id = $1 ORDER BY id")
                .bind(&client_id)
                .fetch_all(&h.state().pool)
                .await
                .unwrap();
        assert!(statuses
            .iter()
            .all(|status| status == "complete" || status == "abandoned"));
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE client_id = $1 AND status = 'active'",
        )
        .bind(&client_id)
        .fetch_one(&h.state().pool)
        .await
        .unwrap();
        assert_eq!(active, 1, "round {round}: exactly one session");
    }
}

/// A sign-up completion and a sign-in completion on one client at the same
/// time: both take the client lock first, so neither can deadlock on the
/// other's attempt row.
#[tokio::test]
async fn concurrent_sign_up_and_sign_in_completions_never_deadlock() {
    use orbitid_fapi_auth::signin::complete::{complete_sign_in, CompleteOptions};
    use orbitid_identity::testing::create_test_user;

    for round in 0..20 {
        let h = harness().await;
        let browser = h.other_browser();
        let email = format!("signup-signin-{round}@example.com");
        let created = browser
            .post(
                "/v1/client/sign_ups",
                Some(json!({ "email_address": email })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let sign_up_id = created.value()["response"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        make_completable(&h, &sign_up_id, &email).await;
        let sign_up = sign_up_row(&h, &sign_up_id).await;
        let client_id = sign_up.client_id.clone();

        let existing = create_test_user(
            h.state(),
            &format!("existing-{round}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .unwrap();
        let sign_in_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::SIGN_IN);
        sqlx::query(
            "INSERT INTO sign_ins (id, client_id, status, identifier, user_id, state, \
             abandon_at, created_at, updated_at, version) \
             VALUES ($1, $2, 'needs_first_factor', $3, $4, '{}'::jsonb, $5, $5, $5, 0)",
        )
        .bind(&sign_in_id)
        .bind(&client_id)
        .bind(format!("existing-{round}@example.com"))
        .bind(&existing.user.id)
        .bind(orbitid_core::http::now() + 60_000)
        .execute(&h.state().pool)
        .await
        .unwrap();
        let sign_in: orbitid_core::models::SignInRow =
            sqlx::query_as("SELECT * FROM sign_ins WHERE id = $1")
                .bind(&sign_in_id)
                .fetch_one(&h.state().pool)
                .await
                .unwrap();

        let state = h.state().clone();
        let left = {
            let state = state.clone();
            tokio::spawn(async move {
                complete_sign_up(&state, &sign_up, &CompleteSignUpOptions::default()).await
            })
        };
        let right = {
            let state = state.clone();
            tokio::spawn(async move {
                complete_sign_in(&state, &sign_in, &CompleteOptions::default()).await
            })
        };
        let (sign_up_result, sign_in_result) = (left.await.unwrap(), right.await.unwrap());
        assert!(
            sign_up_result.is_ok(),
            "round {round}: the sign-up completes"
        );
        if let Err(error) = sign_in_result {
            assert!(
                error.status.as_u16() < 500,
                "round {round}: a lost sign-in completion must not be a 500: {error}"
            );
        }
        let status: String = sqlx::query_scalar("SELECT status FROM sign_ups WHERE id = $1")
            .bind(&sign_up_id)
            .fetch_one(&h.state().pool)
            .await
            .unwrap();
        assert_eq!(status, "complete");
        let status: String = sqlx::query_scalar("SELECT status FROM sign_ins WHERE id = $1")
            .bind(&sign_in_id)
            .fetch_one(&h.state().pool)
            .await
            .unwrap();
        assert!(
            status == "complete" || status == "abandoned",
            "round {round}: sign-in left in {status}"
        );
    }
}

/// Patching a sibling that a newer sign-up abandoned reports expiry, not the
/// generic "updated by another request" message.
#[tokio::test]
async fn patching_an_abandoned_sign_up_reports_expiry() {
    let h = harness().await;
    let first = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "email_address": "abandoned@example.com" })),
            &[],
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    let id = first.value()["response"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let second = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(json!({ "email_address": "newer@example.com" })),
            &[],
        )
        .await;
    assert_eq!(second.status, StatusCode::OK, "{}", second.text());

    let patched = h
        .client
        .patch(
            &format!("/v1/client/sign_ups/{id}"),
            Some(json!({ "first_name": "Stale" })),
            &[],
        )
        .await;
    assert_eq!(
        patched.status,
        StatusCode::BAD_REQUEST,
        "{}",
        patched.text()
    );
    assert_eq!(patched.error_codes(), vec!["client_state_invalid"]);
    let message = patched.value()["errors"][0]["long_message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        message.contains("expired"),
        "expected an expiry message, got: {message}"
    );
}

/// Sign-up completion claiming an address that another user's unverified claim
/// holds must lock that user (rank 3) before the sign-up row (rank 4). The
/// other transaction holds the claim owner and then wants the sign-up row (the
/// legal 3 -> 4 order): with the old order (sign-up first, owner second) this
/// is a deadlock; now the completion waits on the owner without holding the
/// sign-up row. The retry layer is not involved (domain function), so the
/// deadlock counter is the assertion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sign_up_completion_locks_claim_owners_before_the_sign_up_row() {
    let h = harness().await;
    let state = h.state().clone();
    let deadlocks = |state: orbitid_core::state::AppState| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
             WHERE datname = current_database()",
        )
        .fetch_one(&state.pool)
        .await
        .expect("deadlocks")
    };
    let before = deadlocks(state.clone()).await;
    let address = "claimed@example.com";
    let owner =
        orbitid_identity::testing::create_test_user(&state, "owner@example.com", "Sup3r-secret!")
            .await
            .expect("owner");
    let claim_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::EMAIL);
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, created_at, updated_at) \
         VALUES ($1,$2,$3,false,$4,$4)",
    )
    .bind(&claim_id)
    .bind(&owner.user.id)
    .bind(address)
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("claim");
    let (id, _) = create_sign_up(&h, json!({ "email_address": "pending@example.com" })).await;
    make_completable(&h, &id, address).await;
    let row = sign_up_row(&h, &id).await;

    // The owner's side: lock the owner user, then the sign-up row.
    let mut tx = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(&owner.user.id)
        .fetch_one(&mut *tx)
        .await
        .expect("lock owner");
    let completion = {
        let state = state.clone();
        tokio::spawn(async move {
            complete_sign_up(&state, &row, &CompleteSignUpOptions::default()).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    sqlx::query("SELECT id FROM sign_ups WHERE id = $1 FOR UPDATE")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .expect("lock sign-up after owner");
    tx.commit().await.expect("commit");
    completion
        .await
        .expect("join")
        .expect("completion succeeds without a deadlock");

    assert_eq!(deadlocks(state.clone()).await - before, 0);
    let claims: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM email_addresses WHERE email = $1")
        .bind(address)
        .fetch_one(&state.pool)
        .await
        .expect("claims");
    assert_eq!(claims, 1, "the owner's unverified claim was purged");
}

async fn deadlock_count(state: &orbitid_core::state::AppState) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlocks")
}

/// Starts a sign-up for `address`, prepares `strategy` and returns its id plus
/// an owner user holding an unverified claim on `address`.
async fn sign_up_with_claim_owner(
    h: &common::Harness,
    address: &str,
    strategy: &str,
) -> (String, String) {
    let state = h.state().clone();
    let owner =
        orbitid_identity::testing::create_test_user(&state, "owner@example.com", "Sup3r-secret!")
            .await
            .expect("owner");
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, created_at, updated_at) \
         VALUES ($1,$2,$3,false,$4,$4)",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::EMAIL,
    ))
    .bind(&owner.user.id)
    .bind(address)
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("claim");
    let (id, _) = create_sign_up(
        h,
        json!({ "email_address": address, "password": "Sup3r-secret!" }),
    )
    .await;
    let prepared = h
        .client
        .post(
            &format!("/v1/client/sign_ups/{id}/prepare_verification"),
            Some(json!({ "strategy": strategy })),
            &[],
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    (id, owner.user.id)
}

/// Holds the owner user, lets `request` block behind it, then locks the
/// sign-up row (the owner's 3 -> 4 order). The request must wait on the owner
/// without holding the sign-up row, so nothing deadlocks.
async fn assert_request_locks_owner_before_sign_up<F, Fut>(
    h: &common::Harness,
    id: &str,
    owner_id: &str,
    address: &str,
    request: F,
) where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = orbitid_core::testing::TestResponse> + Send + 'static,
{
    let state = h.state().clone();
    let before = deadlock_count(&state).await;
    let mut tx = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(owner_id)
        .fetch_one(&mut *tx)
        .await
        .expect("lock owner");
    let pending = tokio::spawn(request());
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    sqlx::query("SELECT id FROM sign_ups WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .expect("lock sign-up after owner");
    tx.commit().await.expect("commit");
    let _ = pending.await.expect("join");
    assert_eq!(deadlock_count(&state).await - before, 0);
    let status: String = sqlx::query_scalar("SELECT status FROM sign_ups WHERE id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .expect("status");
    assert_eq!(status, "complete", "the completion succeeded");
    let claims: Vec<bool> =
        sqlx::query_scalar("SELECT verified FROM email_addresses WHERE email = $1")
            .bind(address)
            .fetch_all(&state.pool)
            .await
            .expect("claims");
    assert_eq!(claims, vec![true], "only the verified claim is left");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn attempt_verification_locks_claim_owners_before_the_sign_up_row() {
    let h = harness().await;
    let address = "claimed-code@example.com";
    let (id, owner_id) = sign_up_with_claim_owner(&h, address, "email_code").await;
    let code = orbitid_platform::mail::latest_code_for(h.state(), address, None).expect("code");
    let client = h.client.clone();
    let path = format!("/v1/client/sign_ups/{id}/attempt_verification");
    assert_request_locks_owner_before_sign_up(&h, &id, &owner_id, address, move || async move {
        client
            .post(
                &path,
                Some(json!({ "strategy": "email_code", "code": code })),
                &[],
            )
            .await
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn email_link_verification_locks_claim_owners_before_the_sign_up_row() {
    let h = harness().await;
    let address = "claimed-link@example.com";
    let (id, owner_id) = sign_up_with_claim_owner(&h, address, "email_link").await;
    let link = orbitid_platform::mail::latest_link_for(h.state(), address).expect("link");
    let token = url::Url::parse(&link)
        .expect("link url")
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .expect("token");
    let client = h.client.clone();
    assert_request_locks_owner_before_sign_up(&h, &id, &owner_id, address, move || async move {
        client.get(&format!("/v1/verify?token={token}"), &[]).await
    })
    .await;
}
