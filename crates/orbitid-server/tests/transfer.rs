//! Service-level transfer tests, ported from the retired TypeScript test suite
//! (the Postgres halves; SQLite/PGlite sources are intentionally gone).

mod common;

use std::path::PathBuf;

use axum::http::StatusCode;
use orbitid_core::config::EnvOverrides;
use orbitid_core::state::create_context;
use orbitid_core::testing::{EphemeralDb, TestClient};
use orbitid_core::AppState;
use orbitid_server::transfer::{copy_database_with, export_database, import_database};
use serde_json::{json, Value};

const KEY: &str = "test-encryption-key-for-orbitid-0123456789";

async fn state(database_url: &str) -> AppState {
    let data_dir = std::env::temp_dir().join(format!(
        "orbitid-rs-transfer-{}",
        orbitid_core::crypto::random_token(8)
    ));
    let state = create_context(orbitid_core::testing::with_test_pool_gate(EnvOverrides {
        database_url: Some(database_url.to_string()),
        secret_key: Some(common::SECRET_KEY.to_string()),
        base_url: Some("http://localhost:4000".to_string()),
        node_env: Some("test".to_string()),
        encryption_key: Some(KEY.to_string()),
        data_dir: Some(data_dir),
        dashboard_dir: Some(PathBuf::from("/nonexistent-dashboard")),
        ..Default::default()
    }))
    .await
    .expect("context");
    orbitid_identity::install_without_workers(&state)
        .await
        .expect("install");
    state
}

fn temp_file() -> PathBuf {
    std::env::temp_dir().join(format!(
        "orbitid-export-{}.jsonl",
        orbitid_core::crypto::random_token(8)
    ))
}

#[tokio::test]
async fn export_and_import_round_trip_every_table() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;

    let password_hash = {
        let user = orbitid_identity::testing::create_test_user(
            &source,
            "owner@transfer.test",
            "Sup3rSecret!",
        )
        .await
        .expect("user");
        sqlx::query_scalar::<_, Option<String>>("SELECT password_hash FROM users WHERE id = $1")
            .bind(&user.user.id)
            .fetch_one(&source.pool)
            .await
            .expect("hash")
            .expect("password hash")
    };

    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    let exported = export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");
    assert!(exported.rows >= 1);
    let tables: Vec<&str> = exported
        .tables
        .iter()
        .map(|(table, _)| table.as_str())
        .collect();
    assert!(tables.contains(&"users"));
    assert!(tables.contains(&"webhook_deliveries"));
    assert!(tables.contains(&"audit_logs"));
    assert!(!tables.contains(&"rate_limits"));
    assert!(!tables.contains(&"rate_limit_windows"));
    assert!(!tables.contains(&"operator_sessions"));

    // The document is JSON Lines: a header, then portable row objects.
    let text = std::fs::read_to_string(&path).expect("export file");
    let lines: Vec<&str> = text.lines().collect();
    let header: Value = serde_json::from_str(lines[0]).expect("header");
    assert_eq!(header["orbitid_export"], 1);
    assert_eq!(header["dialect"], "postgres");
    assert!(header["schema_version"]
        .as_str()
        .unwrap_or("")
        .starts_with("postgres:"));
    assert!(header["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|table| table == "users"));
    assert!(header["key_check"].as_str().unwrap().len() > 10);
    let user_line = lines[1..]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|line| line["t"] == "users")
        .expect("users row");
    assert!(user_line["r"]["created_at"].is_i64());
    assert!(user_line["r"]["banned"].is_boolean());
    assert!(user_line["r"]["public_metadata"].is_object());

    let imported = import_database(&target, &path_text, false, false, &|_| {})
        .await
        .expect("import");
    assert!(imported.ok);
    assert!(imported.counts.iter().all(|count| count.ok));
    // The claim is the target's own state: never exported, always set by an
    // import, so dashboard owner setup cannot open on a restored instance.
    assert!(!imported
        .counts
        .iter()
        .any(|count| count.table == "console_owner_setup"));
    let claimed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM console_owner_setup")
        .fetch_one(&target.pool)
        .await
        .expect("claim");
    assert_eq!(claimed, 1);

    let target_hash: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id = (SELECT user_id FROM email_addresses LIMIT 1)",
    )
    .fetch_one(&target.pool)
    .await
    .expect("target hash");
    assert_eq!(target_hash, Some(password_hash));

    // Signing keys survive: the target can read them with the same encryption key.
    orbitid_credentials::keys::assert_signing_keys_readable(&target)
        .await
        .expect("signing keys readable");

    let _ = tokio::fs::remove_file(&path).await;
}

/// Rewrites an export as an older server would have written it: the named keys
/// are removed from every row of `table`. Counts and the header stay untouched.
fn strip_keys(source: &std::path::Path, table: &str, keys: &[&str]) -> PathBuf {
    let text = std::fs::read_to_string(source).expect("export file");
    let path = temp_file();
    let mut out = String::new();
    for line in text.lines() {
        let mut value: Value = serde_json::from_str(line).expect("json line");
        if value["t"] == table {
            if let Some(row) = value["r"].as_object_mut() {
                for key in keys {
                    row.remove(*key);
                }
            }
        }
        out.push_str(&serde_json::to_string(&value).expect("json"));
        out.push('\n');
    }
    std::fs::write(&path, out).expect("rewritten export");
    path
}

#[tokio::test]
async fn an_export_from_before_the_new_columns_imports_with_their_defaults() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;
    let signed_up = orbitid_identity::testing::create_test_client_session(
        &source,
        &orbitid_identity::testing::create_test_user(&source, "old@export.test", "Sup3rSecret!")
            .await
            .expect("user")
            .user
            .id,
    )
    .await
    .expect("session");
    let now_ms = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO sign_ins (id, client_id, status, state, abandon_at, created_at, updated_at) \
         VALUES ('si_old_export',$1,'needs_identifier','{}'::jsonb,$2,$2,$2)",
    )
    .bind(&signed_up.client.id)
    .bind(now_ms)
    .execute(&source.pool)
    .await
    .expect("sign in");
    sqlx::query(
        "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, \
         abandon_at, created_at, updated_at) \
         VALUES ('su_old_export',$1,'missing_requirements','{}'::jsonb,'{}'::jsonb, \
                 '{}'::jsonb,$2,$2,$2)",
    )
    .bind(&signed_up.client.id)
    .bind(now_ms)
    .execute(&source.pool)
    .await
    .expect("sign up");

    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");
    // The TypeScript server had no version/revision columns at all.
    let stripped = strip_keys(&path, "sign_ins", &["version"]);
    let stripped = strip_keys(&stripped, "sign_ups", &["version"]);
    let stripped = strip_keys(&stripped, "instance", &["revision"]);
    let stripped_text = stripped.to_string_lossy().to_string();

    let imported = import_database(&target, &stripped_text, false, false, &|_| {})
        .await
        .expect("an older export imports");
    assert!(imported.ok);

    let sign_in_version: i64 =
        sqlx::query_scalar("SELECT version FROM sign_ins WHERE id = 'si_old_export'")
            .fetch_one(&target.pool)
            .await
            .expect("sign in version");
    let sign_up_version: i64 =
        sqlx::query_scalar("SELECT version FROM sign_ups WHERE id = 'su_old_export'")
            .fetch_one(&target.pool)
            .await
            .expect("sign up version");
    assert_eq!(sign_in_version, 0, "DEFAULT 0 applied to an absent column");
    assert_eq!(sign_up_version, 0, "DEFAULT 0 applied to an absent column");
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM instance")
        .fetch_one(&target.pool)
        .await
        .expect("instance revision");
    assert_eq!(
        revision, 1,
        "the import loads DEFAULT 0 and then bumps the revision"
    );

    let _ = tokio::fs::remove_file(&path).await;
    let _ = tokio::fs::remove_file(&stripped).await;
}

#[tokio::test]
async fn a_missing_not_null_column_without_a_default_fails_with_a_clear_message() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;
    orbitid_identity::testing::create_test_user(&source, "missing@export.test", "Sup3rSecret!")
        .await
        .expect("user");
    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");
    let stripped = strip_keys(&path, "email_addresses", &["email"]);
    let stripped_text = stripped.to_string_lossy().to_string();

    let error = import_database(&target, &stripped_text, false, false, &|_| {})
        .await
        .expect_err("a missing NOT NULL value is refused");
    assert!(error.contains("email_addresses"), "{error}");
    assert!(error.contains("\"email\""), "{error}");
    assert!(error.contains("NOT NULL"), "{error}");

    let _ = tokio::fs::remove_file(&path).await;
    let _ = tokio::fs::remove_file(&stripped).await;
}

#[tokio::test]
async fn refuses_a_populated_target_without_truncate_yes() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;
    orbitid_identity::testing::create_test_user(&source, "a@transfer.test", "Sup3rSecret!")
        .await
        .expect("source user");
    orbitid_identity::testing::create_test_user(&target, "b@transfer.test", "Sup3rSecret!")
        .await
        .expect("target user");

    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");

    let error = import_database(&target, &path_text, false, false, &|_| {})
        .await
        .expect_err("populated target is refused");
    assert!(error.contains("already contains data"), "{error}");
    assert!(error.contains("--truncate --yes"), "{error}");

    let error = import_database(&target, &path_text, true, false, &|_| {})
        .await
        .expect_err("truncate requires --yes");
    assert!(error.contains("--yes"), "{error}");

    // With both flags the import replaces the target and verifies counts.
    let imported = import_database(&target, &path_text, true, true, &|_| {})
        .await
        .expect("truncating import");
    assert!(imported.ok);
    let target_user: String = sqlx::query_scalar(
        "SELECT email FROM email_addresses WHERE user_id = (SELECT id FROM users LIMIT 1)",
    )
    .fetch_one(&target.pool)
    .await
    .expect("target user");
    assert_eq!(target_user, "a@transfer.test");

    let _ = tokio::fs::remove_file(&path).await;
}

#[tokio::test]
async fn a_wrong_encryption_key_is_refused_before_any_write() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let mut target = state(&target_db.url).await;
    orbitid_identity::testing::create_test_user(&source, "a@transfer.test", "Sup3rSecret!")
        .await
        .expect("source user");
    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");

    // The environment is the source of the key in the real CLI; override it for this state.
    let mut env = (*target.env).clone();
    env.encryption_key = "a-different-encryption-key-0123456789".to_string();
    target.env = std::sync::Arc::new(env);
    let error = import_database(&target, &path_text, true, true, &|_| {})
        .await
        .expect_err("wrong key");
    assert!(
        error.contains("different ORBITID_ENCRYPTION_KEY"),
        "{error}"
    );

    let _ = tokio::fs::remove_file(&path).await;
}

#[tokio::test]
async fn pages_large_tables_without_dropping_or_repeating_rows() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let source = state(&source_db.url).await;
    sqlx::query(
        "INSERT INTO audit_logs (id, actor, action, metadata, created_at) \
         SELECT 'audit_bulk_' || lpad(i::text, 5, '0'), 'test', 'bulk.created', \
                '{}'::jsonb, i FROM generate_series(0, 1199) i",
    )
    .execute(&source.pool)
    .await
    .expect("bulk rows");

    let path = temp_file();
    let path_text = path.to_string_lossy().to_string();
    export_database(&source, &path_text, &|_| {})
        .await
        .expect("export");
    let text = std::fs::read_to_string(&path).expect("export file");
    let mut ids: Vec<String> = text
        .lines()
        .skip(1)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["t"] == "audit_logs")
        .filter_map(|row| row["r"]["id"].as_str().map(str::to_string))
        .collect();
    assert_eq!(ids.len(), 1200);
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "rows come back in primary-key order");
    ids.dedup();
    assert_eq!(ids.len(), 1200);

    let target_db = EphemeralDb::create().await.expect("target db");
    let target = state(&target_db.url).await;
    let imported = import_database(&target, &path_text, false, false, &|_| {})
        .await
        .expect("import");
    assert!(imported.ok);
    let copied: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM audit_logs")
        .fetch_one(&target.pool)
        .await
        .expect("count");
    assert_eq!(copied, 1200);
    let _ = tokio::fs::remove_file(&path).await;
}

// ---------------------------------------------------------------------------
// Importing a TypeScript-server export
//
// The retired TypeScript exporter ordered tables by schema *declaration* order
// (`tableOrder` in `packages/server/src/services/transfer/shared.ts`), while
// this port orders them by database discovery order. Independent tables may
// therefore appear in a different (but equally valid) sequence, and an import
// must accept any order that satisfies the real foreign keys.
// ---------------------------------------------------------------------------

/// The TypeScript schema's declaration order (`defineSchema` in
/// `packages/server/src/db/define-schema.ts`, as enumerated by `TABLE_NAMES` in
/// `schema.ts`), in database table names. `rate_limits` and `operator_sessions`
/// are omitted because that exporter never copied them.
const TS_DECLARATION_ORDER: [&str; 42] = [
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
    "device_codes",
    "audit_logs",
];

/// Tables this port added after the TypeScript schema (migrations 0002 and
/// 0004); a TypeScript export cannot contain them.
const RUST_ONLY_EXPORTED_TABLES: [&str; 1] = ["uploads"];

/// Columns this port added after the TypeScript schema (migrations 0005-0009);
/// a TypeScript export cannot contain them, and the import must apply today's
/// defaults (or the generated expression) instead.
const RUST_ONLY_COLUMNS: [(&str, &str); 6] = [
    ("users", "totp_last_used_step"),
    ("users", "image_file"),
    ("organizations", "image_file"),
    ("sign_ins", "version"),
    ("sign_ups", "version"),
    ("instance", "revision"),
];

struct ExportDocument {
    header: Value,
    rows: Vec<Value>,
}

fn read_export(path: &std::path::Path) -> ExportDocument {
    let text = std::fs::read_to_string(path).expect("export file");
    let mut lines = text.lines();
    let header: Value =
        serde_json::from_str(lines.next().expect("export header line")).expect("export header");
    let rows = lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("export row line"))
        .collect();
    ExportDocument { header, rows }
}

fn write_export(document: &ExportDocument, path: &std::path::Path) {
    let mut text = serde_json::to_string(&document.header).expect("header json");
    text.push('\n');
    for row in &document.rows {
        text.push_str(&serde_json::to_string(row).expect("row json"));
        text.push('\n');
    }
    std::fs::write(path, text).expect("write export");
}

/// A port of the TypeScript `tableOrder()`: greedy over declaration order,
/// taking the first table whose foreign keys have all been emitted already.
fn ts_table_order(present: &[String], edges: &[(String, String)]) -> Vec<String> {
    use std::collections::{HashMap, HashSet};
    let present: HashSet<&str> = present.iter().map(String::as_str).collect();
    let mut dependencies: HashMap<&str, HashSet<&str>> = HashMap::new();
    for (child, parent) in edges {
        if present.contains(child.as_str()) && present.contains(parent.as_str()) && child != parent
        {
            dependencies
                .entry(child.as_str())
                .or_default()
                .insert(parent.as_str());
        }
    }
    let eligible = |table: &str, done: &HashSet<&str>| {
        !done.contains(table)
            && dependencies
                .get(table)
                .is_none_or(|parents| parents.iter().all(|parent| done.contains(parent)))
    };
    let mut ordered: Vec<String> = Vec::with_capacity(present.len());
    let mut done: HashSet<&str> = HashSet::new();
    while ordered.len() < present.len() {
        let next = TS_DECLARATION_ORDER
            .iter()
            .copied()
            .find(|table| present.contains(table) && eligible(table, &done))
            // A table this port added (not in the TS declaration list) is
            // emitted last; the caller filters those out anyway.
            .or_else(|| present.iter().copied().find(|table| eligible(table, &done)))
            .expect("no foreign-key cycle");
        ordered.push(next.to_string());
        done.insert(next);
    }
    ordered
}

/// Builds the export a TypeScript server would have produced from `source`:
/// its table order, no `uploads`/`rate_limit_windows` tables and none of the
/// columns added by migrations 0002-0009.
async fn write_typescript_style_export(
    source: &AppState,
    export_path: &std::path::Path,
) -> (std::path::PathBuf, Vec<String>) {
    let edges: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.relname::text, p.relname::text \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_class p ON p.oid = con.confrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.contype = 'f' AND n.nspname = 'public'",
    )
    .fetch_all(&source.pool)
    .await
    .expect("foreign keys");

    let mut document = read_export(export_path);
    let present: Vec<String> = document.header["tables"]
        .as_array()
        .expect("tables")
        .iter()
        .filter_map(|table| table.as_str().map(str::to_string))
        .filter(|table| !RUST_ONLY_EXPORTED_TABLES.contains(&table.as_str()))
        .collect();
    let order = ts_table_order(&present, &edges);

    document.rows.retain(|row| {
        row["t"]
            .as_str()
            .is_some_and(|table| present.iter().any(|name| name == table))
    });
    for row in &mut document.rows {
        let table = row["t"].as_str().unwrap_or_default().to_string();
        if let Some(values) = row.get_mut("r").and_then(Value::as_object_mut) {
            for (column_table, column) in RUST_ONLY_COLUMNS {
                if column_table == table {
                    values.remove(column);
                }
            }
        }
    }
    let position = |row: &Value| {
        let table = row["t"].as_str().unwrap_or_default();
        order
            .iter()
            .position(|name| name == table)
            .unwrap_or(usize::MAX)
    };
    document.rows.sort_by_key(position);
    document.header["tables"] = serde_json::json!(order);

    let path = temp_file();
    write_export(&document, &path);
    (path, order)
}

fn exported_table_order(path: &std::path::Path) -> Vec<String> {
    read_export(path).header["tables"]
        .as_array()
        .expect("tables")
        .iter()
        .filter_map(|table| table.as_str().map(str::to_string))
        .collect()
}

#[tokio::test]
async fn a_typescript_ordered_export_imports_and_signs_in() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;
    let user = orbitid_identity::testing::create_test_user(
        &source,
        "ts-export@transfer.test",
        "Sup3rSecret!",
    )
    .await
    .expect("user");
    orbitid_identity::testing::create_test_client_session(&source, &user.user.id)
        .await
        .expect("session");

    let exported = temp_file();
    let exported_text = exported.to_string_lossy().to_string();
    export_database(&source, &exported_text, &|_| {})
        .await
        .expect("export");
    let rust_order = exported_table_order(&exported);
    let (fixture, ts_order) = write_typescript_style_export(&source, &exported).await;
    assert_ne!(
        ts_order, rust_order,
        "the fixture must reproduce the TypeScript exporter's order, not this port's"
    );
    assert!(fixture.exists());

    let fixture_text = fixture.to_string_lossy().to_string();
    let imported = import_database(&target, &fixture_text, false, false, &|_| {})
        .await
        .expect("a TypeScript-ordered export imports");
    assert!(imported.ok);
    assert!(imported.counts.iter().all(|count| count.ok));

    // Boot the server on the imported database and sign the fixture's user in.
    let client = TestClient::new(orbitid_server::build_app(target.clone()));
    let response = client
        .post(
            "/v1/client/sign_ins",
            Some(json!({
                "identifier": "ts-export@transfer.test",
                "password": "Sup3rSecret!"
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.value()["response"]["status"], "complete");

    let _ = tokio::fs::remove_file(&exported).await;
    let _ = tokio::fs::remove_file(&fixture).await;
}

#[tokio::test]
async fn a_header_that_really_breaks_a_dependency_is_still_refused() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    let target = state(&target_db.url).await;
    orbitid_identity::testing::create_test_user(&source, "fk@transfer.test", "Sup3rSecret!")
        .await
        .expect("user");
    let exported = temp_file();
    let exported_text = exported.to_string_lossy().to_string();
    export_database(&source, &exported_text, &|_| {})
        .await
        .expect("export");

    // `email_addresses` references `users`; listing it first is not a valid
    // topological order under any exporter's convention.
    let mut document = read_export(&exported);
    let mut order = exported_table_order(&exported);
    let email = order
        .iter()
        .position(|table| table == "email_addresses")
        .expect("email_addresses");
    order.remove(email);
    order.insert(0, "email_addresses".to_string());
    document.header["tables"] = serde_json::json!(order);
    let broken = temp_file();
    write_export(&document, &broken);

    let error = import_database(&target, &broken.to_string_lossy(), false, false, &|_| {})
        .await
        .expect_err("a header that breaks a foreign key is refused");
    assert!(
        error.contains("The export lists email_addresses before users"),
        "clear dependency message: {error}"
    );

    let _ = tokio::fs::remove_file(&exported).await;
    let _ = tokio::fs::remove_file(&broken).await;
}

/// Recreates an empty, foreign-key-free table so it gets a fresh OID at the end
/// of the catalog. `information_schema.tables` (and therefore this port's
/// discovery order) reflects physical creation order, and the copy is
/// structurally identical (`LIKE … INCLUDING ALL`).
async fn move_table_to_the_end(database_url: &str, table: &str) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(database_url)
        .await
        .expect("raw pool");
    sqlx::query(&format!(
        "CREATE TABLE \"{table}__moved\" (LIKE \"{table}\" INCLUDING ALL)"
    ))
    .execute(&pool)
    .await
    .expect("copy table");
    sqlx::query(&format!("DROP TABLE \"{table}\""))
        .execute(&pool)
        .await
        .expect("drop table");
    sqlx::query(&format!(
        "ALTER TABLE \"{table}__moved\" RENAME TO \"{table}\""
    ))
    .execute(&pool)
    .await
    .expect("rename table");
    pool.close().await;
}

#[tokio::test]
async fn a_round_trip_works_between_databases_with_different_creation_order() {
    let first_db = EphemeralDb::create().await.expect("first db");
    let second_db = EphemeralDb::create().await.expect("second db");
    // `audit_logs` and `signing_keys` have no foreign keys in either direction,
    // so recreating them while the database is empty cannot break a reference.
    move_table_to_the_end(&second_db.url, "audit_logs").await;
    move_table_to_the_end(&second_db.url, "signing_keys").await;

    let first = state(&first_db.url).await;
    let second = state(&second_db.url).await;
    orbitid_identity::testing::create_test_user(&first, "round@transfer.test", "Sup3rSecret!")
        .await
        .expect("user");

    let forward = temp_file();
    let forward_text = forward.to_string_lossy().to_string();
    export_database(&first, &forward_text, &|_| {})
        .await
        .expect("first export");
    let first_order = exported_table_order(&forward);

    let second_probe = temp_file();
    let second_probe_text = second_probe.to_string_lossy().to_string();
    export_database(&second, &second_probe_text, &|_| {})
        .await
        .expect("second probe export");
    let second_order = exported_table_order(&second_probe);
    assert_ne!(
        first_order, second_order,
        "the two databases list independent tables in different physical orders"
    );

    let imported = import_database(&second, &forward_text, false, false, &|_| {})
        .await
        .expect("import into the reordered database");
    assert!(imported.ok);

    // Export from the reordered database and load it back into the first one.
    let back = temp_file();
    let back_text = back.to_string_lossy().to_string();
    export_database(&second, &back_text, &|_| {})
        .await
        .expect("export back");
    let restored = import_database(&first, &back_text, true, true, &|_| {})
        .await
        .expect("import back with the other database's order");
    assert!(restored.ok);

    let client = TestClient::new(orbitid_server::build_app(first.clone()));
    let response = client
        .post(
            "/v1/client/sign_ins",
            Some(json!({
                "identifier": "round@transfer.test",
                "password": "Sup3rSecret!"
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.value()["response"]["status"], "complete");

    let _ = tokio::fs::remove_file(&forward).await;
    let _ = tokio::fs::remove_file(&second_probe).await;
    let _ = tokio::fs::remove_file(&back).await;
}

/// A real export from the retired TypeScript server, captured by running that
/// server's own `orbitid export` against a fresh Postgres database (user
/// `fixture@ts-export.test` with password `Sup3rSecret!`, an organization, one
/// browser session and the instance's signing key). Its header is the
/// TypeScript exporter's declaration order, which this port's discovery order
/// would never produce.
#[tokio::test]
async fn a_real_typescript_export_imports_and_signs_in() {
    let fixture =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_export.jsonl");
    let order = exported_table_order(&fixture);
    assert_eq!(
        order.first().map(String::as_str),
        Some("instance"),
        "the TypeScript exporter's declaration order starts with instance"
    );
    assert!(!order.iter().any(|table| table == "uploads"));

    let target_db = EphemeralDb::create().await.expect("target db");
    let target = state(&target_db.url).await;
    let imported = import_database(&target, &fixture.to_string_lossy(), false, false, &|_| {})
        .await
        .expect("a real TypeScript export imports");
    assert!(imported.ok);
    assert!(imported.counts.iter().all(|count| count.ok));

    let client = TestClient::new(orbitid_server::build_app(target.clone()));
    let response = client
        .post(
            "/v1/client/sign_ins",
            Some(json!({
                "identifier": "fixture@ts-export.test",
                "password": "Sup3rSecret!"
            })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.value()["response"]["status"], "complete");
}

/// Everything a migration run could change in a database: the ledger and the
/// column catalogue.
async fn schema_fingerprint(pool: &sqlx::PgPool) -> (Vec<(i64, Vec<u8>)>, Vec<String>) {
    let ledger = sqlx::query_as::<_, (i64, Vec<u8>)>(
        "SELECT version, checksum FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await
    .expect("ledger");
    let columns = sqlx::query_scalar::<_, String>(
        "SELECT table_name || '.' || column_name FROM information_schema.columns \
         WHERE table_schema = 'public' ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .expect("columns");
    (ledger, columns)
}

fn copy_env() -> EnvOverrides {
    EnvOverrides {
        node_env: Some("test".to_string()),
        encryption_key: Some(KEY.to_string()),
        data_dir: Some(std::env::temp_dir().join("orbitid-rs-copy")),
        ..Default::default()
    }
}

#[tokio::test]
async fn copy_never_writes_to_its_source() {
    let source_db = EphemeralDb::create().await.expect("source db");
    let target_db = EphemeralDb::create().await.expect("target db");
    let source = state(&source_db.url).await;
    orbitid_identity::testing::create_test_user(&source, "copy@transfer.test", "Sup3rSecret!")
        .await
        .expect("user");
    let before = schema_fingerprint(&source.pool).await;
    copy_database_with(
        copy_env(),
        &source_db.url,
        &target_db.url,
        false,
        false,
        &|_| {},
    )
    .await
    .expect("copy");
    assert_eq!(schema_fingerprint(&source.pool).await, before);
    let copied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state(&target_db.url).await.pool)
        .await
        .expect("count");
    assert_eq!(copied, 1);

    // A source behind this binary is refused with guidance and left as it was.
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 11")
        .execute(&source.pool)
        .await
        .expect("make it older");
    let behind = schema_fingerprint(&source.pool).await;
    let error = copy_database_with(
        copy_env(),
        &source_db.url,
        &target_db.url,
        true,
        true,
        &|_| {},
    )
    .await
    .expect_err("older source is refused");
    assert!(error.contains("orbitid migrate"), "{error}");
    assert_eq!(schema_fingerprint(&source.pool).await, behind);
}
