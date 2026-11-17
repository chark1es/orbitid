//! The background delivery loop. Safe to run on every replica: [`deliver_due`]
//! claims rows atomically with `FOR UPDATE SKIP LOCKED`, leases each batch just
//! before sending it, and only records a result while the lease is still owned.

use std::time::Duration;

use orbitid_core::state::AppState;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::delivery::deliver_due;

pub const WEBHOOK_WORKER_INTERVAL_MS: u64 = 2_000;

/// Handle to a running worker. Call [`WebhookWorker::shutdown`] for a clean stop;
/// dropping the handle aborts the task.
pub struct WebhookWorker {
    shutdown: watch::Sender<bool>,
    handle: JoinHandle<()>,
}

impl WebhookWorker {
    /// Starts the 2s delivery loop (one immediate tick first).
    pub fn start(state: AppState) -> Self {
        let (shutdown, mut receiver) = watch::channel(false);
        let handle = tokio::spawn(async move {
            loop {
                tick(&state).await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(WEBHOOK_WORKER_INTERVAL_MS)) => {}
                    changed = receiver.changed() => {
                        if changed.is_err() || *receiver.borrow() {
                            break;
                        }
                    }
                }
            }
        });
        Self { shutdown, handle }
    }

    /// Stops the loop after the current tick and waits for it to finish.
    pub async fn shutdown(mut self) {
        let _ = self.shutdown.send(true);
        let _ = (&mut self.handle).await;
    }
}

impl Drop for WebhookWorker {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.handle.abort();
    }
}

async fn tick(state: &AppState) {
    match deliver_due(state, None).await {
        Ok(_) => {}
        Err(error) => tracing::error!("[webhooks] worker tick failed: {error}"),
    }
}
