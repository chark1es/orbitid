//! Durable scan positions of background workers (`worker_cursors`, migration
//! 0011). A worker that can end a tick early (time budget, batch limit) stores
//! the last candidate it examined so the next tick, on any replica or after a
//! restart, continues after it instead of re-reading a permanently failing head.

use orbitid_core::http::now;
use orbitid_core::state::AppState;
use serde_json::Value;

/// The stored cursor, or `None` (also when it cannot be read: the worker then
/// starts from the head, which is always correct).
pub async fn load(state: &AppState, name: &str) -> Option<Value> {
    let stored: Result<Option<sqlx::types::Json<Value>>, _> =
        sqlx::query_scalar("SELECT cursor FROM worker_cursors WHERE name = $1")
            .bind(name)
            .fetch_optional(&state.pool)
            .await;
    match stored {
        Ok(found) => found.map(|json| json.0),
        Err(error) => {
            tracing::warn!("[{name}] could not read the scan cursor: {error}");
            None
        }
    }
}

/// Stores the cursor, or clears it with `None`. A failure is logged: the next
/// tick then merely re-examines some candidates.
pub async fn save(state: &AppState, name: &str, cursor: Option<&Value>) {
    let result = match cursor {
        Some(value) => {
            sqlx::query(
                "INSERT INTO worker_cursors (name, cursor, updated_at) VALUES ($1, $2, $3) \
                 ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, \
                 updated_at = EXCLUDED.updated_at",
            )
            .bind(name)
            .bind(sqlx::types::Json(value))
            .bind(now())
            .execute(&state.pool)
            .await
        }
        None => {
            sqlx::query("DELETE FROM worker_cursors WHERE name = $1")
                .bind(name)
                .execute(&state.pool)
                .await
        }
    };
    if let Err(error) = result {
        tracing::warn!("[{name}] could not save the scan cursor: {error}");
    }
}

/// A `(time, key)` keyset position as stored JSON.
pub fn pair_to_json(at: i64, id: &str) -> Value {
    serde_json::json!({ "at": at, "id": id })
}

pub fn pair_from_json(value: &Value) -> Option<(i64, String)> {
    Some((
        value.get("at")?.as_i64()?,
        value.get("id")?.as_str()?.to_string(),
    ))
}
