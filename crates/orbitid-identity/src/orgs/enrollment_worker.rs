//! Durable verified-domain enrollment.
//!
//! The transaction that verifies a domain, or switches it to
//! `automatic_invitation`, also sets `organization_domains.enrollment_pending_since`
//! (migration 0011). This module's worker resumes every pending domain from
//! `enrollment_cursor`, one chunk per transaction, persisting the cursor with
//! the chunk, and clears the marker only when a pass reaches the end. A request
//! timeout, a failed chunk or a replica restart therefore loses nothing: the
//! marker is still there on the next tick. Re-running is harmless because
//! existing members are skipped under the locks.
//!
//! One chunk is one transaction: domain advisory try-lock (so replicas never
//! process the same domain at once) → candidate page (unlocked, keyset) → users
//! `FOR KEY SHARE` ascending → organization → revalidate → enroll → cursor
//! update (domain row, after the organization, rank 9).
//!
//! **Fairness.** Pending domains are visited round-robin by the keyset
//! `(enrollment_pending_since, id)`; the last domain a tick attempted (whatever
//! its outcome) is persisted in `worker_cursors` (`enrollment_domains`), so the
//! next tick, on any replica, continues after it and wraps around. A domain
//! whose chunk keeps failing therefore cannot starve healthy ones, even with a
//! zero time budget (every tick attempts at least one domain).
//!
//! **Skipped users.** Inside a chunk each membership insert runs in a
//! savepoint; a user whose insert keeps failing for a non-retryable reason is
//! logged (`tracing::warn!` with domain and user id), counted in
//! [`EnrollmentTick::skipped`] and passed over, so the cursor advances and the
//! pass completes. The marker clears at the end of the pass; the skipped user
//! is picked up by their next email verification or the next mode toggle.
//! A full organization likewise ends the pass (the marker clears).
//!
//! **Stuck domains.** A chunk that fails (for example a deterministic outbox
//! failure) never discards a membership or the marker. The worker counts the
//! consecutive failures on the marker row (`enrollment_failures`, migration
//! 0012), stores the last error (`enrollment_last_error`) and does not attempt
//! the domain before `enrollment_next_attempt_at`: [`BACKOFF_BASE_MS`] doubling
//! per failure, capped at [`BACKOFF_CAP_MS`] (one hour). Each failure is logged
//! at `error` with the domain id; a successful chunk clears the three columns.
//! An operator finds stuck domains with
//! `SELECT id, enrollment_failures, enrollment_last_error FROM organization_domains
//! WHERE enrollment_failures > 0`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use orbitid_core::db::with_retry;
use orbitid_core::error::Result;
use orbitid_core::models::OrganizationDomainRow;
use orbitid_core::state::AppState;
use tokio::sync::Notify;

use super::enrollment::{
    domain_enrollment_user_ids_page_on, enroll_candidates_counted_on, ENROLLMENT_CHUNK,
};

/// Users enrolled inline by the request that changed the domain; the rest is
/// the worker's job.
pub const INLINE_ENROLLMENT_CHUNK: usize = 50;
const PENDING_PAGE: i64 = 100;
/// The wait after a domain's first consecutive chunk failure; doubles per failure.
pub const BACKOFF_BASE_MS: i64 = 30_000;
/// The longest wait between attempts of a failing domain.
pub const BACKOFF_CAP_MS: i64 = 3_600_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnrollmentTick {
    /// Chunks committed.
    pub chunks: u32,
    /// Memberships created.
    pub enrolled: i64,
    /// Domains whose pass reached the end.
    pub completed: u32,
    /// Chunks that failed (the domain stays pending).
    pub failed: u32,
    /// Users passed over because their membership insert failed.
    pub skipped: u32,
}

const DOMAIN_CURSOR: &str = "enrollment_domains";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChunkOutcome {
    Progress {
        added: i64,
        done: bool,
        skipped: u32,
    },
    /// Another replica is processing this domain right now.
    Busy,
    /// The marker was already cleared or the domain is gone.
    Idle,
}

struct Signal(Arc<Notify>);

fn signal(state: &AppState) -> Arc<Notify> {
    state
        .extensions
        .get_or_insert(|| Signal(Arc::new(Notify::new())))
        .0
        .clone()
}

/// Called by a handler after it committed a domain change (and its marker).
/// Enrolls at most [`INLINE_ENROLLMENT_CHUNK`] users inline, logs (never
/// returns) a failure because the marker keeps the work durable, and wakes the
/// worker for the remainder.
pub async fn kick_domain_enrollment(state: &AppState, domain: &OrganizationDomainRow) {
    if !domain.verified || domain.enrollment_mode != "automatic_invitation" {
        return;
    }
    let result = with_retry("domain_enrollment_inline", |_| {
        enroll_pending_chunk(state, &domain.id, INLINE_ENROLLMENT_CHUNK)
    })
    .await;
    if let Err(error) = result {
        tracing::warn!(domain_id = %domain.id, code = %error.code, "inline domain enrollment failed; the worker will resume it");
    }
    signal(state).notify_one();
}

/// One chunk for one pending domain.
async fn enroll_pending_chunk(
    state: &AppState,
    domain_id: &str,
    chunk_size: usize,
) -> Result<ChunkOutcome> {
    let mut tx = state.pool.begin().await?;
    let outcome = enroll_pending_chunk_on(&mut tx, state, domain_id, chunk_size).await;
    // Every exit but a committed chunk rolls back explicitly. A dropped sqlx
    // transaction queues its rollback and the pool flushes it when it returns
    // the connection (a spawned task), so locks are released shortly after the
    // drop anyway; the awaited rollback is defence in depth that guarantees
    // they are gone before the retry or the next tick needs them.
    match outcome {
        Ok(progress @ ChunkOutcome::Progress { .. }) => {
            // A failed COMMIT needs no explicit rollback: `commit` consumes the
            // transaction and the server has already ended it (locks released).
            tx.commit().await?;
            Ok(progress)
        }
        other => {
            let _ = tx.rollback().await;
            other
        }
    }
}

async fn enroll_pending_chunk_on(
    tx: &mut sqlx::PgConnection,
    state: &AppState,
    domain_id: &str,
    chunk_size: usize,
) -> Result<ChunkOutcome> {
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('orbitid_enrollment:' || $1, 0))",
    )
    .bind(domain_id)
    .fetch_one(&mut *tx)
    .await?;
    if !acquired {
        return Ok(ChunkOutcome::Busy);
    }
    let domain = sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE id = $1",
    )
    .bind(domain_id)
    .fetch_optional(&mut *tx)
    .await?;
    let progress: Option<(Option<i64>, String)> = sqlx::query_as(
        "SELECT enrollment_pending_since, enrollment_cursor FROM organization_domains WHERE id = $1",
    )
    .bind(domain_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (Some(domain), Some((Some(since), cursor))) = (domain, progress) else {
        return Ok(ChunkOutcome::Idle);
    };
    let eligible = domain.verified && domain.enrollment_mode == "automatic_invitation";
    let candidates = if eligible {
        domain_enrollment_user_ids_page_on(&mut *tx, &domain, &cursor, chunk_size).await?
    } else {
        Vec::new()
    };
    let chunk = enroll_candidates_counted_on(&mut *tx, state, &domain, &candidates, true).await?;
    let (added, full) = (chunk.added, chunk.full);
    let done = !eligible || full || candidates.len() < chunk_size;
    let next = candidates.last().cloned().unwrap_or(cursor.clone());
    // Rank 8 before the domain row (rank 9), also when the chunk had no users.
    crate::locks::lock_organization_on(&mut *tx, &domain.organization_id).await?;
    sqlx::query(
        "UPDATE organization_domains SET \
           enrollment_pending_since = CASE WHEN $1 THEN NULL ELSE enrollment_pending_since END, \
           enrollment_cursor = CASE WHEN $1 THEN '' ELSE $2 END, \
           enrollment_failures = NULL, enrollment_last_error = NULL, \
           enrollment_next_attempt_at = NULL \
         WHERE id = $3 AND enrollment_pending_since = $4 AND enrollment_cursor = $5",
    )
    .bind(done)
    .bind(&next)
    .bind(domain_id)
    .bind(since)
    .bind(&cursor)
    .execute(&mut *tx)
    .await?;
    Ok(ChunkOutcome::Progress {
        added,
        done,
        skipped: chunk.skipped.len() as u32,
    })
}

/// Pending domains in round-robin order: those after `after` first, then the
/// ones at or before it (wrap-around).
async fn pending_domain_ids(
    state: &AppState,
    skip: &[String],
    after: &(i64, String),
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM organization_domains WHERE enrollment_pending_since IS NOT NULL \
         AND id <> ALL($1) \
         AND (enrollment_next_attempt_at IS NULL OR enrollment_next_attempt_at <= $5) \
         ORDER BY ((enrollment_pending_since, id) <= ($2::bigint, $3::text)), \
                  enrollment_pending_since, id LIMIT $4",
    )
    .bind(skip)
    .bind(after.0)
    .bind(&after.1)
    .bind(PENDING_PAGE)
    .bind(orbitid_core::http::now())
    .fetch_all(&state.pool)
    .await?)
}

/// Counts a failed chunk on the marker row and schedules the next attempt
/// (exponential back-off from the previous failure count, capped). Best effort:
/// a failure here is logged, the domain simply stays eligible. Guarded on the
/// `enrollment_pending_since` the chunk ran under (as the chunk write is), so a
/// failure that outlives an operator's re-arm adds no back-off to the reset domain.
async fn record_failure(
    state: &AppState,
    domain_id: &str,
    since: i64,
    error: &orbitid_core::error::OrbitError,
) {
    let message: String = format!("{}: {}", error.code, error.message)
        .chars()
        .take(500)
        .collect();
    let result = sqlx::query(
        "UPDATE organization_domains SET \
           enrollment_failures = COALESCE(enrollment_failures, 0) + 1, \
           enrollment_last_error = $2, \
           enrollment_next_attempt_at = $3::bigint + LEAST($5::bigint, \
             $4::bigint * (1::bigint << LEAST(COALESCE(enrollment_failures, 0), 20))) \
         WHERE id = $1 AND enrollment_pending_since = $6",
    )
    .bind(domain_id)
    .bind(&message)
    .bind(orbitid_core::http::now())
    .bind(BACKOFF_BASE_MS)
    .bind(BACKOFF_CAP_MS)
    .bind(since)
    .execute(&state.pool)
    .await;
    if let Err(record_error) = result {
        tracing::error!(domain_id = %domain_id, "could not record the enrollment failure: {record_error}");
    }
}

/// The scheduling position of domain `id`, if it is still pending.
async fn position_of(state: &AppState, id: &str) -> Option<(i64, String)> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT enrollment_pending_since FROM organization_domains WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(
        |error| tracing::warn!(domain_id = %id, "could not read the enrollment position: {error}"),
    )
    .ok()
    .flatten()
    .flatten()
    .map(|since| (since, id.to_string()))
}

/// One worker tick: round-robin over the pending domains, one chunk each per
/// round, until nothing is pending or `budget` is spent (the first chunk always
/// runs; a chunk already started may overshoot the budget). A domain whose
/// chunk fails, or that another replica holds, is skipped for the rest of the
/// tick and stays pending. The tick starts after the domain the previous tick
/// attempted last (`worker_cursors`), so a permanently failing domain cannot
/// starve the others.
pub async fn run_enrollment_tick(
    state: &AppState,
    budget: Duration,
    chunk_size: usize,
) -> Result<EnrollmentTick> {
    let chunk_size = chunk_size.max(1);
    let deadline = Instant::now() + budget;
    let mut tick = EnrollmentTick::default();
    let mut skip: Vec<String> = Vec::new();
    let mut first = true;
    let mut after = crate::worker_cursor::load(state, DOMAIN_CURSOR)
        .await
        .and_then(|value| crate::worker_cursor::pair_from_json(&value))
        .unwrap_or((i64::MIN, String::new()));
    loop {
        let ids = pending_domain_ids(state, &skip, &after).await?;
        if ids.is_empty() {
            return Ok(tick);
        }
        for id in ids {
            if !first && Instant::now() >= deadline {
                return Ok(tick);
            }
            first = false;
            // The marker the chunk runs under: a failure is only recorded
            // against this same arming (see `record_failure`).
            let armed_since = position_of(state, &id).await.map(|position| {
                after = position.clone();
                position.0
            });
            let json = crate::worker_cursor::pair_to_json(after.0, &after.1);
            crate::worker_cursor::save(state, DOMAIN_CURSOR, Some(&json)).await;
            let outcome = with_retry("domain_enrollment_chunk", |_| {
                enroll_pending_chunk(state, &id, chunk_size)
            })
            .await;
            match outcome {
                Ok(ChunkOutcome::Progress {
                    added,
                    done,
                    skipped,
                }) => {
                    tick.chunks += 1;
                    tick.enrolled += added;
                    tick.skipped += skipped;
                    if done {
                        tick.completed += 1;
                    }
                }
                Ok(ChunkOutcome::Busy) => skip.push(id),
                Ok(ChunkOutcome::Idle) => {}
                Err(error) => {
                    tracing::error!(domain_id = %id, code = %error.code, "domain enrollment chunk failed; it stays pending and is retried with back-off");
                    if let Some(since) = armed_since {
                        record_failure(state, &id, since, &error).await;
                    }
                    tick.failed += 1;
                    skip.push(id);
                }
            }
            tokio::task::yield_now().await;
        }
    }
}

/// A handle for the enrollment worker. Dropping it aborts the task.
#[derive(Debug)]
pub struct EnrollmentWorker {
    handle: tokio::task::JoinHandle<()>,
}

impl EnrollmentWorker {
    pub fn abort(&self) {
        self.handle.abort();
    }
}

impl Drop for EnrollmentWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Starts the worker: a tick at start (resuming work left by a previous
/// process), then on every interval and every [`kick_domain_enrollment`].
pub fn start_enrollment_worker(state: AppState, interval_ms: u64) -> EnrollmentWorker {
    let wake = signal(&state);
    let handle = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(interval_ms.max(1)));
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = wake.notified() => {}
            }
            let budget = Duration::from_millis(state.env.retention_budget_ms);
            match run_enrollment_tick(&state, budget, ENROLLMENT_CHUNK).await {
                Ok(tick) if tick != EnrollmentTick::default() => {
                    tracing::info!("[enrollment] {tick:?}");
                }
                Ok(_) => {}
                Err(error) => tracing::error!("[enrollment] tick failed: {error}"),
            }
        }
    });
    EnrollmentWorker { handle }
}
