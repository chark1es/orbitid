//! Durable domain enrollment: marker written with the domain change, worker
//! resumes from the saved cursor, replicas do not double-process, capacity holds.

use std::time::Duration;

use orbitid_core::models::OrganizationDomainRow;
use orbitid_core::AppState;
use orbitid_identity::orgs::{kick_domain_enrollment, run_enrollment_tick};
use orbitid_identity::testing::{
    create_test_organization, create_test_user, test_app_state_with, TestApp,
};

const DOMAIN: &str = "worker-enroll.test";
const LONG: Duration = Duration::from_secs(60);

async fn app() -> TestApp {
    test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await
}

/// An org with a manual verified domain and `count` users on it; returns the
/// org id, domain, and the users' ids sorted ascending.
async fn setup(
    state: &AppState,
    tag: &str,
    count: usize,
) -> (String, OrganizationDomainRow, Vec<String>) {
    setup_named(state, tag, count, DOMAIN).await
}

async fn setup_named(
    state: &AppState,
    tag: &str,
    count: usize,
    domain_name: &str,
) -> (String, OrganizationDomainRow, Vec<String>) {
    let owner = create_test_user(state, &format!("owner-{tag}@example.com"), "Sup3r-secret!")
        .await
        .expect("owner");
    let org = create_test_organization(state, &format!("Org {tag}"), None, &owner.user.id)
        .await
        .expect("org");
    let now = orbitid_core::http::now();
    let domain = sqlx::query_as::<_, OrganizationDomainRow>(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,$3,'manual_invitation',true,$4,$4) RETURNING *",
    )
    .bind(orbitid_core::ids::new_id(
        orbitid_core::ids::id_prefix::DOMAIN,
    ))
    .bind(&org.id)
    .bind(domain_name)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .expect("domain");
    let mut users = Vec::new();
    for index in 0..count {
        let user = create_test_user(
            state,
            &format!("u{index}-{tag}@{domain_name}"),
            "Sup3r-secret!",
        )
        .await
        .expect("user");
        users.push(user.user.id);
    }
    // The database's collation order is the cursor order, not Rust's byte order.
    let users: Vec<String> =
        sqlx::query_scalar("SELECT id FROM unnest($1::text[]) AS id ORDER BY id")
            .bind(&users)
            .fetch_all(&state.pool)
            .await
            .expect("sorted");
    (org.id, domain, users)
}

/// The real mode change (what the handlers run): sets the durable marker.
async fn activate(state: &AppState, domain: &OrganizationDomainRow) -> OrganizationDomainRow {
    let mut tx = state.pool.begin().await.expect("begin");
    orbitid_identity::locks::lock_organization_on(&mut tx, &domain.organization_id)
        .await
        .expect("lock");
    let updated = orbitid_identity::org_domains::set_domain_enrollment_mode_on(
        &mut tx,
        state,
        domain,
        "automatic_invitation",
        false,
    )
    .await
    .expect("mode");
    tx.commit().await.expect("commit");
    updated
}

async fn marker(state: &AppState, domain_id: &str) -> (Option<i64>, String) {
    sqlx::query_as(
        "SELECT enrollment_pending_since, enrollment_cursor FROM organization_domains WHERE id = $1",
    )
    .bind(domain_id)
    .fetch_one(&state.pool)
    .await
    .expect("marker")
}

async fn enrolled(state: &AppState, org_id: &str, users: &[String]) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 \
         AND user_id = ANY($2) ORDER BY user_id",
    )
    .bind(org_id)
    .bind(users)
    .fetch_all(&state.pool)
    .await
    .expect("members")
}

async fn fail_inserts_for(state: &AppState, user_id: &str) {
    sqlx::query(&format!(
        "CREATE OR REPLACE FUNCTION fail_member() RETURNS trigger AS $$ BEGIN \
         IF NEW.user_id = '{user_id}' THEN RAISE EXCEPTION 'injected failure'; END IF; \
         RETURN NEW; END $$ LANGUAGE plpgsql"
    ))
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER fail_member BEFORE INSERT ON organization_memberships \
         FOR EACH ROW EXECUTE FUNCTION fail_member()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
}

async fn deadlocks(state: &AppState) -> i64 {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlocks")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_persistently_failing_user_is_skipped_and_the_pass_completes() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup(state, "fail", 5).await;
    let updated = activate(state, &domain).await;
    let failing = users[1].clone();
    fail_inserts_for(state, &failing).await; // stays in place for the whole test

    // Request path: the inline chunk skips the user, enrolls the rest.
    kick_domain_enrollment(state, &updated).await;
    assert_eq!(enrolled(state, &org, &users).await.len(), 4);
    assert!(!enrolled(state, &org, &users).await.contains(&failing));
    assert_eq!(marker(state, &domain.id).await, (None, String::new()));

    // Worker, chunks of 2: re-arm the marker and run again with the trigger on.
    sqlx::query(
        "DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = ANY($2)",
    )
    .bind(&org)
    .bind(&users)
    .execute(&state.pool)
    .await
    .expect("reset");
    sqlx::query("UPDATE organization_domains SET enrollment_pending_since = 1 WHERE id = $1")
        .bind(&domain.id)
        .execute(&state.pool)
        .await
        .expect("rearm");
    let tick = run_enrollment_tick(state, LONG, 2).await.expect("tick");
    assert_eq!(
        (
            tick.chunks,
            tick.enrolled,
            tick.skipped,
            tick.completed,
            tick.failed
        ),
        (3, 4, 1, 1, 0)
    );
    let members = enrolled(state, &org, &users).await;
    assert_eq!(members.len(), 4);
    assert!(!members.contains(&failing));
    assert_eq!(marker(state, &domain.id).await, (None, String::new()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failing_domain_cannot_starve_a_healthy_one_with_a_zero_budget() {
    let app = app().await;
    let state = app.state();
    let (org_a, domain_a, users_a) = setup_named(state, "starve-a", 2, "starve-a.test").await;
    let (org_b, domain_b, users_b) = setup_named(state, "starve-b", 3, "starve-b.test").await;
    activate(state, &domain_a).await;
    activate(state, &domain_b).await;
    // A is older, so it always sorts first.
    for (id, since) in [(&domain_a.id, 1000_i64), (&domain_b.id, 2000)] {
        sqlx::query("UPDATE organization_domains SET enrollment_pending_since = $1 WHERE id = $2")
            .bind(since)
            .bind(id)
            .execute(&state.pool)
            .await
            .expect("since");
    }
    // The cursor write of A fails outside the per-user savepoint: a permanent chunk failure.
    sqlx::query(&format!(
        "CREATE FUNCTION fail_domain() RETURNS trigger AS $$ BEGIN \
         IF NEW.id = '{}' THEN RAISE EXCEPTION 'injected domain failure'; END IF; \
         RETURN NEW; END $$ LANGUAGE plpgsql",
        domain_a.id
    ))
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER fail_domain BEFORE UPDATE ON organization_domains \
         FOR EACH ROW EXECUTE FUNCTION fail_domain()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");

    let first = run_enrollment_tick(state, Duration::ZERO, 10)
        .await
        .expect("tick");
    assert_eq!(first.failed, 1, "the older domain is attempted and fails");
    let second = run_enrollment_tick(state, Duration::ZERO, 10)
        .await
        .expect("tick");
    assert_eq!((second.enrolled, second.completed), (3, 1));
    assert_eq!(enrolled(state, &org_b, &users_b).await, users_b);
    assert_eq!(marker(state, &domain_b.id).await, (None, String::new()));
    assert!(
        marker(state, &domain_a.id).await.0.is_some(),
        "A stays pending"
    );
    assert!(enrolled(state, &org_a, &users_a).await.is_empty());

    // The failing domain is retried later, and finishes once healthy.
    sqlx::query("DROP TRIGGER fail_domain ON organization_domains")
        .execute(&state.pool)
        .await
        .expect("drop");
    run_enrollment_tick(state, Duration::ZERO, 10)
        .await
        .expect("tick");
    assert_eq!(enrolled(state, &org_a, &users_a).await, users_a);
    assert_eq!(marker(state, &domain_a.id).await, (None, String::new()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_worker_resumes_from_the_saved_cursor() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup(state, "resume", 5).await;
    activate(state, &domain).await;
    // A zero budget runs exactly one chunk, as if the process died after it.
    let tick = run_enrollment_tick(state, Duration::ZERO, 2)
        .await
        .expect("tick");
    assert_eq!((tick.chunks, tick.enrolled, tick.completed), (1, 2, 0));
    assert_eq!(marker(state, &domain.id).await.1, users[1]);
    // "Restart": a fresh tick call knows nothing but the database.
    let tick = run_enrollment_tick(state, Duration::ZERO, 2)
        .await
        .expect("tick");
    assert_eq!(tick.enrolled, 2);
    assert_eq!(marker(state, &domain.id).await.1, users[3]);
    let tick = run_enrollment_tick(state, Duration::ZERO, 2)
        .await
        .expect("tick");
    assert_eq!((tick.enrolled, tick.completed), (1, 1));
    assert_eq!(enrolled(state, &org, &users).await, users);
    assert_eq!(marker(state, &domain.id).await, (None, String::new()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_replicas_ticking_together_do_not_double_process_or_deadlock() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup(state, "twins", 9).await;
    activate(state, &domain).await;
    let before = deadlocks(state).await;
    let (a, b) = tokio::join!(
        run_enrollment_tick(state, LONG, 2),
        run_enrollment_tick(state, LONG, 2)
    );
    let (a, b) = (a.expect("a"), b.expect("b"));
    assert_eq!(
        a.enrolled + b.enrolled,
        9,
        "each user is enrolled exactly once"
    );
    assert_eq!(enrolled(state, &org, &users).await, users);
    let rows: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(DISTINCT user_id) FROM organization_memberships \
         WHERE organization_id = $1 AND user_id = ANY($2)",
    )
    .bind(&org)
    .bind(&users)
    .fetch_one(&state.pool)
    .await
    .expect("count");
    assert_eq!(rows, (9, 9));
    assert_eq!(deadlocks(state).await, before);
    assert_eq!(marker(state, &domain.id).await.0, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capacity_is_enforced_across_chunks() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup(state, "cap", 6).await;
    // The owner is a member already: room for exactly three more.
    sqlx::query("UPDATE organizations SET max_allowed_memberships = 4 WHERE id = $1")
        .bind(&org)
        .execute(&state.pool)
        .await
        .expect("cap");
    activate(state, &domain).await;
    let tick = run_enrollment_tick(state, LONG, 2).await.expect("tick");
    assert_eq!((tick.completed, tick.failed), (1, 0));
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org)
    .fetch_one(&state.pool)
    .await
    .expect("count");
    assert_eq!(total, 4);
    assert_eq!(enrolled(state, &org, &users).await.len(), 3);
    assert_eq!(
        marker(state, &domain.id).await.0,
        None,
        "a full organization ends the pass"
    );
    let again = run_enrollment_tick(state, LONG, 2).await.expect("tick");
    assert_eq!(again, Default::default(), "nothing is retried afterwards");
}

#[tokio::test]
async fn the_page_query_is_a_plain_index_keyset_walk() {
    let app = test_app_state_with(Default::default()).await;
    let state = app.state();
    let mut tx = state.pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("setting");
    let plan: Vec<String> = sqlx::query_scalar(&format!(
        "EXPLAIN {}",
        orbitid_identity::orgs::enrollment::DOMAIN_PAGE_SQL
            .replace("$1", "'acme.test'")
            .replace("$2", "''")
            .replace("$3", "200")
    ))
    .fetch_all(&mut *tx)
    .await
    .expect("explain");
    let plan = plan.join("\n");
    assert!(
        plan.contains("email_addresses_verified_domain_idx"),
        "{plan}"
    );
    assert!(
        !plan.contains("Anti Join") && !plan.contains("Hash"),
        "{plan}"
    );
    assert!(
        !orbitid_identity::orgs::enrollment::DOMAIN_PAGE_SQL.contains("organization_memberships"),
        "no membership anti-join in the page query"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_membership_writes_cannot_push_a_capped_org_over_during_enrollment() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup(state, "capc", 8).await;
    let extra = create_test_user(state, "extra-capc@elsewhere.test", "Sup3r-secret!")
        .await
        .expect("extra");
    let mut others = vec![extra.user.id.clone()];
    for index in 0..3 {
        let user = create_test_user(
            state,
            &format!("other{index}-capc@elsewhere.test"),
            "Sup3r-secret!",
        )
        .await
        .expect("other");
        others.push(user.user.id);
    }
    // Owner is a member: room for exactly five more.
    sqlx::query("UPDATE organizations SET max_allowed_memberships = 6 WHERE id = $1")
        .bind(&org)
        .execute(&state.pool)
        .await
        .expect("cap");
    activate(state, &domain).await;
    let writers: Vec<_> = others
        .iter()
        .map(|user| {
            let state = state.clone();
            let (org, user) = (org.clone(), user.clone());
            tokio::spawn(async move {
                orbitid_identity::orgs::add_membership(
                    &state,
                    &org,
                    &user,
                    "org:member",
                    None,
                    None,
                )
                .await
            })
        })
        .collect();
    let tick = run_enrollment_tick(state, LONG, 2).await;
    for writer in writers {
        let _ = writer.await.expect("writer task");
    }
    tick.expect("tick");
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org)
    .fetch_one(&state.pool)
    .await
    .expect("count");
    assert_eq!(total, 6, "the cap is exact, never exceeded");
    assert!(enrolled(state, &org, &users).await.len() <= 5);
}

#[tokio::test]
async fn the_capacity_count_is_bounded_by_the_cap_not_the_member_count() {
    let app = test_app_state_with(Default::default()).await;
    let state = app.state();
    let sql = orbitid_identity::orgs::enrollment::BOUNDED_MEMBER_COUNT;
    assert!(sql.contains("LIMIT $2"), "{sql}");
    let mut tx = state.pool.begin().await.expect("begin");
    sqlx::query("SET LOCAL enable_seqscan = off")
        .execute(&mut *tx)
        .await
        .expect("setting");
    let plan: Vec<String> = sqlx::query_scalar(&format!(
        "EXPLAIN {}",
        sql.replace("$1", "'org_x'").replace("$2", "10")
    ))
    .fetch_all(&mut *tx)
    .await
    .expect("explain");
    let plan = plan.join("\n");
    assert!(plan.contains("Limit"), "{plan}");
    assert!(plan.contains("om_org_user"), "served by the index: {plan}");
}

/// A failing webhook outbox insert (a row-level-looking `P0001`) is not a
/// per-user skip: the membership insert succeeded, so skipping would roll it
/// back and still clear the marker. The chunk fails and the marker stays.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_outbox_failure_fails_the_chunk_instead_of_skipping_the_user() {
    let app = app().await;
    let state = app.state();
    let (org, domain, users) = setup_named(state, "outbox", 2, "outbox-enroll.test").await;
    activate(state, &domain).await;
    sqlx::query(
        "CREATE FUNCTION fail_outbox() RETURNS trigger AS $$ BEGIN \
         RAISE EXCEPTION 'injected outbox failure'; END $$ LANGUAGE plpgsql",
    )
    .execute(&state.pool)
    .await
    .expect("function");
    sqlx::query(
        "CREATE TRIGGER fail_outbox BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION fail_outbox()",
    )
    .execute(&state.pool)
    .await
    .expect("trigger");
    sqlx::query("UPDATE organization_domains SET enrollment_pending_since = 1 WHERE id = $1")
        .bind(&domain.id)
        .execute(&state.pool)
        .await
        .expect("arm");

    let failed = run_enrollment_tick(state, LONG, 10).await.expect("tick");
    assert_eq!((failed.completed, failed.skipped, failed.failed), (0, 0, 1));
    assert!(marker(state, &domain.id).await.0.is_some(), "stays pending");
    assert!(enrolled(state, &org, &users).await.is_empty());

    // The failure is counted on the marker row and the domain backs off.
    let (failures, last_error, next_attempt): (Option<i32>, Option<String>, Option<i64>) =
        sqlx::query_as(
            "SELECT enrollment_failures, enrollment_last_error, enrollment_next_attempt_at \
             FROM organization_domains WHERE id = $1",
        )
        .bind(&domain.id)
        .fetch_one(&state.pool)
        .await
        .expect("failure columns");
    assert_eq!(failures, Some(1));
    assert!(last_error
        .expect("last error")
        .starts_with("internal_server_error"));
    assert!(next_attempt.expect("next attempt") > orbitid_core::http::now());
    let backing_off = run_enrollment_tick(state, LONG, 10).await.expect("tick");
    assert_eq!(
        (
            backing_off.chunks,
            backing_off.completed,
            backing_off.failed
        ),
        (0, 0, 0),
        "the next tick does not retry before the back-off elapsed"
    );
    assert!(marker(state, &domain.id).await.0.is_some(), "stays pending");

    // Still failing once the back-off elapsed: the count grows and so does the wait.
    sqlx::query("UPDATE organization_domains SET enrollment_next_attempt_at = 0 WHERE id = $1")
        .bind(&domain.id)
        .execute(&state.pool)
        .await
        .expect("elapse");
    let again = run_enrollment_tick(state, LONG, 10).await.expect("tick");
    assert_eq!(again.failed, 1);
    let failures: Option<i32> =
        sqlx::query_scalar("SELECT enrollment_failures FROM organization_domains WHERE id = $1")
            .bind(&domain.id)
            .fetch_one(&state.pool)
            .await
            .expect("failures");
    assert_eq!(failures, Some(2));

    sqlx::query("DROP TRIGGER fail_outbox ON webhook_events")
        .execute(&state.pool)
        .await
        .expect("drop");
    sqlx::query("UPDATE organization_domains SET enrollment_next_attempt_at = 0 WHERE id = $1")
        .bind(&domain.id)
        .execute(&state.pool)
        .await
        .expect("elapse");
    let healthy = run_enrollment_tick(state, LONG, 10).await.expect("tick");
    assert_eq!((healthy.completed, healthy.failed), (1, 0));
    let cleared: (Option<i32>, Option<String>, Option<i64>) = sqlx::query_as(
        "SELECT enrollment_failures, enrollment_last_error, enrollment_next_attempt_at \
         FROM organization_domains WHERE id = $1",
    )
    .bind(&domain.id)
    .fetch_one(&state.pool)
    .await
    .expect("cleared");
    assert_eq!(cleared, (None, None, None), "success resets the counter");
    assert_eq!(enrolled(state, &org, &users).await, users);
    assert_eq!(marker(state, &domain.id).await, (None, String::new()));
}
