//! Settings store behaviour on a real Postgres: sealing, migrations, the
//! LISTEN/NOTIFY propagation between replicas and production boot defaults.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::Arc;

use serde_json::json;

use orbitid_core::config::EnvOverrides;
use orbitid_core::secrets::is_sealed_secret;
use orbitid_core::settings::{
    create_settings_store, DeliveryEnvironment, SettingsStore, SettingsStoreOptions,
};
use orbitid_core::state::{create_context, AppState};
use support::EphemeralDb;

fn store_options(state: &AppState, database_url: &str) -> SettingsStoreOptions {
    SettingsStoreOptions {
        connect_options: database_url.parse().expect("database url"),
        encryption_key: state.env.encryption_key.clone(),
        node_env: state.env.node_env.clone(),
        production: false,
        env: DeliveryEnvironment::default(),
        after_session_rewrite: None,
    }
}

async fn stored_application(state: &AppState) -> serde_json::Value {
    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT settings FROM instance WHERE id = 'default'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    stored["application"].clone()
}

fn temp_dir() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("orbitid-settings-test-{}", nanoid::nanoid!(10)));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[tokio::test]
async fn update_seals_secrets_and_serves_plaintext() {
    let ctx = support::test_state().await;
    ctx.state
        .settings
        .update(json!({
            "application": { "name": "Renamed" },
            "email": {
                "smtpUrl": "smtp://mailer:hunter2@smtp.example.com:587",
                "resendApiKey": "re_live_abcdefghijklmnop"
            },
            "sms": { "twilioAuthToken": "twilio-auth-token-value" },
            "security": { "captchaSecret": "captcha-secret-value" },
            "social": {
                "google": {
                    "enabled": true,
                    "clientId": "google-id",
                    "clientSecret": "google-client-secret"
                }
            }
        }))
        .await
        .unwrap();

    let settings = ctx.state.settings.get();
    assert_eq!(settings.application.name, "Renamed");
    assert_eq!(
        settings.email.smtp_url,
        "smtp://mailer:hunter2@smtp.example.com:587"
    );
    assert_eq!(
        settings.social["google"].client_secret,
        "google-client-secret"
    );

    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT settings FROM instance WHERE id = 'default'")
            .fetch_one(&ctx.state.pool)
            .await
            .unwrap();
    let text = stored.to_string();
    for secret in [
        "hunter2",
        "re_live_abcdefghijklmnop",
        "twilio-auth-token-value",
        "captcha-secret-value",
        "google-client-secret",
    ] {
        assert!(!text.contains(secret), "stored settings leaked {secret}");
    }
    assert!(is_sealed_secret(&stored["email"]["smtpUrl"]));
    assert!(is_sealed_secret(
        &stored["social"]["google"]["clientSecret"]
    ));
    assert_eq!(stored["__settingsVersion"], 3);
}

#[tokio::test]
async fn updates_propagate_to_another_replica() {
    let first = support::test_state().await;
    let second = support::try_test_state_with(EnvOverrides {
        database_url: Some(first.db.url.clone()),
        data_dir: Some(temp_dir()),
        ..Default::default()
    })
    .await
    .unwrap();

    first
        .state
        .settings
        .update(json!({ "application": { "name": "From replica one" } }))
        .await
        .unwrap();

    // LISTEN/NOTIFY is asynchronous; the periodic refresh is the fallback.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if second.state.settings.get().application.name == "From replica one" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "settings did not propagate to the second replica"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn legacy_settings_are_migrated_and_sessions_rescued() {
    let ctx = support::test_state().await;
    let now = orbitid_core::http::now();
    let day = 86_400_000_i64;

    let mut legacy =
        serde_json::to_value(orbitid_core::settings::InstanceSettings::default()).unwrap();
    legacy["session"]["lifetimeSeconds"] = json!(604_800);
    legacy["session"]["multiSession"] = json!(false);
    legacy["password"]["signOutOfOtherSessionsOnChange"] = json!(true);
    legacy["anonymous"]["retentionSeconds"] = json!(2_592_000);
    sqlx::query("UPDATE instance SET settings = $1 WHERE id = 'default'")
        .bind(sqlx::types::Json(legacy))
        .execute(&ctx.state.pool)
        .await
        .unwrap();

    let user = "user_legacy";
    let client = "client_legacy";
    let active = "sess_active";
    let revoked = "sess_revoked";
    for (id, label) in [(user, "Legacy"), (client, "Legacy")] {
        if id.starts_with("user") {
            sqlx::query(
                "INSERT INTO users (id, first_name, public_metadata, private_metadata, unsafe_metadata, created_at, updated_at) \
                 VALUES ($1, $2, '{}', '{}', '{}', $3, $3)",
            )
            .bind(id)
            .bind(label)
            .bind(now)
            .execute(&ctx.state.pool)
            .await
            .unwrap();
        } else {
            sqlx::query(
                "INSERT INTO clients (id, token_hash, created_at, updated_at) VALUES ($1, $2, $3, $3)",
            )
            .bind(id)
            .bind(format!("hash_{label}"))
            .bind(now)
            .execute(&ctx.state.pool)
            .await
            .unwrap();
        }
    }
    for (id, status) in [(active, "active"), (revoked, "revoked")] {
        sqlx::query(
            "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, abandon_at, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $6, $5, $5)",
        )
        .bind(id)
        .bind(client)
        .bind(user)
        .bind(status)
        .bind(now)
        .bind(now + 7 * day)
        .execute(&ctx.state.pool)
        .await
        .unwrap();
    }

    // A fresh process (a second context on the same database) runs the upgrade.
    let reopened = support::try_test_state_with(EnvOverrides {
        database_url: Some(ctx.db.url.clone()),
        data_dir: Some(temp_dir()),
        ..Default::default()
    })
    .await
    .unwrap();

    let settings = reopened.state.settings.get();
    assert_eq!(settings.session.lifetime_seconds, 0);
    assert!(settings.session.multi_session);
    assert!(!settings.password.sign_out_of_other_sessions_on_change);
    assert!(settings.password.sign_out_of_other_sessions_on_reset);
    assert_eq!(settings.anonymous.retention_seconds, 0);

    let active_expire: i64 = sqlx::query_scalar("SELECT expire_at FROM sessions WHERE id = $1")
        .bind(active)
        .fetch_one(&reopened.state.pool)
        .await
        .unwrap();
    assert_eq!(active_expire, orbitid_core::keys::SESSION_NEVER_EXPIRES_AT);
    let revoked_expire: i64 = sqlx::query_scalar("SELECT expire_at FROM sessions WHERE id = $1")
        .bind(revoked)
        .fetch_one(&reopened.state.pool)
        .await
        .unwrap();
    assert_eq!(revoked_expire, now + 7 * day);

    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT settings FROM instance WHERE id = 'default'")
            .fetch_one(&reopened.state.pool)
            .await
            .unwrap();
    assert_eq!(stored["__settingsVersion"], 3);
}

#[tokio::test]
async fn production_starts_without_trusted_origins_and_a_derived_key() {
    let db = EphemeralDb::create().await;
    let overrides = |data_dir: std::path::PathBuf| EnvOverrides {
        database_url: Some(db.url.clone()),
        base_url: Some("https://auth.example.com".to_string()),
        node_env: Some("production".to_string()),
        encryption_key: Some("k".repeat(40)),
        data_dir: Some(data_dir),
        dashboard_dir: Some(temp_dir()),
        ..Default::default()
    };
    let first = create_context(support::with_pool_gate(overrides(temp_dir())))
        .await
        .unwrap();
    let application = &first.settings.get().application;
    assert!(!application.development_mode);
    assert!(application.allowed_origins.is_empty());
    assert!(first.env.secret_key.starts_with("sk_live_"));
    let derived = first.env.secret_key.clone();

    let second = create_context(support::with_pool_gate(overrides(temp_dir())))
        .await
        .unwrap();
    assert_eq!(second.env.secret_key, derived, "derivation must be stable");
    let other = create_context(support::with_pool_gate(EnvOverrides {
        encryption_key: Some("j".repeat(40)),
        ..overrides(temp_dir())
    }))
    .await
    .unwrap();
    assert_ne!(other.env.secret_key, derived);
}

#[tokio::test]
async fn secret_key_is_derived_stably_from_the_encryption_key() {
    let db = EphemeralDb::create().await;
    let data_dir = temp_dir();
    let overrides = || EnvOverrides {
        database_url: Some(db.url.clone()),
        base_url: Some("http://localhost:4000".to_string()),
        node_env: Some("test".to_string()),
        encryption_key: Some("test-encryption-key-for-orbitid-0123456789".to_string()),
        data_dir: Some(data_dir.clone()),
        ..Default::default()
    };
    let first = create_context(support::with_pool_gate(overrides()))
        .await
        .unwrap();
    assert!(first.env.secret_key.starts_with("sk_test_"));
    // Postgres always requires an explicit encryption key, so the secret is
    // derived from it and `keys.json` is not needed (see the bootstrap docs).
    assert!(!data_dir.join("keys.json").exists());
    let second = create_context(support::with_pool_gate(overrides()))
        .await
        .unwrap();
    assert_eq!(first.env.secret_key, second.env.secret_key);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_updates_from_two_replicas_keep_both_fields() {
    let ctx = support::test_state().await;
    let first: Arc<SettingsStore> = ctx.state.settings.clone();
    let second = create_settings_store(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();

    // Both replicas merge onto their own memory and persist the whole document.
    // With the old code one of the two fields is always reset to its default.
    let (a, b) = tokio::join!(
        first.update(json!({ "application": { "name": "replica-one" } })),
        second.update(json!({
            "application": { "homeUrl": "https://replica-two.example.test" }
        })),
    );
    a.expect("first replica update");
    b.expect("second replica update");

    let application = stored_application(&ctx.state).await;
    assert_eq!(application["name"], "replica-one");
    assert_eq!(application["homeUrl"], "https://replica-two.example.test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn many_concurrent_updates_from_two_replicas_lose_no_field() {
    let ctx = support::test_state().await;
    let first: Arc<SettingsStore> = ctx.state.settings.clone();
    let second = create_settings_store(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();

    let mut handles = Vec::new();
    for index in 0..15 {
        let store = first.clone();
        handles.push(tokio::spawn(async move {
            store
                .update(json!({ "application": { "name": format!("name-{index}") } }))
                .await
                .map(|_| ())
        }));
    }
    for index in 0..15 {
        let store = second.clone();
        handles.push(tokio::spawn(async move {
            store
                .update(json!({
                    "application": { "homeUrl": format!("https://home-{index}.example.test") }
                }))
                .await
                .map(|_| ())
        }));
    }
    for handle in handles {
        handle.await.expect("task joins").expect("update succeeds");
    }

    let application = stored_application(&ctx.state).await;
    let name = application["name"].as_str().unwrap_or("");
    let home = application["homeUrl"].as_str().unwrap_or("");
    assert!(
        name.starts_with("name-"),
        "the name written by one replica was lost: {name:?}"
    );
    assert!(
        home.starts_with("https://home-"),
        "the homeUrl written by the other replica was lost: {home:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_updates_through_one_store_keep_both_fields() {
    let ctx = support::test_state().await;
    let store: Arc<SettingsStore> = ctx.state.settings.clone();

    let (a, b) = tokio::join!(
        store.update(json!({ "application": { "name": "in-process-one" } })),
        store.update(json!({
            "application": { "termsUrl": "https://terms.example.test" }
        })),
    );
    a.expect("first update");
    b.expect("second update");

    let application = stored_application(&ctx.state).await;
    assert_eq!(application["name"], "in-process-one");
    assert_eq!(application["termsUrl"], "https://terms.example.test");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_first_boot_creates_one_settings_row() {
    // A database copied from the migrated template has no `instance` row yet,
    // exactly like two replicas racing on a brand-new deployment.
    let db = EphemeralDb::create().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(10)
        .connect(&db.url)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM instance")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "the template must start without an instance row");

    let options = SettingsStoreOptions {
        connect_options: db.url.parse().expect("database url"),
        encryption_key: "test-encryption-key-for-orbitid-0123456789".to_string(),
        node_env: "test".to_string(),
        production: false,
        env: DeliveryEnvironment::default(),
        after_session_rewrite: None,
    };
    let mut handles = Vec::new();
    for _ in 0..8 {
        let pool = pool.clone();
        let options = SettingsStoreOptions {
            connect_options: options.connect_options.clone(),
            encryption_key: options.encryption_key.clone(),
            node_env: options.node_env.clone(),
            production: options.production,
            env: options.env.clone(),
            after_session_rewrite: None,
        };
        handles.push(tokio::spawn(async move {
            create_settings_store(pool, options)
                .await
                .map(|store| store.get().application.name.clone())
        }));
    }
    let mut names = Vec::new();
    for handle in handles {
        names.push(handle.await.expect("task joins").expect("boot succeeds"));
    }
    assert!(
        names.iter().all(|name| name == &names[0]),
        "replicas disagree on the booted settings: {names:?}"
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM instance")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1, "first boot must create exactly one instance row");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_contexts_boot_on_a_fresh_database() {
    let db = EphemeralDb::create().await;
    let mut handles = Vec::new();
    for index in 0..4 {
        let database_url = db.url.clone();
        let data_dir = std::env::temp_dir().join(format!(
            "orbitid-concurrent-boot-{}-{index}",
            nanoid::nanoid!(8)
        ));
        std::fs::create_dir_all(&data_dir).unwrap();
        handles.push(tokio::spawn(async move {
            create_context(support::with_pool_gate(EnvOverrides {
                database_url: Some(database_url),
                data_dir: Some(data_dir),
                node_env: Some("test".to_string()),
                encryption_key: Some("test-encryption-key-for-orbitid-0123456789".to_string()),
                base_url: Some("http://localhost:4000".to_string()),
                ..Default::default()
            }))
            .await
            .map(|state| state.settings.get().application.name.clone())
        }));
    }
    let mut names = Vec::new();
    for handle in handles {
        names.push(handle.await.expect("task joins").expect("context boots"));
    }
    assert!(
        names.iter().all(|name| name == &names[0]),
        "concurrent boots disagree: {names:?}"
    );
}

#[tokio::test]
async fn a_stale_reload_never_replaces_a_newer_snapshot() {
    let ctx = support::test_state().await;
    let store: Arc<SettingsStore> = ctx.state.settings.clone();
    let before = store.get().application.name.clone();

    // Make the stored row unambiguously older than the update below, so the two
    // row versions differ even at millisecond resolution.
    sqlx::query("UPDATE instance SET updated_at = $1 WHERE id = 'default'")
        .bind(orbitid_core::http::now() - 60_000)
        .execute(&ctx.state.pool)
        .await
        .unwrap();
    let (stale_version, stale) = store
        .read_snapshot_for_tests()
        .await
        .expect("the stored snapshot");
    assert_eq!(stale.application.name, before);

    store
        .update(json!({ "application": { "name": "newer" } }))
        .await
        .unwrap();
    assert_eq!(store.get().application.name, "newer");

    // A reload that read the row before the update now finishes: the stale
    // snapshot must not be served over the newer one.
    store.publish_snapshot_for_tests(stale_version, stale).await;
    assert_eq!(
        store.get().application.name,
        "newer",
        "an older snapshot replaced a newer one"
    );

    // A snapshot at the newer version (what a real reload reads) is published.
    let (version, current) = store
        .read_snapshot_for_tests()
        .await
        .expect("the updated snapshot");
    assert!(version > stale_version);
    store
        .publish_snapshot_for_tests(version, current.clone())
        .await;
    assert_eq!(store.get().application.name, current.application.name);
}

/// Waits (up to five seconds) for a replica to serve `name`.
async fn wait_for_name(store: &SettingsStore, name: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if store.get().application.name == name {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "settings did not reach {name:?}; the replica still serves {:?}",
            store.get().application.name
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// The reviewer's reproduction: a row whose informational `updated_at` is ten
/// minutes ahead (a replica with a fast clock, or a backup restored with its
/// stamps) used to pin the served version above every later write, so a PATCH
/// committed but was never served — not even after a restart.
#[tokio::test]
async fn a_skewed_clock_cannot_pin_an_older_snapshot() {
    let ctx = support::test_state().await;
    sqlx::query("UPDATE instance SET updated_at = $1 WHERE id = 'default'")
        .bind(orbitid_core::http::now() + 600_000)
        .execute(&ctx.state.pool)
        .await
        .unwrap();

    // "Restart": a store that boots from the future-stamped row.
    let restarted = create_settings_store(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();
    // A second replica that boots from the same row before the write.
    let observer = create_settings_store(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();

    let served = restarted
        .update(json!({ "application": { "name": "after the skew" } }))
        .await
        .unwrap();
    assert_eq!(
        served.application.name, "after the skew",
        "the PATCH response served the pre-update snapshot"
    );
    assert_eq!(restarted.get().application.name, "after the skew");
    assert_eq!(
        stored_application(&ctx.state).await["name"],
        "after the skew",
        "the committed value must be what the database holds"
    );
    wait_for_name(&observer, "after the skew").await;
}

/// Two writes that land in the same millisecond (or whose host clocks disagree)
/// still publish in commit order, and a snapshot that was read before the second
/// write can never replace it.
#[tokio::test]
async fn two_writes_in_the_same_millisecond_are_both_observed_in_order() {
    let ctx = support::test_state().await;
    // Pin every write's informational timestamp to the same value: exactly what
    // two commits within one millisecond look like, and what the old
    // timestamp-as-version scheme collided on.
    sqlx::query(
        "CREATE FUNCTION orbitid_test_freeze_instance_time() RETURNS trigger AS $$ \
         BEGIN NEW.updated_at := 4102444800000; RETURN NEW; END $$ LANGUAGE plpgsql",
    )
    .execute(&ctx.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER orbitid_test_freeze_instance_time BEFORE UPDATE ON instance \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_freeze_instance_time()",
    )
    .execute(&ctx.state.pool)
    .await
    .unwrap();

    let writer = ctx.state.settings.clone();
    let observer = create_settings_store(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();

    writer
        .update(json!({ "application": { "name": "first write" } }))
        .await
        .unwrap();
    let (first_version, first_snapshot) = writer
        .read_snapshot_for_tests()
        .await
        .expect("the first snapshot");
    wait_for_name(&observer, "first write").await;

    writer
        .update(json!({ "application": { "name": "second write" } }))
        .await
        .unwrap();
    let (second_version, _) = writer
        .read_snapshot_for_tests()
        .await
        .expect("the second snapshot");
    assert!(
        second_version > first_version,
        "two commits must be ordered even when they carry the same timestamp"
    );
    wait_for_name(&observer, "second write").await;

    // The intermediate snapshot (stamped with the same millisecond as the later
    // one) must not roll the observer back.
    observer
        .publish_snapshot_for_tests(first_version, first_snapshot)
        .await;
    assert_eq!(observer.get().application.name, "second write");
}

/// A database restored from an older backup advertises a *lower* revision than
/// the replica already serves. A single backwards read is not enough to adopt it
/// (a lagging read could roll settings back); two consecutive refreshes are.
#[tokio::test]
async fn a_database_restored_to_an_older_revision_is_adopted_after_two_refreshes() {
    let ctx = support::test_state().await;
    // A store with no background refresher: otherwise its own periodic
    // LISTEN/NOTIFY reload can observe the backwards revision between this
    // test's two explicit refreshes and consume the "second consecutive read"
    // counter early, which is exactly what made this test flaky under load.
    let store = orbitid_core::settings::create_settings_store_without_refresher(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();
    store
        .update(json!({ "application": { "name": "after the backup" } }))
        .await
        .unwrap();
    assert_eq!(store.get().application.name, "after the backup");

    let (revision, _) = store
        .read_snapshot_for_tests()
        .await
        .expect("the current snapshot");
    assert!(revision >= 1);
    let mut restored =
        serde_json::to_value(orbitid_core::settings::InstanceSettings::default()).unwrap();
    restored["application"]["name"] = json!("from the backup");

    // The restore puts back the older tree *and* the older revision.
    sqlx::query("UPDATE instance SET settings = $1, revision = $2 WHERE id = 'default'")
        .bind(sqlx::types::Json(restored))
        .bind(revision - 1)
        .execute(&ctx.state.pool)
        .await
        .unwrap();

    store.refresh_for_tests().await;
    assert_eq!(
        store.get().application.name,
        "after the backup",
        "one backwards read must not roll the replica back"
    );

    store.refresh_for_tests().await;
    assert_eq!(
        store.get().application.name,
        "from the backup",
        "a database revision that stays behind must be adopted"
    );
}

/// A write during the restored-database window commits a revision at or below
/// the one this replica already serves. Its own response must return the
/// snapshot it committed, not the older cached value the monotonic guard keeps
/// serving until the restore is adopted.
#[tokio::test]
async fn a_write_during_a_restore_returns_its_own_commit() {
    let ctx = support::test_state().await;
    let store = orbitid_core::settings::create_settings_store_without_refresher(
        ctx.state.pool.clone(),
        store_options(&ctx.state, &ctx.db.url),
    )
    .await
    .unwrap();
    store
        .update(json!({ "application": { "name": "after the backup" } }))
        .await
        .unwrap();
    let (revision, _) = store
        .read_snapshot_for_tests()
        .await
        .expect("the current snapshot");
    let mut restored =
        serde_json::to_value(orbitid_core::settings::InstanceSettings::default()).unwrap();
    restored["application"]["name"] = json!("from the backup");
    sqlx::query("UPDATE instance SET settings = $1, revision = $2 WHERE id = 'default'")
        .bind(sqlx::types::Json(restored))
        .bind(revision - 1)
        .execute(&ctx.state.pool)
        .await
        .unwrap();

    let response = store
        .update(json!({ "application": { "name": "my write" } }))
        .await
        .unwrap();
    assert_eq!(
        response.application.name, "my write",
        "an update must return the snapshot it committed"
    );
    assert_eq!(
        store.get().application.name,
        "after the backup",
        "the monotonic guard still refuses to adopt the backwards revision"
    );
}

/// The notification carries the committed revision, so listeners can skip
/// revisions they have already applied.
#[tokio::test]
async fn notifications_carry_the_revision() {
    let ctx = support::test_state().await;
    let store = ctx.state.settings.clone();
    let mut listener = sqlx::postgres::PgListener::connect(&ctx.db.url)
        .await
        .unwrap();
    listener.listen("orbitid_settings").await.unwrap();

    store
        .update(json!({ "application": { "name": "notified" } }))
        .await
        .unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM instance WHERE id = 'default'")
        .fetch_one(&ctx.state.pool)
        .await
        .unwrap();

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        assert!(
            !remaining.is_zero(),
            "no settings notification arrived; the database revision is {revision}"
        );
        let Ok(notification) = tokio::time::timeout(remaining, listener.recv()).await else {
            continue;
        };
        let notification = notification.unwrap();
        assert_eq!(
            notification.payload(),
            revision.to_string(),
            "the payload must be the committed revision"
        );
        break;
    }
}
