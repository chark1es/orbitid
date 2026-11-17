//! The `LISTEN/NOTIFY` listener plus periodic refresh fallback.

use std::sync::Arc;

use super::core::SettingsStore;
use super::migration::{REFRESH_INTERVAL_SECONDS, SETTINGS_CHANNEL};

impl SettingsStore {
    pub(super) fn spawn_listener(
        self: &Arc<Self>,
        connect_options: sqlx::postgres::PgConnectOptions,
    ) {
        let weak = Arc::downgrade(self);
        let handle = tokio::spawn(async move {
            let mut listener: Option<sqlx::postgres::PgListener> = None;
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(REFRESH_INTERVAL_SECONDS));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                let Some(store) = weak.upgrade() else {
                    return;
                };
                if listener.is_none() {
                    match connect_listener(&connect_options).await {
                        Ok(mut candidate) => {
                            if candidate.listen(SETTINGS_CHANNEL).await.is_ok() {
                                listener = Some(candidate);
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "settings listener could not connect; using periodic refresh")
                        }
                    }
                }
                if let Some(active) = listener.as_mut() {
                    tokio::select! {
                        message = active.recv() => {
                            match message {
                                Ok(notification) => {
                                    if store.notification_is_newer(notification.payload()) {
                                        store.reload().await;
                                    }
                                }
                                Err(error) => {
                                    tracing::warn!(error = %error, "settings listener lost; reconnecting");
                                    listener = None;
                                }
                            }
                        }
                        _ = interval.tick() => store.reload().await,
                    }
                } else {
                    interval.tick().await;
                    store.reload().await;
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                drop(store);
            }
        });
        if let Ok(mut slot) = self.listener.lock() {
            *slot = Some(handle);
        }
    }
}

/// Like `PgListener::connect(url)`, from connection options: a private pool of
/// one connection (no lifetime or idle timeout) that only serves reconnects, so
/// the listener never takes a connection from the application pool.
async fn connect_listener(
    options: &sqlx::postgres::PgConnectOptions,
) -> Result<sqlx::postgres::PgListener, sqlx::Error> {
    let pool = sqlx::pool::PoolOptions::<sqlx::Postgres>::new()
        .max_connections(1)
        .max_lifetime(None)
        .idle_timeout(None)
        .connect_with(options.clone())
        .await?;
    let mut listener = sqlx::postgres::PgListener::connect_with(&pool).await?;
    listener.ignore_pool_close_event(true);
    Ok(listener)
}
