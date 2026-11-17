//! Retention sweeps with an injected clock: orphan-client grace and session
//! retention (adds to the existing cleanup coverage).

use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_identity::retention::{
    sweep_once, CLIENT_ORPHAN_GRACE_MS, RETENTION_GRACE_MS, SESSION_RETENTION_MS,
};
use orbitid_identity::sessions::end_session;
use orbitid_identity::testing::{create_test_client_session, create_test_user, test_app_state};

async fn insert_client(state: &orbitid_core::AppState, token: &str, updated_at: i64) -> String {
    let id = new_id(id_prefix::CLIENT);
    sqlx::query(
        "INSERT INTO clients (id, token_hash, created_at, updated_at) VALUES ($1,$2,$3,$3)",
    )
    .bind(&id)
    .bind(orbitid_core::crypto::sha256(token))
    .bind(updated_at)
    .execute(&state.pool)
    .await
    .expect("client");
    id
}

async fn client_exists(state: &orbitid_core::AppState, id: &str) -> bool {
    sqlx::query_scalar::<_, String>("SELECT id FROM clients WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .expect("client lookup")
        .is_some()
}

/// A session-less client that still holds a valid `__client` cookie must not be
/// swept after the old 24 h window. Before the fix a browser idle for a day got
/// 401 on its first non-GET.
#[tokio::test]
async fn a_session_less_client_survives_for_the_client_cookie_lifetime() {
    let app = test_app_state().await;
    let state = app.state();
    let now_ms = now();
    let idle = insert_client(state, "idle-token", now_ms - 30 * 24 * 60 * 60 * 1000).await;
    let expired = insert_client(
        state,
        "expired-token",
        now_ms - CLIENT_ORPHAN_GRACE_MS - RETENTION_GRACE_MS,
    )
    .await;

    let sweep = sweep_once(state, Some(now_ms), Some(100))
        .await
        .expect("sweep");
    assert!(sweep.clients >= 1);
    assert!(
        client_exists(state, &idle).await,
        "a client inside the cookie lifetime + grace must survive"
    );
    assert!(
        !client_exists(state, &expired).await,
        "a client past the cookie lifetime + grace is swept"
    );
}

/// A client with an in-flight (non-terminal) sign-up is never swept, even when
/// its `updated_at` is ancient: deleting it would cascade the attempt away.
#[tokio::test]
async fn a_client_with_an_inflight_attempt_is_not_swept() {
    let app = test_app_state().await;
    let state = app.state();
    let now_ms = now();
    let stale = now_ms - CLIENT_ORPHAN_GRACE_MS - RETENTION_GRACE_MS;
    let client = insert_client(state, "attempt-token", stale).await;
    let sign_up_id = new_id(id_prefix::SIGN_UP);
    sqlx::query(
        "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, \
         abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'missing_requirements','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3,$3,$3)",
    )
    .bind(&sign_up_id)
    .bind(&client)
    .bind(now_ms + 60_000)
    .execute(&state.pool)
    .await
    .expect("sign-up");

    sweep_once(state, Some(now_ms), Some(100))
        .await
        .expect("sweep");
    assert!(
        client_exists(state, &client).await,
        "a client with an in-flight attempt must survive"
    );

    sqlx::query("UPDATE sign_ups SET status = 'abandoned', abandon_at = $1 WHERE id = $2")
        .bind(now_ms - RETENTION_GRACE_MS - 1)
        .bind(&sign_up_id)
        .execute(&state.pool)
        .await
        .expect("abandon");
    sweep_once(state, Some(now_ms), Some(100))
        .await
        .expect("sweep");
    assert!(
        !client_exists(state, &client).await,
        "once the attempt is swept the orphan client becomes eligible"
    );
}

/// Ended/revoked/expired sessions are removed after the documented 90-day
/// window; active/pending sessions are never touched. Pointers from attempt
/// rows and clients are cleared in the same transaction.
#[tokio::test]
async fn sessions_are_purged_after_the_documented_window() {
    let app = test_app_state().await;
    let state = app.state();
    let now_ms = now();
    let user = create_test_user(state, "retention-sessions@example.com", "Sup3r-secret!")
        .await
        .expect("user");
    let ended_auth = create_test_client_session(state, &user.user.id)
        .await
        .expect("ended session");
    let active_auth = create_test_client_session(state, &user.user.id)
        .await
        .expect("active session");

    let stored = orbitid_identity::sessions::get_session(state, &ended_auth.session.id)
        .await
        .expect("load")
        .expect("session");
    end_session(state, &stored, "ended")
        .await
        .expect("end session");
    sqlx::query("UPDATE sessions SET updated_at = $1 WHERE id = $2")
        .bind(now_ms - SESSION_RETENTION_MS - 1)
        .bind(&ended_auth.session.id)
        .execute(&state.pool)
        .await
        .expect("age session");

    // A sign-in that points at the ended session must be cleared, not dangle.
    let sign_in_id = new_id(id_prefix::SIGN_IN);
    sqlx::query(
        "INSERT INTO sign_ins (id, client_id, status, state, created_session_id, abandon_at, \
         created_at, updated_at) VALUES ($1,$2,'complete','{}'::jsonb,$3,$4,$4,$4)",
    )
    .bind(&sign_in_id)
    .bind(&ended_auth.client.id)
    .bind(&ended_auth.session.id)
    .bind(now_ms - SESSION_RETENTION_MS - 1)
    .execute(&state.pool)
    .await
    .expect("sign-in");

    let sweep = sweep_once(state, Some(now_ms), Some(100))
        .await
        .expect("sweep");
    assert!(sweep.sessions >= 1, "the ended session must be swept");
    let gone: Option<String> = sqlx::query_scalar("SELECT id FROM sessions WHERE id = $1")
        .bind(&ended_auth.session.id)
        .fetch_optional(&state.pool)
        .await
        .expect("lookup");
    assert!(gone.is_none(), "an aged ended session is deleted");
    let pointer: Option<Option<String>> =
        sqlx::query_scalar("SELECT created_session_id FROM sign_ins WHERE id = $1")
            .bind(&sign_in_id)
            .fetch_optional(&state.pool)
            .await
            .expect("pointer");
    if let Some(pointer) = pointer {
        assert!(
            pointer.is_none(),
            "created_session_id must not dangle after the session is deleted"
        );
    }

    let active: Option<String> = sqlx::query_scalar("SELECT id FROM sessions WHERE id = $1")
        .bind(&active_auth.session.id)
        .fetch_optional(&state.pool)
        .await
        .expect("active lookup");
    assert!(
        active.is_some(),
        "active sessions are never removed by retention"
    );
}

/// Webhook deliveries/events and audit rows are swept only past their
/// configured windows, and only once every delivery of an event is terminal.
#[tokio::test]
async fn webhooks_and_audit_logs_follow_the_configured_retention() {
    use orbitid_core::config::EnvOverrides;
    use orbitid_identity::testing::test_app_state_with;

    let app = test_app_state_with(EnvOverrides {
        webhook_retention_days: Some(1),
        audit_retention_days: Some(1),
        ..Default::default()
    })
    .await;
    let state = app.state();
    let now_ms = now();
    let old = now_ms - 2 * 24 * 60 * 60 * 1000;
    let fresh = now_ms - 60 * 60 * 1000;
    sqlx::query(
        "INSERT INTO webhook_endpoints (id, url, event_types, secret, created_at, updated_at) \
         VALUES ('whe_1', 'https://example.test/hook', '[]'::jsonb, 'secret', $1, $1)",
    )
    .bind(now_ms)
    .execute(&state.pool)
    .await
    .unwrap();
    for (id, created) in [
        ("ev_old_success", old),
        ("ev_old_failed", old),
        ("ev_old_pending", old),
        ("ev_old_orphan", old),
        ("ev_fresh", fresh),
    ] {
        sqlx::query(
            "INSERT INTO webhook_events (id, type, payload, created_at) VALUES ($1, 'user.created', '{}'::jsonb, $2)",
        )
        .bind(id)
        .bind(created)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    for (id, event, status, created) in [
        ("whd_old_success", "ev_old_success", "success", old),
        ("whd_old_failed", "ev_old_failed", "failed", old),
        ("whd_old_pending", "ev_old_pending", "pending", old),
        ("whd_fresh_success", "ev_fresh", "success", fresh),
    ] {
        sqlx::query(
            "INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, attempt, created_at) \
             VALUES ($1, 'whe_1', $2, $3, 0, $4)",
        )
        .bind(id)
        .bind(event)
        .bind(status)
        .bind(created)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    for (id, created) in [("aud_old", old), ("aud_fresh", fresh)] {
        sqlx::query(
            "INSERT INTO audit_logs (id, action, metadata, created_at) VALUES ($1, 'user.deleted', '{}'::jsonb, $2)",
        )
        .bind(id)
        .bind(created)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let sweep = sweep_once(state, Some(now_ms), Some(100)).await.unwrap();
    assert_eq!(sweep.webhook_deliveries, 2, "only terminal, old deliveries");
    assert_eq!(
        sweep.webhook_events, 3,
        "terminal deliveries and the event with no deliveries"
    );
    assert_eq!(sweep.audit_logs, 1);
    let events: Vec<String> = sqlx::query_scalar("SELECT id FROM webhook_events ORDER BY id")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(events, vec!["ev_fresh", "ev_old_pending"]);
    let audits: Vec<String> = sqlx::query_scalar("SELECT id FROM audit_logs")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(audits, vec!["aud_fresh"]);
}

/// Audit retention of zero keeps every row (the default: compliance trails are
/// often required to be immutable).
#[tokio::test]
async fn audit_logs_are_kept_forever_by_default() {
    let app = test_app_state().await;
    let state = app.state();
    let now_ms = now();
    sqlx::query(
        "INSERT INTO audit_logs (id, action, metadata, created_at) VALUES ('aud_ancient', 'user.deleted', '{}'::jsonb, $1)",
    )
    .bind(now_ms - 10 * 365 * 24 * 60 * 60 * 1000)
    .execute(&state.pool)
    .await
    .unwrap();
    let sweep = sweep_once(state, Some(now_ms), Some(100)).await.unwrap();
    assert_eq!(sweep.audit_logs, 0);
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM audit_logs WHERE id = 'aud_ancient')")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert!(exists);
}

/// Orphaned upload rows (abandoned uploads, or rows orphaned before the
/// deletion fixes) are swept after the grace period; a row a user or
/// organization still points at is never touched.
#[tokio::test]
async fn orphaned_uploads_are_swept_after_the_grace_period() {
    let app = test_app_state().await;
    let state = app.state();
    let now_ms = now();
    let old = now_ms - RETENTION_GRACE_MS - 60_000;
    let user = create_test_user(state, "upload-retention@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let kept = format!("{}_kept.png", user.user.id);
    sqlx::query("UPDATE users SET image_url = $1 WHERE id = $2")
        .bind(format!("http://localhost:4000/v1/client/images/{kept}"))
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    for (file, created) in [("usr_orphan.png", old), (kept.as_str(), old)] {
        sqlx::query(
            "INSERT INTO uploads (file, bucket, owner_id, content_type, bytes, created_at) \
             VALUES ($1, 'avatar', 'usr_x', 'image/png', $2, $3)",
        )
        .bind(file)
        .bind(b"png")
        .bind(created)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    let sweep = sweep_once(state, Some(now_ms), Some(100)).await.unwrap();
    assert_eq!(sweep.uploads, 1);
    let files: Vec<String> = sqlx::query_scalar("SELECT file FROM uploads ORDER BY file")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(files, vec![kept]);
}

/// Sessions that passed `expire_at` or the inactivity timeout are marked
/// `expired` by the retention worker (with the same event the lazy read path
/// writes), so the ordinary 90-day deletion can then remove them. Before this
/// sweep they stayed `active` forever and retention never purged them.
#[tokio::test]
async fn stale_active_sessions_are_expired_and_then_purged() {
    let app = test_app_state().await;
    let state = app.state();
    state
        .settings
        .update(serde_json::json!({ "session": { "inactivityTimeoutSeconds": 60 } }))
        .await
        .unwrap();
    let user = create_test_user(state, "expiry@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    let absolute = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let inactivity = create_test_client_session(state, &user.user.id)
        .await
        .unwrap();
    let now_ms = now();
    sqlx::query("UPDATE sessions SET expire_at = $1 WHERE id = $2")
        .bind(now_ms - 1_000)
        .bind(&absolute.session.id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE sessions SET last_active_at = $1, expire_at = $2 WHERE id = $3")
        .bind(now_ms - 3_600_000)
        .bind(now_ms + 86_400_000)
        .bind(&inactivity.session.id)
        .execute(&state.pool)
        .await
        .unwrap();

    let sweep = sweep_once(state, Some(now_ms), Some(100)).await.unwrap();
    assert_eq!(sweep.sessions_expired, 2, "{sweep:?}");
    let statuses: Vec<String> = sqlx::query_scalar("SELECT status FROM sessions ORDER BY id")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(statuses, vec!["expired", "expired"]);
    let events: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webhook_events WHERE type = 'session.ended'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(events, 2, "one session.ended event per expired session");
    // Idempotent: a second sweep has nothing left to expire.
    let again = sweep_once(state, Some(now_ms), Some(100)).await.unwrap();
    assert_eq!(again.sessions_expired, 0);

    // 91 days later the usual 90-day session retention removes the rows.
    let later = now_ms + 91 * 86_400_000;
    let purge = sweep_once(state, Some(later), Some(100)).await.unwrap();
    assert_eq!(purge.sessions, 2, "{purge:?}");
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
}

/// The orphan-upload predicate is a plain equality against the generated
/// `image_file` column, and the planner uses the partial indexes created by
/// migration 0009 (the old `right(image_url, ...)` expression could not).
#[tokio::test]
async fn orphan_upload_detection_is_index_backed() {
    let app = test_app_state().await;
    let state = app.state();
    let user = create_test_user(state, "upload-plan@example.com", "Sup3r-secret!")
        .await
        .unwrap();
    sqlx::query("UPDATE users SET image_url = $1 WHERE id = $2")
        .bind("http://localhost:4000/v1/client/images/usr_plan_abc.png")
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    let derived: Option<String> = sqlx::query_scalar("SELECT image_file FROM users WHERE id = $1")
        .bind(&user.user.id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(derived.as_deref(), Some("usr_plan_abc.png"));

    let mut conn = state.pool.acquire().await.unwrap();
    sqlx::query("SET enable_seqscan = off")
        .execute(&mut *conn)
        .await
        .unwrap();
    for table in ["users", "organizations"] {
        let plan: Vec<String> = sqlx::query_scalar(&format!(
            "EXPLAIN SELECT 1 FROM {table} t WHERE t.image_file = 'usr_plan_abc.png'"
        ))
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let plan = plan.join("\n");
        assert!(
            plan.contains(&format!("{table}_image_file_idx")),
            "the plan does not use the image_file index:\n{plan}"
        );
    }
}

/// Inserts `count` verifications well past the grace period.
async fn seed_dead_verifications(state: &orbitid_core::AppState, count: i64, label: &str) {
    let old = now() - RETENTION_GRACE_MS - 60_000;
    let user = create_test_user(state, &format!("{label}@example.com"), "Sup3r-secret!")
        .await
        .unwrap();
    for index in 0..count {
        sqlx::query(
            "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, attempts, \
             max_attempts, expires_at, created_at) \
             VALUES ($1,'sign_in','email_code',$2,$3,0,5,$4,$4)",
        )
        .bind(new_id(id_prefix::VERIFICATION))
        .bind(format!("{label}-{index}@example.com"))
        .bind(&user.user.id)
        .bind(old)
        .execute(&state.pool)
        .await
        .unwrap();
    }
}

/// A tick keeps draining full batches instead of stopping after one. Before the
/// fix 1 verification/second grew the backlog by 3 100 rows every hour forever.
#[tokio::test]
async fn one_tick_drains_several_full_batches() {
    let app = test_app_state().await;
    let state = app.state();
    seed_dead_verifications(state, 5, "batches").await;
    let sweep = sweep_once(state, Some(now()), Some(2))
        .await
        .expect("sweep");
    assert_eq!(sweep.verifications, 5, "{sweep:?}");
    let remaining: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE purpose = 'sign_in'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
}

/// The runtime budget stops an over-long tick between batches (never before its
/// first batch, so progress is guaranteed) and the next tick continues.
#[tokio::test]
async fn the_tick_budget_stops_between_batches_and_the_next_tick_continues() {
    use orbitid_core::config::EnvOverrides;
    use orbitid_identity::retention::{sweep_with_budget, RETENTION_BUDGET_MS};
    use orbitid_identity::testing::test_app_state_with;
    use std::time::Duration;

    let app = test_app_state_with(EnvOverrides {
        retention_batch_size: Some(2),
        retention_budget_ms: Some(0),
        ..Default::default()
    })
    .await;
    let state = app.state();
    seed_dead_verifications(state, 5, "budget").await;

    let first = sweep_once(state, Some(now()), None)
        .await
        .expect("first tick");
    assert_eq!(
        first.verifications, 2,
        "a zero budget runs exactly one full batch: {first:?}"
    );
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE purpose = 'sign_in'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(left, 3);

    let second = sweep_with_budget(
        state,
        Some(now()),
        None,
        Duration::from_millis(RETENTION_BUDGET_MS),
    )
    .await
    .expect("next tick");
    assert_eq!(
        second.verifications, 3,
        "the next tick continues where the budget stopped: {second:?}"
    );
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM verifications WHERE purpose = 'sign_in'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
}
