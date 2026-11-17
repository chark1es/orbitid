//! Publication of a committed settings snapshot on this replica.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::core::SettingsStore;
use super::migration::SETTINGS_CHANNEL;
use crate::error::Result;
use crate::settings::types::InstanceSettings;

impl SettingsStore {
    /// Tells the other replicas which revision is now committed. The payload is
    /// an optimisation only: a listener that cannot parse it, or a missed
    /// notification, falls back to the 30 s refresh.
    fn notify(&self, revision: i64) -> Result<()> {
        let pool = self.pool.clone();
        // Fire-and-forget: a failed notification only costs the periodic refresh.
        tokio::spawn(async move {
            let _ = sqlx::query("SELECT pg_notify($1, $2)")
                .bind(SETTINGS_CHANNEL)
                .bind(revision.to_string())
                .execute(&pool)
                .await;
        });
        Ok(())
    }

    /// Makes a committed projection this replica's served settings and tells
    /// the others to reload.
    ///
    /// The returned snapshot is the one this write just committed, never
    /// whatever the cache holds. During a restored-database window the committed
    /// revision can be at or below the served one (the monotonic guard refuses
    /// to adopt it immediately), but the writer's own response must still
    /// describe its own commit.
    pub(super) async fn publish(
        &self,
        revision: i64,
        served: InstanceSettings,
    ) -> Arc<InstanceSettings> {
        let mut response = served.clone();
        crate::settings::normalize_settings(&mut response);
        {
            let _publish = self.publish_lock.lock().await;
            self.store_snapshot_locked(revision, served);
        }
        let _ = self.notify(revision);
        Arc::new(response)
    }

    /// The `LISTEN/NOTIFY` payload is the revision the writer committed. A
    /// payload at or below the served revision cannot contain anything new, so
    /// the wake-up can be skipped; an unparsable payload (any other publisher,
    /// an older server version) always reloads. Correctness never depends on the
    /// payload: the periodic refresh covers a skipped or missed notification.
    pub(super) fn notification_is_newer(&self, payload: &str) -> bool {
        match payload.trim().parse::<i64>() {
            Ok(revision) => revision > self.published_revision.load(Ordering::SeqCst),
            Err(_) => true,
        }
    }
}
