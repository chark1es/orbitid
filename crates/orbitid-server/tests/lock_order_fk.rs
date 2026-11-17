//! Foreign-key lock-order proofs and capacity/update races.
//!
//! An INSERT of a child row takes a key-share lock on every referenced parent
//! row. Accepting a membership request, accepting an invitation, a Backend API
//! membership create and verified-domain enrolment all insert a membership that
//! references `users` (rank 3) and `organizations` (rank 8). User deletion holds
//! the user and then the organization, so every path must take the user
//! key-share before the organization. The retry layer is off and each test
//! asserts `pg_stat_database.deadlocks` stays at zero.

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::models::{OrganizationDomainRow, OrganizationRow};
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_core::AppState;
use orbitid_identity::orgs::{
    accept_invitation, accept_membership_request_on, apply_domain_enrollment,
    create_membership_request_on, create_organization_invitation, CreateInvitationInput,
};
use orbitid_identity::testing::{
    create_test_organization, create_test_user, test_app_state_with, TestApp,
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

fn assert_not_conflict(label: &str, response: &TestResponse) {
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

async fn org_row(state: &AppState, organization_id: &str) -> OrganizationRow {
    sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(organization_id)
        .fetch_one(&state.pool)
        .await
        .expect("organization")
}

async fn pending_request(state: &AppState, org: &OrganizationRow, user_id: &str) {
    let mut tx = state.pool.begin().await.expect("begin");
    create_membership_request_on(&mut tx, state, org, user_id, "pending")
        .await
        .expect("membership request");
    tx.commit().await.expect("commit");
}

async fn automatic_domain(state: &AppState, org_id: &str, name: &str) -> OrganizationDomainRow {
    let now = orbitid_core::http::now();
    sqlx::query_as::<_, OrganizationDomainRow>(
        "INSERT INTO organization_domains \
         (id, organization_id, name, enrollment_mode, verified, created_at, updated_at) \
         VALUES ($1,$2,$3,'automatic_invitation',true,$4,$4) RETURNING *",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::DOMAIN,
    ))
    .bind(org_id)
    .bind(name)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .expect("domain")
}

async fn set_capacity(state: &AppState, org_id: &str, capacity: i64) {
    sqlx::query("UPDATE organizations SET max_allowed_memberships = $1 WHERE id = $2")
        .bind(capacity)
        .bind(org_id)
        .execute(&state.pool)
        .await
        .expect("set capacity");
}

/// Accepting a membership request (the FAPI handler's helper) holds the user
/// key-share before the organization, so it serialises with user deletion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_accepting_a_request() {
    // Concurrency test: simultaneous deletions/accepts need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-request-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("FK Request {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let victim = create_test_user(
            state,
            &format!("fk-requester-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("victim");
        let org = org_row(state, &org.id).await;
        pending_request(state, &org, &victim.user.id).await;
        let request = sqlx::query_as::<_, orbitid_core::models::OrganizationMembershipRequestRow>(
            "SELECT * FROM organization_membership_requests \
             WHERE organization_id = $1 AND user_id = $2 AND status = 'pending'",
        )
        .bind(&org.id)
        .bind(&victim.user.id)
        .fetch_one(&state.pool)
        .await
        .expect("request");

        let accept = async {
            let mut tx = state.pool.begin().await.expect("begin");
            let result = accept_membership_request_on(&mut tx, state, &org, &request.id).await;
            match result {
                Ok(membership) => {
                    tx.commit().await.expect("commit");
                    Ok(membership)
                }
                Err(error) => {
                    tx.rollback().await.ok();
                    Err(error)
                }
            }
        };
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (delete, accept) = tokio::join!(delete, accept);
        delete.expect("delete user");
        // The accept may lose the race (the user is gone); a deadlock is what
        // this test forbids.
        let _ = accept;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs membership request acceptance"
    );
}

/// The same request acceptance through the Backend API route.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_bapi_request_acceptance() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-bapi-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let backend = TestClient::new(router(state));
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("FK BAPI Request {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let victim = create_test_user(
            state,
            &format!("fk-bapi-requester-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("victim");
        let org = org_row(state, &org.id).await;
        pending_request(state, &org, &victim.user.id).await;
        let request_id: String = sqlx::query_scalar(
            "SELECT id FROM organization_membership_requests \
             WHERE organization_id = $1 AND user_id = $2 AND status = 'pending'",
        )
        .bind(&org.id)
        .bind(&victim.user.id)
        .fetch_one(&state.pool)
        .await
        .expect("request");

        let accept_path = format!(
            "/v1/organizations/{}/membership_requests/{}/accept",
            org.id, request_id
        );
        let accept = backend.post(&accept_path, None, bearer());
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (accept, delete) = tokio::join!(accept, delete);
        delete.expect("delete user");
        let _ = accept;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs Backend API request acceptance"
    );
}

/// Accepting an invitation holds the user key-share before the organization.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_accepting_an_invitation() {
    // Concurrency test: simultaneous deletions/accepts need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-invite-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("FK Invite {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let email = format!("fk-invitee-{iteration}@example.com");
        let victim = create_test_user(state, &email, "Sup3r-secret!")
            .await
            .expect("victim");
        let org = org_row(state, &org.id).await;
        // A pending request makes user deletion lock this organization too,
        // which is what made the old organization-first invitation acceptance
        // deadlock against it.
        pending_request(state, &org, &victim.user.id).await;
        let (invitation, _ticket) = create_organization_invitation(
            state,
            &org,
            &CreateInvitationInput {
                email,
                role_key: Some("org:member".into()),
                inviter_user_id: Some(owner.user.id.clone()),
                redirect_url: None,
                public_metadata: None,
                private_metadata: None,
                expires_at: None,
            },
        )
        .await
        .expect("invitation");

        let accept = accept_invitation(state, &invitation, &victim.user.id);
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (delete, accept) = tokio::join!(delete, accept);
        delete.expect("delete user");
        let _ = accept;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs invitation acceptance"
    );
}

/// The Backend API membership create locks the user key-share then the
/// organization, exactly like user deletion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_bapi_membership_create() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-member-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let backend = TestClient::new(router(state));
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("FK Member {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let victim = create_test_user(
            state,
            &format!("fk-new-member-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("victim");
        let org = org_row(state, &org.id).await;
        pending_request(state, &org, &victim.user.id).await;

        let path = format!("/v1/organizations/{}/memberships", org.id);
        let create = backend.post(&path, Some(json!({ "user_id": victim.user.id })), bearer());
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (create, delete) = tokio::join!(create, delete);
        delete.expect("delete user");
        assert_not_conflict("membership create", &create);
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs Backend API membership create"
    );
}

/// Verified-domain enrolment also inserts memberships; it must take the users
/// before the organization.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_domain_enrollment() {
    // Concurrency test: simultaneous deletion/enrolment need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-enroll-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let domain_name = "fk-enroll.test";
    let before = deadlocks(state).await;

    for iteration in 0..20 {
        let org = create_test_organization(
            state,
            &format!("FK Enroll {iteration}"),
            None,
            &owner.user.id,
        )
        .await
        .expect("organization");
        let victim = create_test_user(
            state,
            &format!("fk-enrollee-{iteration}@{domain_name}"),
            "Sup3r-secret!",
        )
        .await
        .expect("victim");
        let org = org_row(state, &org.id).await;
        pending_request(state, &org, &victim.user.id).await;
        let domain = automatic_domain(state, &org.id, domain_name).await;

        let extra = vec![victim.user.id.clone()];
        let enroll = apply_domain_enrollment(state, &domain, &extra);
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (enroll, delete) = tokio::join!(enroll, delete);
        delete.expect("delete user");
        let _ = enroll;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs verified-domain enrolment"
    );
}

/// Two concurrent Backend API membership creates at `capacity - 1` must not
/// both insert: the organization row lock serialises the capacity check.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_membership_creates_do_not_exceed_capacity() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-capacity-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let first = create_test_user(state, "fk-capacity-one@example.com", "Sup3r-secret!")
        .await
        .expect("first");
    let second = create_test_user(state, "fk-capacity-two@example.com", "Sup3r-secret!")
        .await
        .expect("second");
    let org = create_test_organization(state, "FK Capacity", None, &owner.user.id)
        .await
        .expect("organization");
    set_capacity(state, &org.id, 2).await;
    let backend = TestClient::new(router(state));
    let path = format!("/v1/organizations/{}/memberships", org.id);
    let (one, two) = tokio::join!(
        backend.post(&path, Some(json!({ "user_id": first.user.id })), bearer()),
        backend.post(&path, Some(json!({ "user_id": second.user.id })), bearer()),
    );
    let successes = [&one, &two]
        .iter()
        .filter(|response| response.status.is_success())
        .count();
    assert_eq!(successes, 1, "exactly one create may use the last slot");
    let rejected = if one.status.is_success() { &two } else { &one };
    assert_eq!(
        rejected.status,
        StatusCode::FORBIDDEN,
        "{}",
        rejected.text()
    );
    assert_eq!(
        rejected.error_codes(),
        vec!["organization_membership_quota_exceeded"]
    );
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_one(&state.pool)
    .await
    .expect("members");
    assert_eq!(members, 2);
}

/// Rotating a refresh token inserts `oauth_grants` rows that reference the user
/// (rank 3); the family advisory lock is rank 11. Taking the user key-share
/// first keeps it from cycling with user deletion (user → family revocation).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_delete_does_not_deadlock_with_refresh_rotation() {
    // Concurrency test: simultaneous rotation/deletion need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let (application, _secret) = orbitid_oidc::services::oidc::create_application(
        state,
        orbitid_oidc::services::oidc::CreateApplicationInput {
            name: "FK Refresh".into(),
            ..Default::default()
        },
    )
    .await
    .expect("application");
    let before = deadlocks(state).await;

    for iteration in 0..12 {
        let victim = create_test_user(
            state,
            &format!("fk-refresh-{iteration}@example.com"),
            "Sup3r-secret!",
        )
        .await
        .expect("victim");
        let token = format!("ort_{}", orbitid_core::crypto::random_token(24));
        let family = format!(
            "fk-family-{iteration}-{}",
            orbitid_core::crypto::random_token(4)
        );
        let now_ms = orbitid_core::http::now();
        sqlx::query(
            "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
             family_id, revoked, expires_at, created_at) \
             VALUES ($1,'refresh',$2,$3,$4,'openid offline_access',$5,false,$6,$7)",
        )
        .bind(orbitid_core::ids::new_id(
            orbitid_core::ids::id_prefix::OAUTH_GRANT,
        ))
        .bind(&application.id)
        .bind(&victim.user.id)
        .bind(orbitid_core::crypto::sha256(&token))
        .bind(&family)
        .bind(now_ms + 3_600_000)
        .bind(now_ms)
        .execute(&state.pool)
        .await
        .expect("refresh grant");

        let exchange = orbitid_oidc::services::oidc::exchange_refresh_token(
            state,
            &application,
            &token,
            orbitid_oidc::services::oidc::RefreshExchangeOptions::default(),
        );
        let delete = orbitid_identity::users::delete_user(state, &victim.user.id);
        let (exchange, delete) = tokio::join!(exchange, delete);
        delete.expect("delete user");
        let _ = exchange;
    }

    assert_eq!(
        deadlocks(state).await - before,
        0,
        "user delete vs refresh-token rotation"
    );
}

/// Two concurrent enrolment calls at `capacity - 1` must add exactly one
/// member: both lock the same users then the organization in rank order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_domain_enrollment_does_not_exceed_capacity() {
    // Concurrency test: simultaneous worker transactions need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-enroll-cap-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let domain_name = "fk-enroll-cap.test";
    let first = create_test_user(
        state,
        &format!("fk-enroll-first@{domain_name}"),
        "Sup3r-secret!",
    )
    .await
    .expect("first");
    let second = create_test_user(
        state,
        &format!("fk-enroll-second@{domain_name}"),
        "Sup3r-secret!",
    )
    .await
    .expect("second");
    let org = create_test_organization(state, "FK Enroll Capacity", None, &owner.user.id)
        .await
        .expect("organization");
    set_capacity(state, &org.id, 2).await;
    let domain = automatic_domain(state, &org.id, domain_name).await;

    let (one, two) = tokio::join!(
        apply_domain_enrollment(state, &domain, &[]),
        apply_domain_enrollment(state, &domain, &[]),
    );
    one.expect("first enrolment");
    two.expect("second enrolment");
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org.id)
    .fetch_all(&state.pool)
    .await
    .expect("members");
    assert_eq!(members.len(), 2, "capacity must not be exceeded");
    assert!(members.contains(&first.user.id) || members.contains(&second.user.id));
}

/// Two PATCHes with different metadata keys must both survive: the merge uses
/// the row read under the organization lock.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_organization_metadata_patches_keep_both_keys() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-meta-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "FK Metadata", None, &owner.user.id)
        .await
        .expect("organization");
    let backend = TestClient::new(router(state));
    let path = format!("/v1/organizations/{}", org.id);
    let (one, two) = tokio::join!(
        backend.patch(
            &path,
            Some(json!({ "public_metadata": { "first": "1" } })),
            bearer()
        ),
        backend.patch(
            &path,
            Some(json!({ "public_metadata": { "second": "2" } })),
            bearer()
        ),
    );
    assert_eq!(one.status, StatusCode::OK, "{}", one.text());
    assert_eq!(two.status, StatusCode::OK, "{}", two.text());
    let stored: sqlx::types::Json<serde_json::Value> =
        sqlx::query_scalar("SELECT public_metadata FROM organizations WHERE id = $1")
            .bind(&org.id)
            .fetch_one(&state.pool)
            .await
            .expect("metadata");
    let stored = stored.0;
    assert_eq!(stored["first"], json!("1"), "first patch lost: {stored}");
    assert_eq!(stored["second"], json!("2"), "second patch lost: {stored}");
}

/// The slug pre-check can race two different organizations; the loser must get
/// the same `organization_slug_taken` error the TypeScript server returns.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_slug_updates_return_the_slug_taken_error() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-slug-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let first = create_test_organization(state, "FK Slug One", None, &owner.user.id)
        .await
        .expect("first organization");
    let second = create_test_organization(state, "FK Slug Two", None, &owner.user.id)
        .await
        .expect("second organization");
    let backend = TestClient::new(router(state));
    let one_path = format!("/v1/organizations/{}", first.id);
    let two_path = format!("/v1/organizations/{}", second.id);
    let body = json!({ "slug": "fk-shared-slug" });
    let (one, two) = tokio::join!(
        backend.patch(&one_path, Some(body.clone()), bearer()),
        backend.patch(&two_path, Some(body), bearer()),
    );
    let successes = [&one, &two]
        .iter()
        .filter(|response| response.status.is_success())
        .count();
    assert_eq!(successes, 1, "exactly one slug write may win");
    let rejected = if one.status.is_success() { &two } else { &one };
    assert_eq!(rejected.status, StatusCode::CONFLICT, "{}", rejected.text());
    assert_eq!(rejected.error_codes(), vec!["organization_slug_taken"]);
}

/// Domain creation has no unique index on `(organization_id, name)`, so the
/// duplicate pre-check races. Both creates must hold the organization row
/// (rank 8) before the check and insert: exactly one wins and the loser gets
/// the ordinary duplicate error instead of a second row.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_domain_creates_store_one_row() {
    // Concurrency test: simultaneous HTTP requests need several connections.
    let app: TestApp = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let owner = create_test_user(state, "fk-domain-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "FK Domain", None, &owner.user.id)
        .await
        .expect("organization");
    let backend = TestClient::new(router(state));
    let path = format!("/v1/organizations/{}/domains", org.id);
    let body = json!({ "name": "fk-race.example.com" });
    let (one, two) = tokio::join!(
        backend.post(&path, Some(body.clone()), bearer()),
        backend.post(&path, Some(body), bearer()),
    );
    let successes = [&one, &two]
        .iter()
        .filter(|response| response.status.is_success())
        .count();
    assert_eq!(successes, 1, "exactly one domain create may win");
    let rejected = if one.status.is_success() { &two } else { &one };
    assert_eq!(rejected.status, StatusCode::CONFLICT, "{}", rejected.text());
    assert_eq!(rejected.error_codes(), vec!["duplicate_record"]);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_domains WHERE organization_id = $1 AND name = $2",
    )
    .bind(&org.id)
    .bind("fk-race.example.com")
    .fetch_one(&state.pool)
    .await
    .expect("domain count");
    assert_eq!(count, 1, "the race must not store two domains");
}
