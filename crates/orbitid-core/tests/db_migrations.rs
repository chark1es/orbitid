//! Database bootstrap: migrations produce the drizzle schema, and an existing
//! drizzle-managed database is baselined instead of re-created.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

use orbitid_core::db;
use support::EphemeralDb;

const DRIZZLE_SQL: [&str; 10] = [
    include_str!("fixtures/drizzle/0000_jazzy_shen.sql"),
    include_str!("fixtures/drizzle/0001_clumsy_vermin.sql"),
    include_str!("fixtures/drizzle/0002_military_screwball.sql"),
    include_str!("fixtures/drizzle/0003_burly_komodo.sql"),
    include_str!("fixtures/drizzle/0004_operator_sessions.sql"),
    include_str!("fixtures/drizzle/0005_user_roles.sql"),
    include_str!("fixtures/drizzle/0006_authorization_integrity.sql"),
    include_str!("fixtures/drizzle/0007_same_amphibian.sql"),
    include_str!("fixtures/drizzle/0008_clean_wiccan.sql"),
    include_str!("fixtures/drizzle/0009_next_silver_sable.sql"),
];

const DRIZZLE_WHEN: [i64; 10] = [
    1_793_179_006_557,
    1_793_191_100_425,
    1_793_222_963_044,
    1_793_230_537_655,
    1_793_267_535_178,
    1_793_329_431_283,
    1_793_384_519_834,
    1_793_438_575_306,
    1_794_386_500_563,
    1_794_386_538_117,
];

async fn pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .connect(url)
        .await
        .unwrap()
}

async fn tables(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn fresh_database_has_the_full_drizzle_schema() {
    let db = EphemeralDb::create().await;
    let pool = pool(&db.url).await;
    let names = tables(&pool).await;
    for table in [
        "instance",
        "signing_keys",
        "users",
        "email_addresses",
        "phone_numbers",
        "external_accounts",
        "passkeys",
        "clients",
        "sessions",
        "sign_ins",
        "sign_ups",
        "verifications",
        "oauth_states",
        "rate_limits",
        "organizations",
        "roles",
        "permissions",
        "role_permissions",
        "user_roles",
        "organization_memberships",
        "organization_invitations",
        "organization_domains",
        "organization_membership_requests",
        "invitations",
        "waitlist_entries",
        "allowlist_identifiers",
        "blocklist_identifiers",
        "jwt_templates",
        "actor_tokens",
        "sign_in_tokens",
        "webhook_endpoints",
        "webhook_events",
        "webhook_deliveries",
        "api_keys",
        "machines",
        "m2m_tokens",
        "oauth_applications",
        "oauth_grants",
        "oauth_consents",
        "enterprise_connections",
        "trusted_devices",
        "operator_sessions",
        "device_codes",
        "audit_logs",
        "rate_limit_windows",
    ] {
        assert!(
            names.iter().any(|name| name == table),
            "missing table {table}"
        );
    }

    // Columns added by migrations after the initial baseline exist with the documented types.
    let row = sqlx::query(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'sessions' AND column_name = 'auth_method'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("data_type"), "text");

    let row = sqlx::query(
        "SELECT column_default FROM information_schema.columns WHERE table_name = 'oauth_applications' AND column_name = 'pkce_required'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("column_default").as_deref(),
        Some("false")
    );

    let row = sqlx::query(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'totp_last_used_step'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("data_type"), "bigint");

    let row = sqlx::query(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns \
         WHERE table_name = 'instance' AND column_name = 'revision'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<String, _>("data_type"), "bigint");
    assert_eq!(row.get::<String, _>("is_nullable"), "NO");
    assert_eq!(
        row.get::<Option<String>, _>("column_default").as_deref(),
        Some("0")
    );

    for table in ["sign_ins", "sign_ups"] {
        let row = sqlx::query(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns \
             WHERE table_name = $1 AND column_name = 'version'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("data_type"), "bigint");
        assert_eq!(row.get::<String, _>("is_nullable"), "NO");
        assert_eq!(
            row.get::<Option<String>, _>("column_default").as_deref(),
            Some("0")
        );
    }

    let invitation_index: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'oi_pending_lower_email_created_idx'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(invitation_index, 1);

    // Named constraints and indexes keep their drizzle names.
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('email_unique_verified','om_org_user','oi_email_idx')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(indexes.len(), 3);

    let hardening_indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('oi_pending_lower_email_created_idx','ver_owner_purpose_identifier_created_idx','sign_ins_client_created_idx')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(hardening_indexes, 3);

    let retention_indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('audit_logs_created_at_idx','webhook_deliveries_status_created_at_idx','webhook_deliveries_event_id_idx','webhook_events_created_at_idx','uploads_created_at_idx')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(retention_indexes, 5);

    let upload_indexes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('users_image_file_idx','organizations_image_file_idx','sessions_active_expire_idx','sessions_active_last_active_idx')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(upload_indexes, 4);

    // Generated upload-pointer columns (index-backed orphan detection).
    for table in ["users", "organizations"] {
        let row = sqlx::query(
            "SELECT is_generated FROM information_schema.columns              WHERE table_name = $1 AND column_name = 'image_file'",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("is_generated"), "ALWAYS", "{table}");
    }

    let constraints: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('users_external_id_unique','oauth_grants_token_hash_unique','user_roles_role_key_roles_key_fk')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(constraints, 3);
    pool.close().await;
}

/// Runs the drizzle SQL (including its journal) against an empty database, so
/// we can prove the Rust baselining path upgrades a real TypeScript deployment.
async fn apply_drizzle(url: &str, count: usize) {
    let pool = pool(url).await;
    sqlx::query("CREATE SCHEMA IF NOT EXISTS drizzle")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (index, sql) in DRIZZLE_SQL.iter().take(count).enumerate() {
        for statement in sql.split("--> statement-breakpoint") {
            let statement = statement.trim();
            if statement.is_empty() {
                continue;
            }
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)")
            .bind(format!("hash-{index}"))
            .bind(DRIZZLE_WHEN[index])
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn existing_drizzle_database_is_baselined() {
    let db = EphemeralDb::create_empty().await;
    apply_drizzle(&db.url, 10).await;
    let pool = pool(&db.url).await;
    db::run_migrations(&pool).await.unwrap();
    let versions: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        versions,
        vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    );
    assert!(tables(&pool)
        .await
        .iter()
        .any(|t| t == "rate_limit_windows"));
    // The baseline did not try to recreate the existing tables.
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 0);
    pool.close().await;
}

#[tokio::test]
async fn incomplete_drizzle_database_is_refused_with_a_clear_message() {
    let db = EphemeralDb::create_empty().await;
    apply_drizzle(&db.url, 8).await;
    let pool = pool(&db.url).await;
    let error = db::run_migrations(&pool).await.unwrap_err();
    assert!(
        error.message.contains("not at migration 0009"),
        "{}",
        error.message
    );
    assert!(error.message.contains("TypeScript server"));
    pool.close().await;
}

/// Migration 0010 builds its index concurrently (no write lock); a failed build
/// leaves an INVALID index of that name, which is dropped before the retry.
#[tokio::test]
async fn an_invalid_concurrent_index_is_rebuilt() {
    let db = EphemeralDb::create().await;
    let pool = pool(&db.url).await;
    let valid = |pool: PgPool| async move {
        sqlx::query_scalar::<_, bool>(
            "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid \
             WHERE c.relname = 'email_addresses_verified_domain_idx'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap()
    };
    assert_eq!(valid(pool.clone()).await, Some(true));
    sqlx::query(
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = \
         'email_addresses_verified_domain_idx'::regclass",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 10")
        .execute(&pool)
        .await
        .unwrap();
    db::run_migrations(&pool).await.unwrap();
    assert_eq!(valid(pool.clone()).await, Some(true));
    pool.close().await;
}

async fn index_valid(pool: &PgPool) -> Option<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid \
         WHERE c.relname = 'email_addresses_verified_domain_idx'",
    )
    .fetch_optional(pool)
    .await
    .unwrap()
}

/// Several replicas (separate pools) migrating a fresh database at once all
/// succeed; the concurrent index exists and is valid.
#[tokio::test]
async fn concurrent_starts_on_a_fresh_database_all_succeed() {
    let db = EphemeralDb::create_empty().await;
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let url = db.url.clone();
        tasks.push(tokio::spawn(async move {
            let pool = pool(&url).await;
            let result = db::run_migrations(&pool).await;
            pool.close().await;
            result
        }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    let pool = pool(&db.url).await;
    assert_eq!(index_valid(&pool).await, Some(true));
    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(versions, 15);
    pool.close().await;
}

/// An INVALID leftover plus two simultaneous starts: both succeed (no deadlock
/// from one start dropping the index the other is rebuilding).
#[tokio::test]
async fn an_invalid_leftover_with_two_concurrent_starts_is_rebuilt_once() {
    let db = EphemeralDb::create().await;
    let setup = pool(&db.url).await;
    sqlx::query(
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = \
         'email_addresses_verified_domain_idx'::regclass",
    )
    .execute(&setup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 10")
        .execute(&setup)
        .await
        .unwrap();
    let starts: Vec<_> = (0..2)
        .map(|_| {
            let url = db.url.clone();
            tokio::spawn(async move {
                let pool = pool(&url).await;
                let result = db::run_migrations(&pool).await;
                pool.close().await;
                result
            })
        })
        .collect();
    for start in starts {
        start.await.unwrap().unwrap();
    }
    assert_eq!(index_valid(&setup).await, Some(true));
    setup.close().await;
}

/// While another replica holds the startup lock (its build is in progress, the
/// index is temporarily INVALID), a starting replica waits and never drops it.
#[tokio::test]
async fn a_start_during_another_replicas_build_waits_and_never_drops_the_index() {
    let db = EphemeralDb::create().await;
    let setup = pool(&db.url).await;
    let mut holder = setup.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(hashtext('orbitid_startup_migrations')::bigint)")
        .execute(&mut *holder)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = \
         'email_addresses_verified_domain_idx'::regclass",
    )
    .execute(&setup)
    .await
    .unwrap();
    let url = db.url.clone();
    let start = tokio::spawn(async move {
        let pool = pool(&url).await;
        let result = db::run_migrations(&pool).await;
        pool.close().await;
        result
    });
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    assert!(!start.is_finished(), "the start waits for the lock");
    assert_eq!(
        index_valid(&setup).await,
        Some(false),
        "the in-progress index is untouched"
    );
    // The "other replica" finishes its build and releases the lock.
    sqlx::query(
        "UPDATE pg_index SET indisvalid = true WHERE indexrelid = \
         'email_addresses_verified_domain_idx'::regclass",
    )
    .execute(&setup)
    .await
    .unwrap();
    sqlx::query("SELECT pg_advisory_unlock(hashtext('orbitid_startup_migrations')::bigint)")
        .execute(&mut *holder)
        .await
        .unwrap();
    drop(holder);
    start.await.unwrap().unwrap();
    assert_eq!(index_valid(&setup).await, Some(true));
    setup.close().await;
}

/// A pool of one connection must not self-deadlock (lock holder never asks the
/// pool for a second connection), including baselining a drizzle database.
#[tokio::test]
async fn migrations_work_on_a_single_connection_pool() {
    let db = EphemeralDb::create_empty().await;
    let single = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(20))
        .connect(&db.url)
        .await
        .unwrap();
    db::run_migrations(&single).await.unwrap();
    db::run_migrations(&single).await.unwrap();
    assert_eq!(index_valid(&single).await, Some(true));
    single.close().await;

    let drizzle = EphemeralDb::create_empty().await;
    apply_drizzle(&drizzle.url, 10).await;
    let single = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(20))
        .connect(&drizzle.url)
        .await
        .unwrap();
    db::run_migrations(&single).await.unwrap();
    single.close().await;
}

/// An INVALID index whose migration is already recorded as applied is rebuilt
/// too (nothing else would), from its own definition.
#[tokio::test]
async fn an_invalid_index_of_an_applied_migration_is_rebuilt() {
    let db = EphemeralDb::create().await;
    let pool = pool(&db.url).await;
    sqlx::query(
        "UPDATE pg_index SET indisvalid = false WHERE indexrelid = \
         'email_addresses_verified_domain_idx'::regclass",
    )
    .execute(&pool)
    .await
    .unwrap();
    db::run_migrations(&pool).await.unwrap();
    assert_eq!(index_valid(&pool).await, Some(true));
    let definition: String = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'email_addresses_verified_domain_idx'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        definition.contains("split_part") && definition.contains("WHERE"),
        "{definition}"
    );
    pool.close().await;
}

/// An interrupted repair (invalid index dropped, rebuild never ran) leaves the
/// ledger intact and the index missing: the next start recreates it.
#[tokio::test]
async fn a_missing_index_of_an_applied_migration_is_recreated() {
    let db = EphemeralDb::create().await;
    let pool = pool(&db.url).await;
    sqlx::query("DROP INDEX email_addresses_verified_domain_idx")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(index_valid(&pool).await, None);
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    db::run_migrations(&pool).await.unwrap();
    assert_eq!(index_valid(&pool).await, Some(true));
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(applied, after, "the ledger is unchanged");
    pool.close().await;
}

/// Dropping the `run_migrations` future mid-migration must not leave the
/// startup lock held by a connection that went back to the pool.
#[tokio::test]
async fn a_cancelled_migration_releases_the_startup_lock() {
    let db = EphemeralDb::create().await;
    let first = pool(&db.url).await;
    // Make migration 10 pending again and block its CONCURRENTLY build.
    sqlx::query("DROP INDEX email_addresses_verified_domain_idx")
        .execute(&first)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 10")
        .execute(&first)
        .await
        .unwrap();
    let mut blocker = first.begin().await.unwrap();
    sqlx::query("LOCK TABLE email_addresses IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let blocked = pool(&db.url).await;
    let cancelled = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        db::run_migrations(&blocked),
    )
    .await;
    assert!(
        cancelled.is_err(),
        "the migration is stuck behind the table lock"
    );
    blocker.rollback().await.unwrap();
    // `blocked` stays open: the lock must be gone because its connection closed.
    let second = pool(&db.url).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        db::run_migrations(&second),
    )
    .await
    .expect("the startup lock was released")
    .unwrap();
    assert_eq!(index_valid(&second).await, Some(true));
    second.close().await;
    blocked.close().await;
    first.close().await;
}

/// The grant revocation filters (by user, session, application) can use an
/// index instead of scanning every `oauth_grants` row while holding locks.
#[tokio::test]
async fn grant_revocation_lookups_use_their_indexes() {
    let db = EphemeralDb::create().await;
    let pool = pool(&db.url).await;
    let mut conn = pool.acquire().await.unwrap();
    sqlx::query("SET enable_seqscan = off")
        .execute(&mut *conn)
        .await
        .unwrap();
    for (column, index) in [
        ("user_id", "oauth_grants_user_idx"),
        ("session_id", "oauth_grants_session_idx"),
        ("application_id", "oauth_grants_application_idx"),
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, bool>(
                "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid \
                 WHERE c.relname = $1"
            )
            .bind(index)
            .fetch_optional(&mut *conn)
            .await
            .unwrap(),
            Some(true),
            "{index} exists"
        );
        let plan: Vec<String> = sqlx::query_scalar(&format!(
            "EXPLAIN UPDATE oauth_grants SET revoked = true WHERE {column} = 'x' \
             AND kind IN ('access', 'refresh', 'code')"
        ))
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let plan = plan.join("\n");
        assert!(
            plan.contains(index),
            "{column} does not use {index}:\n{plan}"
        );
    }
    drop(conn);
    pool.close().await;
}
