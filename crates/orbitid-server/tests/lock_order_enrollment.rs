//! Verified-domain enrolment lock order: users (ascending, vanished users
//! skipped) → organization, one short transaction per chunk.
//!
//! The retry layer is off and each test asserts `pg_stat_database.deadlocks`
//! stays at zero. Sequencing is deterministic (direct SQL on held transactions
//! and a poll of `pg_stat_activity`), not timing based.

use std::time::Duration;

use orbitid_core::models::{OrganizationDomainRow, OrganizationRow};
use orbitid_core::AppState;
use orbitid_identity::orgs::{
    apply_domain_enrollment, apply_domain_enrollment_chunked, create_membership_request_on,
    domain_enrollment_user_ids_page_on, enroll_candidates_on,
};
use orbitid_identity::testing::{
    add_test_member, create_test_organization, create_test_user, test_app_state_with, TestApp,
};

const DOMAIN: &str = "enroll-order.test";

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("read the deadlock counter")
}

async fn app() -> TestApp {
    // Concurrency tests: a held transaction plus the code under test.
    test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await
}

async fn org_row(state: &AppState, id: &str) -> OrganizationRow {
    sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .expect("organization")
}

async fn automatic_domain(state: &AppState, org_id: &str) -> OrganizationDomainRow {
    let now = orbitid_core::http::now();
    sqlx::query_as::<_, OrganizationDomainRow>(
        "INSERT INTO organization_domains \
         (id, organization_id, name, enrollment_mode, verified, created_at, updated_at) \
         VALUES ($1,$2,$3,'manual_invitation',true,$4,$4) RETURNING *",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::DOMAIN,
    ))
    .bind(org_id)
    .bind(DOMAIN)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .expect("domain")
}

/// Creating a user on an automatic domain would enroll them straight away
/// (`on_user_email_verified`), so tests create users on a manual domain and
/// flip it to automatic only when the enrollment under test should run.
async fn set_mode(
    state: &AppState,
    domain: &OrganizationDomainRow,
    mode: &str,
) -> OrganizationDomainRow {
    sqlx::query_as::<_, OrganizationDomainRow>(
        "UPDATE organization_domains SET enrollment_mode = $1 WHERE id = $2 RETURNING *",
    )
    .bind(mode)
    .bind(&domain.id)
    .fetch_one(&state.pool)
    .await
    .expect("mode")
}

async fn member_ids(state: &AppState, org_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 ORDER BY user_id",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await
    .expect("members")
}

async fn domain_user(state: &AppState, name: &str) -> String {
    create_test_user(state, &format!("{name}@{DOMAIN}"), "Sup3r-secret!")
        .await
        .expect("user")
        .user
        .id
}

async fn pending_request(state: &AppState, org: &OrganizationRow, user_id: &str) {
    let mut tx = state.pool.begin().await.expect("begin");
    create_membership_request_on(&mut tx, state, org, user_id, "pending")
        .await
        .expect("membership request");
    tx.commit().await.expect("commit");
}

/// Waits until some backend of this database is blocked on a lock.
async fn wait_for_lock_waiter(state: &AppState) {
    for _ in 0..200 {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pg_stat_activity \
             WHERE datname = current_database() AND wait_event_type = 'Lock'",
        )
        .fetch_one(&state.pool)
        .await
        .expect("activity");
        if waiting > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no backend ever blocked on a lock");
}

/// A user who becomes eligible after the candidate read is not part of the
/// proof: the enrollment never key-shares them, so their deletion (which holds
/// the user and then waits for the organization this chunk holds) cannot form
/// a cycle, and they are not enrolled by this pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_user_who_becomes_eligible_between_the_reads_cannot_deadlock_with_their_deletion() {
    let app = app().await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "Order Org", None, &owner.user.id)
        .await
        .expect("org");
    let org = org_row(state, &org.id).await;
    let domain = automatic_domain(state, &org.id).await;
    let snapshot_user = domain_user(state, "snapshot").await;
    let domain = set_mode(state, &domain, "automatic_invitation").await;
    let before = deadlocks(state).await;

    let mut tx = state.pool.begin().await.expect("begin");
    let candidates = domain_enrollment_user_ids_page_on(&mut tx, &domain, "", 100)
        .await
        .expect("candidates");
    assert_eq!(candidates, vec![snapshot_user.clone()]);
    // The late user verifies a domain address after the candidate read.
    set_mode(state, &domain, "manual_invitation").await;
    let late = domain_user(state, "late").await;
    set_mode(state, &domain, "automatic_invitation").await;
    pending_request(state, &org, &late).await;

    let (added, full) = enroll_candidates_on(&mut tx, state, &domain, &candidates)
        .await
        .expect("enroll");
    assert_eq!((added, full), (1, false));
    // The late user's deletion locks the user, then waits for the organization
    // that this transaction holds.
    let deletion = {
        let state = state.clone();
        let late = late.clone();
        tokio::spawn(async move { orbitid_identity::users::delete_user(&state, &late).await })
    };
    wait_for_lock_waiter(state).await;
    tx.commit().await.expect("commit");
    deletion.await.expect("join").expect("delete the late user");

    // Compared as sets: the database's collation order is not Rust's.
    let mut members = member_ids(state, &org.id).await;
    members.sort();
    let mut expected = vec![owner.user.id.clone(), snapshot_user];
    expected.sort();
    assert_eq!(members, expected);
    assert_eq!(deadlocks(state).await - before, 0);
}

/// Members are plain candidates of the keyset walk (no membership anti-join in
/// the page query), so the enrollment key-shares them and waits for a deletion
/// that holds their row. It holds nothing else while it waits (the organization
/// comes after the user locks), so the deletion's following organization lock
/// cannot form a cycle; both finish and the newcomer is enrolled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enrollment_waiting_on_a_member_in_deletion_cannot_deadlock() {
    let app = app().await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner2@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "Order Org Two", None, &owner.user.id)
        .await
        .expect("org");
    let org = org_row(state, &org.id).await;
    let member = domain_user(state, "member").await;
    add_test_member(state, &org.id, &member, "org:member")
        .await
        .expect("member");
    let newcomer = domain_user(state, "newcomer").await;
    let domain = automatic_domain(state, &org.id).await;
    let domain = set_mode(state, &domain, "automatic_invitation").await;
    let before = deadlocks(state).await;

    // A deletion in flight: the member row is held FOR UPDATE.
    let mut deleter = state.pool.begin().await.expect("begin");
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(&member)
        .execute(&mut *deleter)
        .await
        .expect("hold the member");
    let enrollment = {
        let state = state.clone();
        let domain = domain.clone();
        tokio::spawn(async move { apply_domain_enrollment(&state, &domain, &[]).await })
    };
    wait_for_lock_waiter(state).await;
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&org.id)
        .execute(&mut *deleter)
        .await
        .expect("then the organization");
    deleter.commit().await.expect("commit");
    let added = tokio::time::timeout(Duration::from_secs(10), enrollment)
        .await
        .expect("enrollment finishes once the deletion commits")
        .expect("join")
        .expect("enrollment");
    assert_eq!(added, 1);

    assert!(member_ids(state, &org.id).await.contains(&newcomer));
    assert_eq!(deadlocks(state).await - before, 0);
}

/// A snapshot user that no longer exists is skipped; the rest are enrolled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_deleted_snapshot_user_does_not_fail_the_enrollment() {
    let app = app().await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner3@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "Order Org Three", None, &owner.user.id)
        .await
        .expect("org");
    let domain = automatic_domain(state, &org.id).await;
    let gone = domain_user(state, "gone").await;
    let kept = domain_user(state, "kept").await;
    let domain = set_mode(state, &domain, "automatic_invitation").await;
    orbitid_identity::users::delete_user(state, &gone)
        .await
        .expect("delete");

    let added = apply_domain_enrollment(state, &domain, &[gone.clone(), "usr_ghost".into()])
        .await
        .expect("enrollment survives vanished users");
    assert_eq!(added, 1);
    let members = member_ids(state, &org.id).await;
    assert!(members.contains(&kept) && !members.contains(&gone));
}

/// Eligibility is revalidated under the locks: an address that stopped being
/// verified after the snapshot is not enrolled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eligibility_is_revalidated_under_the_locks() {
    let app = app().await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner4@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "Order Org Four", None, &owner.user.id)
        .await
        .expect("org");
    let domain = automatic_domain(state, &org.id).await;
    let stale = domain_user(state, "stale").await;
    let fresh = domain_user(state, "fresh").await;
    let domain = set_mode(state, &domain, "automatic_invitation").await;
    sqlx::query("UPDATE email_addresses SET verified = false WHERE user_id = $1")
        .bind(&stale)
        .execute(&state.pool)
        .await
        .expect("unverify");

    let mut tx = state.pool.begin().await.expect("begin");
    let (added, _) = enroll_candidates_on(&mut tx, state, &domain, &[stale.clone(), fresh.clone()])
        .await
        .expect("enroll");
    tx.commit().await.expect("commit");
    assert_eq!(added, 1);
    let members = member_ids(state, &org.id).await;
    assert!(members.contains(&fresh) && !members.contains(&stale));
}

/// Large domains enroll chunk by chunk and still reach everyone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_domain_is_enrolled_in_chunks() {
    let app = app().await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner5@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, "Order Org Five", None, &owner.user.id)
        .await
        .expect("org");
    let domain = automatic_domain(state, &org.id).await;
    let mut users = Vec::new();
    for index in 0..5 {
        users.push(domain_user(state, &format!("chunk{index}")).await);
    }
    let domain = set_mode(state, &domain, "automatic_invitation").await;
    let added = apply_domain_enrollment_chunked(state, &domain, &[], 2)
        .await
        .expect("enroll");
    assert_eq!(added, 5);
    let members = member_ids(state, &org.id).await;
    for user in &users {
        assert!(members.contains(user));
    }
    // A second pass finds nothing left to do.
    assert_eq!(
        apply_domain_enrollment_chunked(state, &domain, &[], 2)
            .await
            .expect("again"),
        0
    );
}

/// The domain lookup is served by `email_addresses_verified_domain_idx`, not a
/// sequential scan (a tiny test table needs `enable_seqscan = off` to show the
/// planner *can* use it).
#[tokio::test]
async fn the_domain_lookup_uses_the_expression_index() {
    let app = test_app_state_with(Default::default()).await;
    let state = app.state();
    let mut tx = state.pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("setting");
    let plan: Vec<String> = sqlx::query_scalar(
        "EXPLAIN SELECT DISTINCT user_id FROM email_addresses \
         WHERE verified = true AND user_id IS NOT NULL \
           AND lower(split_part(email, '@', 2)) = 'acme.test' AND user_id > '' \
         ORDER BY user_id LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await
    .expect("explain");
    let plan = plan.join("\n");
    assert!(
        plan.contains("email_addresses_verified_domain_idx"),
        "the domain lookup must use the index:\n{plan}"
    );
    assert!(!plan.contains("Seq Scan"), "{plan}");
}

/// The membership write proof must cover *both* the organization and the user
/// it is used for: a proof taken for another organization is refused.
#[tokio::test]
async fn a_membership_write_requires_a_proof_for_that_organization() {
    let app = test_app_state_with(Default::default()).await;
    let state = app.state();
    let owner = create_test_user(state, "order-owner6@example.com", "Sup3r-secret!")
        .await
        .expect("owner");
    let first = create_test_organization(state, "Proof One", None, &owner.user.id)
        .await
        .expect("first");
    let second = create_test_organization(state, "Proof Two", None, &owner.user.id)
        .await
        .expect("second");
    let member = create_test_user(state, "order-member6@example.com", "Sup3r-secret!")
        .await
        .expect("member");
    let mut tx = state.pool.begin().await.expect("begin");
    let lock = orbitid_identity::locks::lock_membership_write_on(
        &mut tx,
        std::slice::from_ref(&member.user.id),
        std::slice::from_ref(&first.id),
    )
    .await
    .expect("lock");
    let refused = orbitid_identity::orgs::add_membership_on(
        &mut tx,
        state,
        &lock,
        &second.id,
        &member.user.id,
        "org:member",
        None,
        None,
    )
    .await;
    assert!(
        refused.is_err(),
        "a proof for another organization is refused"
    );
}
