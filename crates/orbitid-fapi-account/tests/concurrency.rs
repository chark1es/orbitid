//! Races that must resolve to exactly one winner.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;

#[tokio::test]
async fn two_last_admins_leaving_yield_exactly_one_success() {
    let harness = harness().await;
    harness
        .state()
        .settings
        .update(json!({ "organizations": { "enabled": true } }))
        .await
        .expect("settings");
    let first = harness
        .signed_in("leave-one@example.com", "Sup3r-secret!")
        .await;
    let second = harness
        .signed_in("leave-two@example.com", "Sup3r-secret!")
        .await;
    let created = first
        .client
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": "Two Admins" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let org_id = created.value()["response"]["id"]
        .as_str()
        .expect("org id")
        .to_string();
    // Second admin, directly (the invitation flow is covered elsewhere).
    sqlx::query(
        "INSERT INTO organization_memberships (id, organization_id, user_id, role_key, \
         public_metadata, private_metadata, created_at, updated_at) \
         VALUES ('mem_leave_two', $1, $2, 'org:admin', '{}', '{}', 1, 1)",
    )
    .bind(&org_id)
    .bind(&second.user_id)
    .execute(&harness.state().pool)
    .await
    .expect("membership");

    let path = format!("/v1/client/me/organization_memberships/{org_id}");
    let (left, right) = tokio::join!(
        first.client.delete(&path, None, &[]),
        second.client.delete(&path, None, &[]),
    );
    let statuses = [left.status, right.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "exactly one last-admin leave must succeed: {statuses:?}"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::FORBIDDEN)
            .count(),
        1,
        "exactly one leave must be refused: {statuses:?}"
    );
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("memberships");
    assert_eq!(remaining, 1, "the organization must keep one admin");
}

#[tokio::test]
async fn deleting_the_last_two_identifications_lets_exactly_one_through() {
    let harness = harness().await;
    let signed = harness
        .signed_in("last-ident@example.com", "Sup3r-secret!")
        .await;
    let email_id: String = sqlx::query_scalar(
        "SELECT id FROM email_addresses WHERE user_id = $1 ORDER BY created_at LIMIT 1",
    )
    .bind(&signed.user_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("email");
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, reserved_for_second_factor, \
         default_second_factor, created_at, updated_at) \
         VALUES ('phone_last_ident', $1, '+15555550123', true, false, false, 1, 1)",
    )
    .bind(&signed.user_id)
    .execute(&harness.state().pool)
    .await
    .expect("phone");

    let email_path = format!("/v1/client/me/email_addresses/{email_id}");
    let (email, phone) = tokio::join!(
        signed.client.delete(&email_path, None, &[]),
        signed
            .client
            .delete("/v1/client/me/phone_numbers/phone_last_ident", None, &[]),
    );
    let statuses = [email.status, phone.status];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1,
        "exactly one delete must succeed: {statuses:?}"
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::UNPROCESSABLE_ENTITY)
            .count(),
        1,
        "the other delete must be refused as the last identification: {statuses:?}"
    );
    let remaining: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM email_addresses WHERE user_id = $1) + \
                (SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1)",
    )
    .bind(&signed.user_id)
    .fetch_one(&harness.state().pool)
    .await
    .expect("identifications");
    assert_eq!(remaining, 1);
}

async fn deadlocks(state: &orbitid_core::AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

/// A harness whose pool fits several concurrent requests. This router has no
/// retry layer, so a Postgres deadlock would surface as a 500 and in the
/// deadlock counter instead of being replayed.
async fn concurrent_harness() -> Harness {
    let test = orbitid_identity::testing::test_app_state_with(
        orbitid_core::testing::test_pool_exemption(8),
    )
    .await;
    let app = build_app(test.state().clone());
    test.state()
        .settings
        .update(json!({
            "attributes": { "phoneNumber": { "enabled": true, "usedForSecondFactor": true } }
        }))
        .await
        .expect("settings");
    Harness { test, app }
}

/// Two PATCHes making different phones of one user the default second factor
/// each lock the user (rank 3) before any phone row, so the sibling swap of one
/// cannot cycle with the row lock of the other.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_default_second_factor_patches_do_not_deadlock() {
    let harness = concurrent_harness().await;
    let signed = harness
        .signed_in("phone-default@example.com", "Sup3r-secret!")
        .await;
    for (id, phone) in [
        ("phone_default_a", "+15555550141"),
        ("phone_default_b", "+15555550142"),
    ] {
        sqlx::query(
            "INSERT INTO phone_numbers (id, user_id, phone, verified, reserved_for_second_factor, \
             default_second_factor, created_at, updated_at) \
             VALUES ($1, $2, $3, true, true, false, 1, 1)",
        )
        .bind(id)
        .bind(&signed.user_id)
        .bind(phone)
        .execute(&harness.state().pool)
        .await
        .expect("phone");
    }
    // Two client sessions of the same user: one client lock would serialize the
    // requests and they would never contend on the user row.
    let other =
        orbitid_identity::testing::create_test_client_session(harness.state(), &signed.user_id)
            .await
            .expect("second session");
    let other_client = harness.client_with_cookie(&other.cookie);
    let before = deadlocks(harness.state()).await;
    let body = json!({ "default_second_factor": true });
    for iteration in 0..25 {
        let (first, second) = tokio::join!(
            signed.client.request(
                "PATCH",
                "/v1/client/me/phone_numbers/phone_default_a",
                Some(body.clone()),
                &[]
            ),
            other_client.request(
                "PATCH",
                "/v1/client/me/phone_numbers/phone_default_b",
                Some(body.clone()),
                &[]
            ),
        );
        for response in [&first, &second] {
            assert_eq!(
                response.status,
                StatusCode::OK,
                "iteration {iteration}: {}",
                response.text()
            );
        }
        let defaults: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM phone_numbers WHERE user_id = $1 AND default_second_factor",
        )
        .bind(&signed.user_id)
        .fetch_one(&harness.state().pool)
        .await
        .expect("defaults");
        assert_eq!(defaults, 1, "iteration {iteration}: exactly one default");
    }
    assert_eq!(deadlocks(harness.state()).await - before, 0);
}

/// A phone verification attempt (user, then verification, then phone row)
/// against deleting that phone (user, then phone row) takes the same order. The
/// two requests use two client sessions of the same user, so only the user row
/// serializes them. `valid_code` sends the real code instead of a wrong one.
async fn phone_attempt_vs_delete(valid_code: bool) {
    let harness = concurrent_harness().await;
    let before = deadlocks(harness.state()).await;
    for iteration in 0..12 {
        let signed = harness
            .signed_in(
                &format!("phone-attempt-{valid_code}-{iteration}@example.com"),
                "Sup3r-secret!",
            )
            .await;
        let other =
            orbitid_identity::testing::create_test_client_session(harness.state(), &signed.user_id)
                .await
                .expect("second session");
        let other_client = harness.client_with_cookie(&other.cookie);
        let number = format!("+155555502{iteration:02}");
        let created = signed
            .client
            .request(
                "POST",
                "/v1/client/me/phone_numbers",
                Some(json!({ "phone_number": number })),
                &[],
            )
            .await;
        assert_eq!(created.status, StatusCode::OK, "{}", created.text());
        let id = created.value()["response"]["id"]
            .as_str()
            .expect("phone id")
            .to_string();
        let prepared = signed
            .client
            .request(
                "POST",
                &format!("/v1/client/me/phone_numbers/{id}/prepare_verification"),
                Some(json!({})),
                &[],
            )
            .await;
        assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
        let code = if valid_code {
            let sms = orbitid_platform::mail::get_sms_outbox(harness.state())
                .into_iter()
                .rev()
                .find(|sms| sms.to == number)
                .expect("sms");
            sms.body
                .split_whitespace()
                .find(|word| word.len() >= 4 && word.chars().all(|ch| ch.is_ascii_digit()))
                .expect("code")
                .to_string()
        } else {
            "000000".to_string()
        };
        let attempt_path = format!("/v1/client/me/phone_numbers/{id}/attempt_verification");
        let phone_path = format!("/v1/client/me/phone_numbers/{id}");
        let (attempt, delete) = tokio::join!(
            signed
                .client
                .request("POST", &attempt_path, Some(json!({ "code": code })), &[]),
            other_client.delete(&phone_path, None, &[]),
        );
        for (label, response) in [("attempt", &attempt), ("delete", &delete)] {
            assert!(
                !response.status.is_server_error(),
                "iteration {iteration} {label}: {} {}",
                response.status,
                response.text()
            );
        }
    }
    assert_eq!(deadlocks(harness.state()).await - before, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn phone_verification_attempt_does_not_deadlock_with_phone_delete() {
    phone_attempt_vs_delete(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn valid_phone_verification_does_not_deadlock_with_phone_delete() {
    phone_attempt_vs_delete(true).await;
}
