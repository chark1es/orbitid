//! Session expiry: mark sessions past their absolute or inactivity deadline
//! as `expired`, with the grant revocation and event the lazy read path writes.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;

use super::batches::{begin_sweep, finish_sweep};

/// Marks every session past its absolute `expire_at` (or past the configured
/// inactivity timeout) as `expired`, with the same grant revocation and
/// `session.ended` event the lazy read path in
/// `sessions::evaluate_session_status` performs, so the ordinary 90-day
/// deletion sweep can then remove it.
pub async fn expire_stale_sessions(state: &AppState, now_ms: i64, batch: i64) -> Result<i64> {
    let mut total = 0;
    let mut after = String::new();
    loop {
        let (count, full, last) = expire_stale_sessions_batch(state, now_ms, batch, &after).await?;
        total += count;
        after = last;
        if !full {
            return Ok(total);
        }
        tokio::task::yield_now().await;
    }
}

pub(super) async fn expire_stale_sessions_batch(
    state: &AppState,
    now_ms: i64,
    batch: i64,
    after: &str,
) -> Result<(i64, bool, String)> {
    let inactivity_ms = state.settings.get().session.inactivity_timeout_seconds * 1000;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM sessions \
         WHERE status IN ('active', 'pending') \
           AND (expire_at <= $1 OR ($2 > 0 AND last_active_at < $3)) \
         AND id > $5 ORDER BY id LIMIT $4",
    )
    .bind(now_ms)
    .bind(inactivity_ms)
    .bind(now_ms - inactivity_ms)
    .bind(batch.max(1))
    .bind(after)
    .fetch_all(&state.pool)
    .await?;
    if ids.is_empty() {
        return Ok((0, false, String::new()));
    }
    let last = ids.last().cloned().unwrap_or_default();
    // "Full" is a property of the candidate page, like every other drain: rows
    // that stopped matching under the lock (a concurrent change) still mean
    // there may be more candidates behind this page.
    let full = ids.len() as i64 >= batch;
    let Some(mut tx) = begin_sweep(state).await? else {
        return Ok((0, false, String::new()));
    };
    let outcome: Result<_> = async {
        let client_ids: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT client_id FROM sessions WHERE id = ANY($1) ORDER BY client_id",
        )
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        crate::locks::lock_clients_on(&mut tx, &client_ids).await?;
        let rows = sqlx::query_as::<_, orbitid_core::models::SessionRow>(
            "SELECT * FROM sessions WHERE id = ANY($1) \
         AND status IN ('active', 'pending') \
         AND (expire_at <= $2 OR ($3 > 0 AND last_active_at < $4)) \
         ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .bind(now_ms)
        .bind(inactivity_ms)
        .bind(now_ms - inactivity_ms)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            return Ok((0, full, last));
        }
        // The whole page in one savepoint; if it fails for a non-transient reason
        // the rows are expired one by one and a row that keeps failing is skipped,
        // so it cannot fail the batch (and the drain) forever.
        let mut expired = 0;
        match expire_rows_on(&mut tx, state, &rows, now_ms).await {
            Ok(count) => expired = count,
            Err(error) if error.is_retryable_transaction() => return Err(error),
            Err(error) => {
                tracing::warn!("[retention] expiry batch failed ({error}); isolating sessions");
                for row in &rows {
                    match expire_rows_on(&mut tx, state, std::slice::from_ref(row), now_ms).await {
                        Ok(count) => expired += count,
                        Err(error) if error.is_retryable_transaction() => return Err(error),
                        Err(error) => {
                            tracing::warn!("[retention] skipping session {}: {error}", row.id);
                        }
                    }
                }
            }
        }
        Ok((expired, full, last))
    }
    .await;
    finish_sweep(tx, outcome).await
}

/// Expires `rows` inside one savepoint (rolled back on failure).
async fn expire_rows_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    rows: &[orbitid_core::models::SessionRow],
    now_ms: i64,
) -> Result<i64> {
    let mut savepoint = sqlx::Connection::begin(&mut *conn).await?;
    let outcome = async {
        let expired_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
        sqlx::query("UPDATE sessions SET status = 'expired', updated_at = $1 WHERE id = ANY($2)")
            .bind(now_ms)
            .bind(&expired_ids)
            .execute(&mut *savepoint)
            .await?;
        crate::grants::revoke_grants_for_sessions_on(&mut savepoint, &expired_ids).await?;
        for row in rows {
            let mut updated = row.clone();
            updated.status = "expired".into();
            updated.updated_at = now_ms;
            crate::sessions::emit_session_event_on(
                &mut savepoint,
                state,
                "session.ended",
                &updated,
            )
            .await?;
        }
        Ok::<i64, orbitid_core::error::OrbitError>(expired_ids.len() as i64)
    }
    .await;
    match outcome {
        Ok(count) => {
            savepoint.commit().await?;
            Ok(count)
        }
        Err(error) => {
            let _ = savepoint.rollback().await;
            Err(error)
        }
    }
}
