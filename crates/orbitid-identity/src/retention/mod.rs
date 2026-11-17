//! Multi-replica-safe retention sweep for dead authentication rows.
//!
//! Every independent table is drained by [`batches`], each batch in its own
//! short transaction and in the global lock order (`docs/LOCK_ORDER.md`). A busy
//! foreground transaction can therefore never leave the sweep holding a lock
//! from one rank while it waits for a lower one. Candidate rows are selected
//! with `SKIP LOCKED` where skipping a busy row is harmless, so a worker does
//! not queue behind foreground traffic.
//!
//! One tick keeps draining full batches (yielding between them) under a runtime
//! budget, so a backlog is worked off quickly instead of growing forever at one
//! batch per hour. A batch that still hits a retryable `40P01`/`40001` is
//! retried a bounded number of times inside the same tick
//! ([`orbitid_core::db::with_retry`]); an operation that keeps failing is
//! logged and does not abort the other operations of that tick.
//!
//! Grace periods keep rows long enough for diagnostics and for reuse detection
//! (a revoked refresh token stays until its whole family expires). Sessions keep
//! their 90-day audit window; clients are kept for the `__client` cookie's full
//! lifetime plus the ordinary grace, so a live session-less browser is never
//! swept merely for being idle.

mod batches;
mod expiry;
mod isolate;
mod simple;

use std::time::{Duration, Instant};

use orbitid_core::db::with_retry;
use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::state::AppState;

use crate::worker_cursor;

use batches::RetentionOp;
pub use expiry::expire_stale_sessions;
use expiry::expire_stale_sessions_batch;

/// Default rows deleted per table per batch (`ORBITID_RETENTION_BATCH_SIZE`).
pub const RETENTION_BATCH: i64 = 500;
/// Default interval between retention ticks (`ORBITID_RETENTION_INTERVAL_MS`).
pub const RETENTION_INTERVAL_MS: u64 = 60 * 60 * 1000;
/// Default runtime budget for one tick (`ORBITID_RETENTION_BUDGET_MS`).
pub const RETENTION_BUDGET_MS: u64 = 30_000;

/// Dead rows are kept for a day so an operator can inspect recent failures.
pub const RETENTION_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

/// Ended/revoked/expired sessions are kept for 90 days (the documented audit
/// window) before the row is deleted. `active`/`pending` rows are never
/// touched.
pub const SESSION_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// A session-less client row must survive at least as long as a `__client`
/// cookie that references it can still be valid: the cookie's max-age plus the
/// ordinary grace. Anything shorter revoked a live browser merely for being
/// idle (a returning session-less client got 401 on its first non-GET).
pub const CLIENT_ORPHAN_GRACE_MS: i64 =
    orbitid_core::keys::COOKIE_MAX_AGE_SECONDS * 1000 + RETENTION_GRACE_MS;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetentionSweep {
    pub verifications: i64,
    pub oauth_grants: i64,
    pub device_codes: i64,
    pub oauth_states: i64,
    pub sign_ins: i64,
    pub sign_ups: i64,
    pub sessions: i64,
    pub sessions_expired: i64,
    pub clients: i64,
    pub webhook_deliveries: i64,
    pub webhook_events: i64,
    pub audit_logs: i64,
    pub uploads: i64,
}

/// Deletes every eligible row from every retained table, draining full batches
/// until each operation is empty or the configured per-tick budget is spent.
///
/// `at` is the clock (tests inject it); `limit` overrides the configured batch
/// size. Each operation and each batch runs in its own transaction under
/// `pg_try_advisory_xact_lock`, so concurrent replicas never duplicate a batch
/// and foreground traffic never shares a lock cycle with the sweep.
pub async fn sweep_once(
    state: &AppState,
    at: Option<i64>,
    limit: Option<i64>,
) -> Result<RetentionSweep> {
    sweep_with_budget(
        state,
        at,
        limit,
        Duration::from_millis(state.env.retention_budget_ms),
    )
    .await
}

/// [`sweep_once`] with an explicit runtime budget (tests use a zero budget to
/// prove that a tick stops between batches and the next tick continues).
pub async fn sweep_with_budget(
    state: &AppState,
    at: Option<i64>,
    limit: Option<i64>,
    budget: Duration,
) -> Result<RetentionSweep> {
    let now_ms = at.unwrap_or_else(now);
    let cutoff = now_ms - RETENTION_GRACE_MS;
    let client_cutoff = now_ms - CLIENT_ORPHAN_GRACE_MS;
    let session_cutoff = now_ms - SESSION_RETENTION_MS;
    let webhook_cutoff = retention_cutoff(now_ms, state.env.webhook_retention_days);
    let audit_cutoff = retention_cutoff(now_ms, state.env.audit_retention_days);
    let batch = limit.unwrap_or(state.env.retention_batch_size).max(1);
    // One deadline for the whole tick: every operation's first batch still runs
    // (guaranteed progress), later batches share the remaining time.
    let deadline = Instant::now() + budget;
    let mut sweep = RetentionSweep {
        verifications: drain(state, RetentionOp::Verifications, cutoff, batch, deadline).await,
        oauth_grants: drain(state, RetentionOp::OauthGrants, cutoff, batch, deadline).await,
        device_codes: drain(state, RetentionOp::DeviceCodes, cutoff, batch, deadline).await,
        oauth_states: drain(state, RetentionOp::OauthStates, cutoff, batch, deadline).await,
        sign_ins: drain(state, RetentionOp::SignIns, cutoff, batch, deadline).await,
        sign_ups: drain(state, RetentionOp::SignUps, cutoff, batch, deadline).await,
        sessions: drain(
            state,
            RetentionOp::Sessions,
            session_cutoff,
            batch,
            deadline,
        )
        .await,
        clients: drain(state, RetentionOp::Clients, client_cutoff, batch, deadline).await,
        ..RetentionSweep::default()
    };
    if let Some(cutoff) = webhook_cutoff {
        sweep.webhook_deliveries = drain(
            state,
            RetentionOp::WebhookDeliveries,
            cutoff,
            batch,
            deadline,
        )
        .await;
        sweep.webhook_events =
            drain(state, RetentionOp::WebhookEvents, cutoff, batch, deadline).await;
    }
    if let Some(cutoff) = audit_cutoff {
        sweep.audit_logs = drain(state, RetentionOp::AuditLogs, cutoff, batch, deadline).await;
    }
    sweep.uploads = drain(state, RetentionOp::Uploads, cutoff, batch, deadline).await;

    // Session expiry is its own transaction with its own lock order
    // (clients → sessions → grant families); see `expire_stale_sessions`.
    sweep.sessions_expired = drain_expiry(state, now_ms, batch, deadline).await;
    Ok(sweep)
}

/// Runs one operation until it exhausts its candidates or the budget is spent.
/// Errors are logged and turn into zero so one failing operation cannot abort
/// the rest of the tick.
///
/// Each batch reports the position of the last candidate it examined. Passing
/// that cursor to the next batch means a full page of rows that another
/// transaction holds is skipped rather than re-selected, so the backlog behind
/// it still drains and a fully locked page cannot spin until the budget expires.
async fn drain(
    state: &AppState,
    op: RetentionOp,
    cutoff: i64,
    batch: i64,
    deadline: Instant,
) -> i64 {
    // The position is also stored durably (`worker_cursors`): a tick that ends
    // early on its budget leaves it for the next tick, on any replica, so a
    // head of rows that cannot be deleted never hides the backlog behind it. At
    // the end of the candidates the scan wraps to the head once.
    let name = format!("retention:{}", op.label());
    let mut cursor: Option<batches::RetentionCursor> = worker_cursor::load(state, &name)
        .await
        .and_then(|value| worker_cursor::pair_from_json(&value));
    let mut resumed = cursor.is_some();
    let mut total = 0;
    let mut first = true;
    loop {
        // The first batch always runs so a tick makes progress even with a zero
        // budget; later batches yield to foreground traffic under the budget.
        // A batch already started may overshoot the budget; it is only checked between batches.
        if !first && Instant::now() >= deadline {
            break;
        }
        let batch_cursor = cursor.clone();
        let result = with_retry(op.label(), |_| {
            let state = state.clone();
            let cursor = batch_cursor.clone();
            async move { op.run(&state, cutoff, batch, cursor).await }
        })
        .await;
        first = false;
        match result {
            Ok((count, more, next)) => {
                total += count;
                match next.filter(|_| more) {
                    Some(position) => {
                        let json = worker_cursor::pair_to_json(position.0, &position.1);
                        worker_cursor::save(state, &name, Some(&json)).await;
                        cursor = Some(position);
                    }
                    None => {
                        worker_cursor::save(state, &name, None).await;
                        if !resumed {
                            break;
                        }
                        resumed = false;
                        cursor = None;
                        continue;
                    }
                }
            }
            Err(error) => {
                tracing::error!("[retention] {} failed after retries: {error}", op.label());
                break;
            }
        }
        tokio::task::yield_now().await;
    }
    total
}

async fn drain_expiry(state: &AppState, now_ms: i64, batch: i64, deadline: Instant) -> i64 {
    const NAME: &str = "retention:expiry";
    let mut after: String = worker_cursor::load(state, NAME)
        .await
        .and_then(|value| worker_cursor::pair_from_json(&value))
        .map(|(_, id)| id)
        .unwrap_or_default();
    let mut resumed = !after.is_empty();
    let mut total = 0;
    let mut first = true;
    loop {
        // A batch already started may overshoot the budget; it is only checked between batches.
        if !first && Instant::now() >= deadline {
            break;
        }
        let result = with_retry("retention.expire_stale_sessions", |_| {
            let state = state.clone();
            let after = after.clone();
            async move { expire_stale_sessions_batch(&state, now_ms, batch, &after).await }
        })
        .await;
        first = false;
        match result {
            Ok((count, full, last)) => {
                total += count;
                if full {
                    let json = worker_cursor::pair_to_json(0, &last);
                    worker_cursor::save(state, NAME, Some(&json)).await;
                    after = last;
                } else {
                    worker_cursor::save(state, NAME, None).await;
                    if !resumed {
                        break;
                    }
                    resumed = false;
                    after = String::new();
                    continue;
                }
            }
            Err(error) => {
                tracing::error!("[retention] expire_stale_sessions failed after retries: {error}");
                break;
            }
        }
        tokio::task::yield_now().await;
    }
    total
}

/// `None` keeps the rows forever (a zero retention setting).
fn retention_cutoff(now_ms: i64, days: u64) -> Option<i64> {
    if days == 0 {
        return None;
    }
    i64::try_from(days)
        .ok()
        .map(|days| now_ms - days.saturating_mul(24 * 60 * 60 * 1000))
}

/// A handle for the periodic retention task. Dropping it aborts the worker.
#[derive(Debug)]
pub struct RetentionWorker {
    handle: tokio::task::JoinHandle<()>,
}

impl RetentionWorker {
    pub fn abort(&self) {
        self.handle.abort();
    }
}

impl Drop for RetentionWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Starts the periodic sweep. Overlapping ticks are skipped and failures are
/// logged; the advisory lock makes every replica safe.
pub fn start_retention_worker(state: AppState, interval_ms: u64) -> RetentionWorker {
    let handle = tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_millis(interval_ms.max(1)));
        loop {
            ticker.tick().await;
            match sweep_once(&state, None, None).await {
                Ok(sweep) if sweep != RetentionSweep::default() => {
                    tracing::info!("[retention] swept {sweep:?}");
                }
                Ok(_) => {}
                Err(error) => tracing::error!("[retention] tick failed: {error}"),
            }
        }
    });
    RetentionWorker { handle }
}
