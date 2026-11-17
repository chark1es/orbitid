//! Failure isolation for retention deletes: one row whose delete keeps failing
//! (a trigger, an unexpected reference) must not fail the whole batch, or the
//! drain would stop at the same head every tick and never reach the rows behind
//! it.

use orbitid_core::error::Result;
use sqlx::Connection;

/// Deletes `keys` with `sql` (`$1` = key array). The whole set runs inside a
/// savepoint; if it fails for a reason other than a retryable
/// `40P01`/`40001` (which propagates so `with_retry` replays the transaction),
/// the keys are retried one by one and the rows that keep failing are logged
/// and skipped. Returns the number of rows deleted.
pub(super) async fn delete_isolating(
    conn: &mut sqlx::PgConnection,
    label: &str,
    sql: &str,
    keys: &[String],
) -> Result<i64> {
    if keys.is_empty() {
        return Ok(0);
    }
    match try_delete(conn, sql, keys).await {
        Ok(count) => Ok(count),
        Err(error) if error.is_retryable_transaction() => Err(error),
        Err(error) => {
            tracing::warn!("[retention] {label}: batch delete failed ({error}); isolating rows");
            let mut deleted = 0;
            for key in keys {
                match try_delete(conn, sql, std::slice::from_ref(key)).await {
                    Ok(count) => deleted += count,
                    Err(error) if error.is_retryable_transaction() => return Err(error),
                    Err(error) => {
                        tracing::warn!("[retention] {label}: skipping row {key}: {error}");
                    }
                }
            }
            Ok(deleted)
        }
    }
}

async fn try_delete(conn: &mut sqlx::PgConnection, sql: &str, keys: &[String]) -> Result<i64> {
    let mut savepoint = conn.begin().await?;
    match sqlx::query(sql).bind(keys).execute(&mut *savepoint).await {
        Ok(done) => {
            savepoint.commit().await?;
            Ok(done.rows_affected() as i64)
        }
        Err(error) => {
            let _ = savepoint.rollback().await;
            Err(error.into())
        }
    }
}
