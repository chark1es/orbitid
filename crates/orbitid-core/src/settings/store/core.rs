use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use arc_swap::ArcSwap;
use serde_json::Value;
use sqlx::{PgConnection, PgPool};
use tokio::task::JoinHandle;

use crate::crypto;
use crate::error::{OrbitError, Result};
use crate::settings::policy::{assert_settings_usable, normalize_settings, DeliveryEnvironment};
use crate::settings::types::InstanceSettings;

use super::migration::{parse_settings, rescue_sessions_from_legacy_default};
use super::*;

/// Test seam: runs after the session rewrite and before the version marker is
/// persisted, so a test can simulate a crash in that window.
pub type UpgradeHook = Box<dyn Fn() -> std::result::Result<(), String> + Send + Sync>;

/// Consecutive refreshes that must read a database revision *below* the served
/// one before the store adopts the database value.
///
/// Settings writes hold the `instance` row lock and only ever increment
/// `revision`, so in normal operation the database value never moves backwards.
/// A single backwards read can still be a transient race (a refresh that hit a
/// lagging standby, an import committing between two reads), and adopting it
/// would roll a live replica's settings back. Two consecutive observations mean
/// the database itself went backwards (restored from an older backup, or the
/// row replaced by an import), and serving the in-memory snapshot forever would
/// then be wrong.
const STALE_REVISION_REFRESHES_BEFORE_ADOPT: u32 = 2;

/// Epoch milliseconds on the database clock. `instance.updated_at` is only
/// informational (publication is ordered by `revision`), but taking it from
/// Postgres keeps it consistent no matter how the replicas' clocks disagree.
const DB_NOW_MS: &str = "(extract(epoch FROM clock_timestamp()) * 1000)::bigint";

#[derive(Default)]
pub struct SettingsStoreOptions {
    pub connect_options: sqlx::postgres::PgConnectOptions,
    pub encryption_key: String,
    pub node_env: String,
    pub production: bool,
    pub env: DeliveryEnvironment,
    pub after_session_rewrite: Option<UpgradeHook>,
}

pub struct SettingsStore {
    pub(super) pool: PgPool,
    pub(super) encryption_key: String,
    pub(super) node_env: String,
    pub(super) production: bool,
    pub(super) env: DeliveryEnvironment,
    pub(super) cache: ArcSwap<InstanceSettings>,
    /// `instance.revision` of the snapshot currently served. Publication is
    /// ordered by this database-assigned counter alone, never by a host clock,
    /// so a later commit always carries a greater revision however skewed the
    /// writers' clocks are. A snapshot replaces the served one only when its
    /// revision is greater; an equal revision is the same row content.
    pub(super) published_revision: AtomicI64,
    /// Consecutive refreshes that read a revision below `published_revision`;
    /// see [`STALE_REVISION_REFRESHES_BEFORE_ADOPT`].
    pub(super) stale_revision_refreshes: AtomicU32,
    pub(super) listener: Mutex<Option<JoinHandle<()>>>,
    /// Serialises this replica's writers so a committed value is published in
    /// commit order (the database row lock orders writers across replicas).
    pub(super) write_lock: tokio::sync::Mutex<()>,
    /// Held across a reload's read and store, and across every publish, so the
    /// revision comparison in `store_snapshot_locked` cannot interleave with a
    /// newer read or publication.
    pub(super) publish_lock: tokio::sync::Mutex<()>,
}

impl Drop for SettingsStore {
    fn drop(&mut self) {
        if let Ok(mut handle) = self.listener.lock() {
            if let Some(handle) = handle.take() {
                handle.abort();
            }
        }
    }
}

/// Opens sealed values and applies the versioned migration to a stored tree.
fn decode_migrated(encryption_key: &str, raw: Value) -> MigratedSettings {
    let opened = if encryption_key.is_empty() {
        raw
    } else {
        crate::secrets::open_secrets_tree(encryption_key, raw)
    };
    migrate_stored_settings(opened)
}

/// Seals a stored tree and stamps the current version marker.
fn sealed_tree(encryption_key: &str, stored: &InstanceSettings) -> Value {
    let mut tree = crate::secrets::seal_secrets(encryption_key, stored);
    if let Value::Object(map) = &mut tree {
        map.insert(
            SETTINGS_VERSION_KEY.into(),
            Value::from(CURRENT_SETTINGS_VERSION),
        );
    }
    tree
}

fn default_settings(production: bool) -> Result<InstanceSettings> {
    let mut settings = InstanceSettings::default();
    if production {
        let patch = serde_json::json!({
            "application": { "developmentMode": false, "allowedOrigins": [] }
        });
        settings = parse_settings(&deep_merge(
            serde_json::to_value(&settings).unwrap_or(Value::Null),
            patch,
        ))?;
    }
    Ok(settings)
}

/// Takes the row lock that serialises every settings writer — inside one
/// transaction, on every replica.
///
/// A missing row is created with `INSERT … ON CONFLICT DO NOTHING` and then
/// re-read under the lock, so two replicas starting on an empty database both
/// succeed and merge onto the row the winner inserted. The returned revision is
/// the version of the snapshot that was read: freshly created rows start at
/// revision 0, and the first write publishes revision 1.
async fn lock_instance(
    conn: &mut PgConnection,
    encryption_key: &str,
    production: bool,
) -> Result<(Value, i64)> {
    let select = "SELECT settings, revision FROM instance WHERE id = 'default' FOR UPDATE";
    if let Some(row) = sqlx::query_as::<_, (Value, i64)>(select)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(row);
    }
    let settings = default_settings(production)?;
    let tree = sealed_tree(encryption_key, &settings);
    let insert = format!(
        "INSERT INTO instance (id, settings, created_at, updated_at) \
         VALUES ('default', $1, {DB_NOW_MS}, {DB_NOW_MS}) ON CONFLICT (id) DO NOTHING"
    );
    sqlx::query(&insert)
        .bind(sqlx::types::Json(tree))
        .execute(&mut *conn)
        .await?;
    sqlx::query_as::<_, (Value, i64)>(select)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| OrbitError::internal("Could not initialize instance settings"))
}

impl SettingsStore {
    /// Served settings, cheap and synchronous.
    pub fn get(&self) -> Arc<InstanceSettings> {
        self.cache.load_full()
    }

    /// The mail transport the resolver would pick right now, counting the
    /// `ORBITID_RESEND_API_KEY` / `ORBITID_SMTP_URL` fallbacks the dashboard
    /// cannot see. `Console` means mail is not delivered.
    pub fn effective_email_provider(&self) -> crate::settings::types::EmailProvider {
        crate::settings::policy::effective_email_provider(&self.get(), &self.env)
    }

    /// Reads the row and returns its database-assigned revision plus the stored
    /// tree in its validated, opened form.
    async fn read_snapshot(&self) -> Result<Option<(i64, InstanceSettings)>> {
        let row = sqlx::query_as::<_, (Value, i64)>(
            "SELECT settings, revision FROM instance WHERE id = 'default'",
        )
        .fetch_optional(&self.pool)
        .await?;
        let Some((raw, revision)) = row else {
            return Ok(None);
        };
        let migrated = decode_migrated(&self.encryption_key, raw);
        parse_settings(&migrated.settings).map(|settings| Some((revision, settings)))
    }

    /// Refreshes the served settings from the database.
    ///
    /// The read and the store happen under `publish_lock`, and the revision only
    /// ever moves forward in normal operation, so a reload that started before a
    /// newer update can neither publish over it nor publish a snapshot older
    /// than the row already served.
    ///
    /// A revision that is *behind* the served one means the database itself went
    /// backwards (restored from an older backup, or the row was replaced by an
    /// import). The store then adopts the database value, but only after
    /// [`STALE_REVISION_REFRESHES_BEFORE_ADOPT`] consecutive refreshes observed
    /// it, so a single lagging read cannot roll a live replica back.
    pub(super) async fn reload(&self) {
        let _publish = self.publish_lock.lock().await;
        let Ok(Some((revision, stored))) = self.read_snapshot().await else {
            return;
        };
        let published = self.published_revision.load(Ordering::SeqCst);
        if revision >= published {
            self.stale_revision_refreshes.store(0, Ordering::SeqCst);
            self.store_snapshot_locked(revision, stored);
            return;
        }
        let observed = self.stale_revision_refreshes.fetch_add(1, Ordering::SeqCst) + 1;
        if observed < STALE_REVISION_REFRESHES_BEFORE_ADOPT {
            tracing::warn!(
                database_revision = revision,
                published_revision = published,
                "settings revision is behind the served snapshot; waiting for one more refresh before adopting the database value"
            );
            return;
        }
        tracing::warn!(
            database_revision = revision,
            published_revision = published,
            "settings revision stayed behind the served snapshot; adopting the database value (was the database restored from an older backup, or the row replaced by an import?)"
        );
        self.stale_revision_refreshes.store(0, Ordering::SeqCst);
        let mut served = stored;
        normalize_settings(&mut served);
        self.published_revision.store(revision, Ordering::SeqCst);
        self.cache.store(Arc::new(served));
    }

    /// Stores a snapshot whose revision is strictly greater than the served one.
    /// The caller holds `publish_lock` (or is the only publisher during
    /// construction). An equal revision is the same row content, so publishing
    /// it is a no-op; a lower revision never replaces a newer snapshot.
    pub(super) fn store_snapshot_locked(&self, revision: i64, stored: InstanceSettings) -> bool {
        if revision <= self.published_revision.load(Ordering::SeqCst) {
            return false;
        }
        let mut served = stored;
        normalize_settings(&mut served);
        self.published_revision.store(revision, Ordering::SeqCst);
        self.cache.store(Arc::new(served));
        true
    }

    /// Test seam for the reload/update interleaving: reads a snapshot without
    /// publishing it, so a test can publish it after a newer update.
    #[cfg(feature = "test-util")]
    pub async fn read_snapshot_for_tests(&self) -> Option<(i64, InstanceSettings)> {
        self.read_snapshot().await.ok().flatten()
    }

    /// Test seam: publishes an already-read snapshot through the same monotonic
    /// guard a reload uses.
    #[cfg(feature = "test-util")]
    pub async fn publish_snapshot_for_tests(&self, revision: i64, served: InstanceSettings) {
        let _publish = self.publish_lock.lock().await;
        self.store_snapshot_locked(revision, served);
    }

    /// Test seam: runs exactly one refresh cycle, the way the periodic refresh
    /// and a `LISTEN/NOTIFY` wake-up do.
    #[cfg(feature = "test-util")]
    pub async fn refresh_for_tests(&self) {
        self.reload().await;
    }

    /// Applies a deep-merged patch, validates the served result and persists it.
    pub async fn update(&self, patch: Value) -> Result<Arc<InstanceSettings>> {
        self.mutate_and_store(move |stored| {
            let base = serde_json::to_value(&stored)
                .map_err(|_| OrbitError::internal("Internal server error"))?;
            parse_settings(&deep_merge(base, patch))
        })
        .await
    }

    /// Removes providers entirely (used when a provider's credentials are cleared).
    pub async fn remove_social_providers(&self, keys: &[String]) -> Result<Arc<InstanceSettings>> {
        self.mutate_and_store(|stored| {
            let mut next = stored;
            for key in keys {
                next.social.remove(key);
            }
            Ok(next)
        })
        .await
    }

    /// Runs `mutate` on the database's current settings inside a row lock,
    /// writes the result and commits before publishing it to this replica.
    ///
    /// Merging onto the locked database value (not a process-local copy) is
    /// what makes concurrent writes from several replicas lose nothing.
    async fn mutate_and_store<F>(&self, mutate: F) -> Result<Arc<InstanceSettings>>
    where
        F: FnOnce(InstanceSettings) -> Result<InstanceSettings>,
    {
        // The database row lock orders writers across replicas; this lock keeps
        // this replica's commits and cache publications in the same order.
        let _writer = self.write_lock.lock().await;
        let mut tx = self.pool.begin().await?;
        let outcome: Result<(i64, InstanceSettings)> = async {
            let (raw, _) = lock_instance(&mut tx, &self.encryption_key, self.production).await?;
            let migrated = decode_migrated(&self.encryption_key, raw);
            if migrated.lifetime_converted {
                rescue_sessions_from_legacy_default(&mut tx).await?;
            }
            let stored = parse_settings(&migrated.settings)?;
            let next = mutate(stored)?;
            let mut served = next.clone();
            // Validate what would actually be served: disabled features have lost
            // their sub-switches, so an inert stored flag is not an error.
            normalize_settings(&mut served);
            assert_settings_usable(&mut served, &self.node_env, &self.env)?;

            let tree = sealed_tree(&self.encryption_key, &next);
            // The row lock is already held; incrementing the revision in the same
            // statement is what makes the commit's version strictly greater than
            // every earlier commit, regardless of any writer's clock. `RETURNING`
            // gives us the exact revision and tree that committed.
            let update = format!(
                "UPDATE instance SET settings = $1, updated_at = {DB_NOW_MS}, \
             revision = revision + 1 WHERE id = 'default' RETURNING settings, revision"
            );
            let (committed_raw, committed_revision) = sqlx::query_as::<_, (Value, i64)>(&update)
                .bind(sqlx::types::Json(tree))
                .fetch_one(&mut *tx)
                .await?;
            let committed =
                parse_settings(&decode_migrated(&self.encryption_key, committed_raw).settings)?;
            Ok((committed_revision, committed))
        }
        .await;
        let (committed_revision, committed) = crate::db::finish_transaction(tx, outcome).await?;
        Ok(self.publish(committed_revision, committed).await)
    }
}

/// Creates the store, applies the versioned migration and starts the listener.
pub async fn create_settings_store(
    pool: PgPool,
    options: SettingsStoreOptions,
) -> Result<Arc<SettingsStore>> {
    create_settings_store_inner(pool, options, true).await
}

/// Creates the store without the `LISTEN/NOTIFY` listener or the periodic
/// refresh. Test-only: it makes "two consecutive refreshes" deterministic by
/// ruling out an autonomous reload between the caller's explicit ones.
#[cfg(feature = "test-util")]
pub async fn create_settings_store_without_refresher(
    pool: PgPool,
    options: SettingsStoreOptions,
) -> Result<Arc<SettingsStore>> {
    create_settings_store_inner(pool, options, false).await
}

async fn create_settings_store_inner(
    pool: PgPool,
    options: SettingsStoreOptions,
    with_refresher: bool,
) -> Result<Arc<SettingsStore>> {
    let encryption_key = options.encryption_key;
    if !encryption_key.is_empty() {
        // Pay scrypt once here, off the async worker, so request paths never do.
        let key = encryption_key.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = crypto::encrypt(&key, "");
        })
        .await;
    }

    let read = |raw: Value| -> MigratedSettings { decode_migrated(&encryption_key, raw) };

    let production = options.production;
    let mut tx = pool.begin().await?;
    let (raw, _) = lock_instance(&mut tx, &encryption_key, production).await?;
    let stored = {
        let migrated = read(raw);
        let settings = parse_settings(&migrated.settings)?;
        if migrated.changed {
            if migrated.lifetime_converted {
                rescue_sessions_from_legacy_default(&mut tx).await?;
            }
            if let Some(hook) = &options.after_session_rewrite {
                hook().map_err(OrbitError::internal)?;
            }
            // Persist the migrated tree once, version marker last. The migration
            // is a settings write, so it bumps the revision like any other: the
            // replicas that served the pre-migration tree then reload it.
            let tree = sealed_tree(&encryption_key, &settings);
            let update = format!(
                "UPDATE instance SET settings = $1, updated_at = {DB_NOW_MS}, \
                 revision = revision + 1 WHERE id = 'default'"
            );
            sqlx::query(&update)
                .bind(sqlx::types::Json(tree))
                .execute(&mut *tx)
                .await?;
        }
        settings
    };
    let (_, revision) = sqlx::query_as::<_, (Value, i64)>(
        "SELECT settings, revision FROM instance WHERE id = 'default'",
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut served = stored;
    normalize_settings(&mut served);
    let store = Arc::new(SettingsStore {
        pool,
        encryption_key,
        node_env: options.node_env,
        production,
        env: options.env,
        cache: ArcSwap::from_pointee(served),
        published_revision: AtomicI64::new(revision),
        stale_revision_refreshes: AtomicU32::new(0),
        listener: Mutex::new(None),
        write_lock: tokio::sync::Mutex::new(()),
        publish_lock: tokio::sync::Mutex::new(()),
    });
    if with_refresher {
        store.spawn_listener(options.connect_options.clone());
    }
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_merge_keeps_objects_and_skips_prototypes() {
        let base = serde_json::json!({ "a": { "b": 1, "c": 2 }, "d": 1 });
        let patch = serde_json::json!({ "a": { "b": 3 }, "__proto__": { "x": 1 }, "d": null });
        let merged = deep_merge(base, patch);
        assert_eq!(merged["a"]["b"], 3);
        assert_eq!(merged["a"]["c"], 2);
        assert!(merged["d"].is_null());
        assert!(merged.get("__proto__").is_none());
    }

    #[test]
    fn migration_converts_only_old_defaults() {
        let legacy = serde_json::json!({
            "session": { "lifetimeSeconds": 604800, "multiSession": false },
            "password": { "signOutOfOtherSessionsOnChange": true },
            "anonymous": { "retentionSeconds": 2592000 },
            "security": { "enumerationProtection": false }
        });
        let migrated = migrate_stored_settings(legacy);
        assert!(migrated.changed);
        assert!(migrated.lifetime_converted);
        assert_eq!(migrated.settings["session"]["lifetimeSeconds"], 0);
        assert_eq!(migrated.settings["session"]["multiSession"], true);
        assert_eq!(
            migrated.settings["password"]["signOutOfOtherSessionsOnChange"],
            false
        );
        assert_eq!(migrated.settings["anonymous"]["retentionSeconds"], 0);
        assert_eq!(migrated.settings["security"]["enumerationProtection"], true);
        assert_eq!(migrated.settings[SETTINGS_VERSION_KEY], 3);

        let custom = serde_json::json!({ "session": { "lifetimeSeconds": 3600 } });
        let migrated = migrate_stored_settings(custom);
        assert!(migrated.changed);
        assert!(!migrated.lifetime_converted);
        assert_eq!(migrated.settings["session"]["lifetimeSeconds"], 3600);

        // A version 2 tree only takes the version 3 conversion: a 7-day lifetime chosen since stays.
        let v2 = serde_json::json!({
            "__settingsVersion": 2,
            "session": { "lifetimeSeconds": 604800 },
            "security": { "enumerationProtection": false }
        });
        let migrated = migrate_stored_settings(v2);
        assert!(migrated.changed);
        assert!(!migrated.lifetime_converted);
        assert_eq!(migrated.settings["session"]["lifetimeSeconds"], 604800);
        assert_eq!(migrated.settings["security"]["enumerationProtection"], true);

        // Switched off again after the migration: left alone.
        let v3 = serde_json::json!({
            "__settingsVersion": 3,
            "security": { "enumerationProtection": false }
        });
        let migrated = migrate_stored_settings(v3);
        assert!(!migrated.changed);
        assert_eq!(
            migrated.settings["security"]["enumerationProtection"],
            false
        );
    }

    #[test]
    fn parse_error_names_the_field() {
        let error =
            parse_settings(&serde_json::json!({ "password": { "minLength": "x" } })).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert!(error
            .meta
            .as_ref()
            .and_then(|m| m.get("param_name"))
            .and_then(Value::as_str)
            .is_some_and(|p| p.starts_with("password")));
    }
}
