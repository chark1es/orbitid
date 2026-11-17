//! Generic single-table retention batch, shared by every table whose sweep is
//! one candidate page plus a locked delete.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;

use super::batches::{begin_sweep, finish_sweep, RetentionCursor};
use super::isolate::delete_isolating;

/// One single-table batch: select the candidate page **without** locking (so
/// "more work remains" is decided by the number of candidates, not by how many
/// a concurrent transaction holds), positioned after the drain cursor; then lock
/// the still-eligible unlocked rows with `SKIP LOCKED` and delete exactly those.
/// A full page of busy rows still advances the cursor, so the drain continues
/// past it instead of stopping or busy-looping on the same rows. The operation
/// runs in its own transaction, so it never holds a lower-rank lock while
/// waiting for this table.
#[allow(clippy::too_many_arguments)]
pub(super) async fn delete_simple(
    state: &AppState,
    table: &str,
    key: &str,
    predicate: &str,
    cutoff: i64,
    batch: i64,
    order_by: &str,
    after: Option<RetentionCursor>,
) -> Result<(i64, bool, Option<RetentionCursor>)> {
    let Some(mut tx) = begin_sweep(state).await? else {
        return Ok((0, false, None));
    };
    let outcome: Result<_> = async {
        // Every caller orders by `(time column, key)`, which is also the keyset
        // cursor. Splitting the static string keeps the SQL one statement.
        let (time_column, key_column) = order_by
            .split_once(',')
            .map(|(time, key)| (time.trim(), key.trim()))
            .unwrap_or((key, key));
        let (after_at, after_key) = after.unwrap_or((i64::MIN, String::new()));
        let select = format!(
            "SELECT {key}, {time_column} FROM {table} WHERE {predicate} \
         AND ({time_column}, {key_column}) > ($3, $4) \
         ORDER BY {order_by} LIMIT $2"
        );
        let candidates: Vec<(String, i64)> = sqlx::query_as(&select)
            .bind(cutoff)
            .bind(batch)
            .bind(after_at)
            .bind(&after_key)
            .fetch_all(&mut *tx)
            .await?;
        let next = candidates.last().map(|(id, at)| (*at, id.clone()));
        let candidate_count = candidates.len() as i64;
        let candidate_keys: Vec<String> = candidates.into_iter().map(|(id, _)| id).collect();
        let keys: Vec<String> = if candidate_keys.is_empty() {
            Vec::new()
        } else {
            let lock = format!(
                "SELECT {key} FROM {table} WHERE {key} = ANY($2) AND {predicate} \
             ORDER BY {key} FOR UPDATE SKIP LOCKED"
            );
            sqlx::query_scalar(&lock)
                .bind(cutoff)
                .bind(&candidate_keys)
                .fetch_all(&mut *tx)
                .await?
        };
        let delete = format!("DELETE FROM {table} WHERE {key} = ANY($1)");
        let count = delete_isolating(&mut tx, table, &delete, &keys).await?;
        Ok((count, candidate_count >= batch, next))
    }
    .await;
    finish_sweep(tx, outcome).await
}
