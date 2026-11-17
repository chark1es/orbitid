//! Guest-account cleanup: anonymous users idle longer than
//! `settings.anonymous.retentionSeconds` are deleted, but only once no live
//! session remains. Ported from `services/anonymous.ts`.

use orbitid_core::db::with_retry;
use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::state::AppState;
use std::time::{Duration, Instant};

/// Rows deleted per tick: a large backlog is worked off over several ticks.
pub const ANONYMOUS_CLEANUP_BATCH: i64 = 100;
pub const ANONYMOUS_CLEANUP_INTERVAL_MS: u64 = 5 * 60_000;

const STALE_PREDICATE: &str = "u.is_anonymous = true AND u.last_active_at < $1 \
     AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id \
                     AND s.status IN ('active', 'pending'))";

/// Deletes one batch of stale anonymous users, **one transaction per
/// candidate**. Each candidate is re-checked under the user lock and removed
/// through [`crate::users::delete_user_on`], so a guest who upgraded or was
/// active between the read and the delete is never touched, and the
/// organization lifecycle (`on_user_deleted_on`) runs *before* the delete inside
/// that candidate's transaction — exactly like any other user deletion. The
/// `user.deleted` event and the avatar upload rows commit with it.
///
/// Holding one candidate's locks (clients, user, organizations, memberships,
/// sessions, uploads) while taking the next guest's client rows would invert the
/// global lock order across candidates; a per-candidate transaction keeps every
/// candidate in rank order and lets it fail independently. Returns the number of
/// users deleted.
pub async fn cleanup_anonymous_users(
    state: &AppState,
    at: Option<i64>,
    limit: Option<i64>,
) -> Result<i64> {
    let retention_seconds = state.settings.get().anonymous.retention_seconds;
    if retention_seconds <= 0 {
        return Ok(0);
    }
    let cutoff = at.unwrap_or_else(now) - retention_seconds * 1000;
    let limit = limit.unwrap_or(ANONYMOUS_CLEANUP_BATCH).max(1);
    Ok(run_cleanup(state, cutoff, limit, false).await?.deleted)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateOutcome {
    Deleted,
    Skipped,
    /// Another replica holds the cleanup advisory lock.
    Locked,
}

#[derive(Debug, Clone, Copy, Default)]
struct CleanupReport {
    deleted: i64,
    /// Another replica took the advisory lock; the rest of the tick is skipped.
    lock_held: bool,
}

/// One page of candidates, ordered by `(last_active_at, id)` and positioned
/// after a keyset cursor. The live-session exclusion is part of the predicate,
/// so protected guests never consume the `LIMIT` (the old query could return a
/// full batch of guests with active sessions and no deletable candidate).
async fn candidate_page(
    state: &AppState,
    cutoff: i64,
    after: Option<(&i64, &str)>,
    limit: i64,
) -> Result<Vec<(String, i64)>> {
    let sql = format!(
        "SELECT u.id, u.last_active_at FROM users u WHERE {STALE_PREDICATE} \
         AND (u.last_active_at, u.id) > ($2, $3) \
         ORDER BY u.last_active_at, u.id LIMIT $4"
    );
    let (after_activity, after_id) = after.unwrap_or((&i64::MIN, ""));
    Ok(sqlx::query_as(&sql)
        .bind(cutoff)
        .bind(after_activity)
        .bind(after_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?)
}

/// Name of the durable scan position in `worker_cursors` (migration 0011).
const CURSOR_NAME: &str = "anonymous_cleanup";

async fn load_cursor(state: &AppState) -> Option<(i64, String)> {
    crate::worker_cursor::pair_from_json(&crate::worker_cursor::load(state, CURSOR_NAME).await?)
}

async fn save_cursor(state: &AppState, cursor: Option<&(i64, String)>) {
    let value = cursor.map(|(at, id)| crate::worker_cursor::pair_to_json(*at, id));
    crate::worker_cursor::save(state, CURSOR_NAME, value.as_ref()).await;
}

/// The one loop both entry points use. `limit` is the number of guests one tick
/// may **delete**; failed and skipped candidates never consume it. The loop
/// pages with the keyset cursor past permanently failing guests (and guests
/// whose row another transaction holds) until it has deleted `limit` guests,
/// the candidates end, or the tick's time budget (`ORBITID_RETENTION_BUDGET_MS`,
/// the retention worker's budget) is spent. The first page always runs.
///
/// `durable` (the worker tick) additionally keeps the scan position in
/// `worker_cursors`: a tick that ends early (budget, deletion limit) stores the
/// last examined candidate and the next tick, on any replica or after a restart,
/// continues after it and wraps to the head at the end. A zero budget therefore
/// still examines a fresh page every tick, so a permanently failing head cannot
/// hide the guests behind it, tick after tick.
async fn run_cleanup(
    state: &AppState,
    cutoff: i64,
    limit: i64,
    durable: bool,
) -> Result<CleanupReport> {
    let deadline = Instant::now() + Duration::from_millis(state.env.retention_budget_ms);
    let mut report = CleanupReport::default();
    let mut cursor: Option<(i64, String)> = if durable {
        load_cursor(state).await
    } else {
        None
    };
    let mut resumed = cursor.is_some();
    let mut first = true;
    loop {
        // A page already started may overshoot the budget; it is only checked between pages.
        if !first && Instant::now() >= deadline {
            break;
        }
        first = false;
        let page = candidate_page(
            state,
            cutoff,
            cursor.as_ref().map(|(at, id)| (at, id.as_str())),
            limit,
        )
        .await?;
        let page_len = page.len() as i64;
        for (user_id, last_active_at) in page {
            cursor = Some((last_active_at, user_id.clone()));
            match delete_candidate(state, &user_id, cutoff).await {
                Ok(CandidateOutcome::Deleted) => {
                    report.deleted += 1;
                    if report.deleted >= limit {
                        if durable {
                            save_cursor(state, cursor.as_ref()).await;
                        }
                        return Ok(report);
                    }
                }
                Ok(CandidateOutcome::Skipped) => {}
                Ok(CandidateOutcome::Locked) => {
                    report.lock_held = true;
                    return Ok(report);
                }
                // One poisoned candidate must not abort the tick or the guest
                // behind it. Log it and keep paging with the keyset cursor.
                Err(error) => {
                    tracing::warn!("[anonymous] failed to delete guest {user_id}: {error}");
                }
            }
        }
        if page_len < limit {
            // The end of the candidates: wrap. A scan that resumed mid-way also
            // examines the head it skipped, within the remaining budget.
            if durable {
                save_cursor(state, None).await;
            }
            if !resumed {
                break;
            }
            resumed = false;
            cursor = None;
        } else if durable {
            save_cursor(state, cursor.as_ref()).await;
        }
    }
    Ok(report)
}

/// Deletes one stale guest in its own transaction, retried a bounded number of
/// times if it hits a retryable `40P01`/`40001`.
async fn delete_candidate(
    state: &AppState,
    user_id: &str,
    cutoff: i64,
) -> Result<CandidateOutcome> {
    with_retry("anonymous-cleanup", |_| {
        let state = state.clone();
        let user_id = user_id.to_string();
        async move { delete_candidate_once(&state, &user_id, cutoff).await }
    })
    .await
}

async fn delete_candidate_once(
    state: &AppState,
    user_id: &str,
    cutoff: i64,
) -> Result<CandidateOutcome> {
    let mut tx = state.pool.begin().await?;
    match delete_candidate_in(&mut tx, state, user_id, cutoff).await {
        Ok(outcome) => {
            if matches!(outcome, CandidateOutcome::Deleted) {
                tx.commit().await?;
            } else {
                tx.rollback().await?;
            }
            Ok(outcome)
        }
        Err(error) => {
            // Roll back explicitly: a dropped transaction only queues its
            // rollback, so the cleanup advisory lock would stay held by the
            // pooled connection and the next candidate would see `Locked`.
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

async fn delete_candidate_in(
    tx: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    cutoff: i64,
) -> Result<CandidateOutcome> {
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtext('orbitid_anonymous_cleanup')::bigint)",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !acquired {
        return Ok(CandidateOutcome::Locked);
    }
    // Rank 2 → 3: the guest's clients, then the user row. Re-check the whole
    // predicate under the lock (`delete_user_on` would otherwise remove a guest
    // that signed in meanwhile).
    crate::locks::lock_user_clients_then_user_on(&mut *tx, user_id).await?;
    let still_stale: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users u WHERE u.id = $1 \
         AND u.is_anonymous = true AND u.last_active_at < $2 \
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id \
                         AND s.status IN ('active', 'pending')))",
    )
    .bind(user_id)
    .bind(cutoff)
    .fetch_one(&mut *tx)
    .await?;
    if !still_stale {
        return Ok(CandidateOutcome::Skipped);
    }
    let deleted = crate::users::delete_user_on(&mut *tx, state, user_id)
        .await?
        .is_some();
    Ok(if deleted {
        CandidateOutcome::Deleted
    } else {
        CandidateOutcome::Skipped
    })
}

/// One worker tick: deletes one batch, one candidate per transaction, each
/// under the transaction-scoped advisory lock. A replica that finds the lock
/// held skips the rest of its tick, so two replicas never sweep concurrently.
///
/// The lock is tied to a candidate transaction rather than to the pooled
/// connection: if this future is cancelled the transaction is rolled back and
/// the lock released with it, so a cancelled tick cannot keep the next one
/// out. Returns `None` when another replica holds the lock.
pub async fn cleanup_tick(state: &AppState) -> Result<Option<i64>> {
    let retention_seconds = state.settings.get().anonymous.retention_seconds;
    if retention_seconds <= 0 {
        return Ok(Some(0));
    }
    let cutoff = now() - retention_seconds * 1000;
    let report = run_cleanup(state, cutoff, ANONYMOUS_CLEANUP_BATCH, true).await?;
    if report.lock_held {
        return Ok(None);
    }
    Ok(Some(report.deleted))
}

/// Ids of anonymous users that would be deleted now (tests/inspection only).
pub async fn stale_anonymous_user_ids(state: &AppState, at: Option<i64>) -> Result<Vec<String>> {
    let retention_seconds = state.settings.get().anonymous.retention_seconds;
    if retention_seconds <= 0 {
        return Ok(Vec::new());
    }
    let cutoff = at.unwrap_or_else(now) - retention_seconds * 1000;
    let sql = format!(
        "SELECT u.id FROM users u WHERE {STALE_PREDICATE} ORDER BY u.last_active_at, u.id LIMIT $2"
    );
    Ok(sqlx::query_scalar(&sql)
        .bind(cutoff)
        .bind(ANONYMOUS_CLEANUP_BATCH)
        .fetch_all(&state.pool)
        .await?)
}

/// A handle for the periodic cleanup task. Dropping it aborts the worker.
#[derive(Debug)]
pub struct AnonymousCleanupWorker {
    handle: tokio::task::JoinHandle<()>,
}

impl AnonymousCleanupWorker {
    pub fn abort(&self) {
        self.handle.abort();
    }
}

impl Drop for AnonymousCleanupWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Starts the periodic cleanup. A tick that fails is logged and retried on the
/// next interval; overlapping ticks are skipped.
pub fn start_anonymous_cleanup_worker(state: AppState, interval_ms: u64) -> AnonymousCleanupWorker {
    let handle = tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_millis(interval_ms.max(1)));
        // The first tick fires immediately; `cleanup` is idempotent.
        loop {
            ticker.tick().await;
            // Every replica runs the same sweep. The advisory lock lives inside
            // `cleanup_tick`'s transaction, so cancelling this task rolls the
            // transaction back and releases the lock instead of leaving it with
            // a pooled connection.
            match cleanup_tick(&state).await {
                Ok(_) => {}
                Err(error) => tracing::error!("[anonymous] cleanup tick failed: {error}"),
            }
        }
    });
    AnonymousCleanupWorker { handle }
}

#[cfg(all(test, feature = "test-util"))]
mod tests;
