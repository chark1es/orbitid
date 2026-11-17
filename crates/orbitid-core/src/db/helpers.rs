//! Helpers ported from the retired TypeScript server that still make sense
//! on a Postgres-only server.

use std::future::Future;
use std::pin::Pin;

use sqlx::{PgConnection, PgPool, Postgres, Transaction};

use crate::error::{is_unique_violation, OrbitError, Result};

/// Boxed future returned by [`in_write_transaction`]'s body.
pub type TxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Runs `body` in one write transaction and commits it.
///
/// Nested calls do not join the outer transaction automatically (Rust has no
/// task-local transaction). Pass the `&mut PgConnection` down instead, or use
/// [`savepoint`] when a nested unit must be independently rollback-able.
pub async fn in_write_transaction<T, F>(pool: &PgPool, body: F) -> Result<T>
where
    F: for<'a> FnOnce(&'a mut PgConnection) -> TxFuture<'a, T>,
{
    let mut transaction = pool.begin().await?;
    let outcome = body(&mut transaction).await;
    finish_transaction(transaction, outcome).await
}

/// Commits on `Ok`, and on `Err` awaits an explicit rollback. A dropped
/// transaction only queues its rollback, so its row and advisory locks stay held
/// by the pooled connection until it is next used: every non-commit exit of a
/// transaction whose locks later work (a retry, the next worker batch, another
/// replica) needs must end here.
pub async fn finish_transaction<T>(
    transaction: Transaction<'_, Postgres>,
    outcome: Result<T>,
) -> Result<T> {
    match outcome {
        Ok(value) => {
            transaction.commit().await?;
            Ok(value)
        }
        Err(error) => {
            let _ = transaction.rollback().await;
            Err(error)
        }
    }
}

/// A nested transaction (Postgres `SAVEPOINT`) inside an open transaction.
pub async fn savepoint<'a, T, F>(connection: &'a mut PgConnection, body: F) -> Result<T>
where
    F: for<'b> FnOnce(&'b mut PgConnection) -> TxFuture<'b, T>,
{
    let savepoint = sqlx::query("SAVEPOINT orbitid_nested")
        .execute(&mut *connection)
        .await?;
    let _ = savepoint;
    match body(&mut *connection).await {
        Ok(value) => {
            sqlx::query("RELEASE SAVEPOINT orbitid_nested")
                .execute(&mut *connection)
                .await?;
            Ok(value)
        }
        Err(error) => {
            sqlx::query("ROLLBACK TO SAVEPOINT orbitid_nested")
                .execute(&mut *connection)
                .await?;
            Err(error)
        }
    }
}

/// Serialises operations on one OIDC refresh-token family for the current transaction.
pub async fn lock_grant_family(connection: &mut PgConnection, family: &str) -> Result<()> {
    if family.is_empty() {
        return Ok(());
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(family)
        .execute(&mut *connection)
        .await?;
    Ok(())
}

/// First row of a result, or `None`.
pub fn first<T>(rows: Vec<T>) -> Option<T> {
    rows.into_iter().next()
}

/// Unique-violation detection for a past-the-fact race.
pub fn unique_violation(error: &sqlx::Error) -> bool {
    is_unique_violation(error)
}

/// Maps a unique violation to the API's `409 duplicate_record`.
pub fn unique_violation_error(error: sqlx::Error) -> OrbitError {
    OrbitError::from(error)
}

/// `%` and `_` in user input must match themselves, not act as wildcards.
pub fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(character);
            }
            other => out.push(other),
        }
    }
    out
}

/// Case-insensitive "contains" pattern for `lower(column) LIKE $1 ESCAPE '\'`.
pub fn contains_pattern(text: &str) -> String {
    format!("%{}%", escape_like(&text.to_lowercase()))
}

/// Case-insensitive "starts with" pattern.
pub fn starts_with_pattern(text: &str) -> String {
    format!("{}%", escape_like(&text.to_lowercase()))
}

/// Base64url cursor for keyset pagination (`(created_at, id)` or an opaque id).
pub fn encode_cursor(value: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes())
}

pub fn decode_cursor(cursor: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// Convenience for the endpoint lists that use offset pagination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageQuery {
    pub limit: i64,
    pub offset: i64,
}

impl Default for PageQuery {
    fn default() -> Self {
        Self {
            limit: 10,
            offset: 0,
        }
    }
}

pub const MAX_PAGE_LIMIT: i64 = 500;

impl PageQuery {
    /// Validates like `paginationSchema` (limit 1..=500, offset >= 0).
    pub fn new(limit: Option<i64>, offset: Option<i64>) -> Result<Self> {
        let limit = limit.unwrap_or(10);
        let offset = offset.unwrap_or(0);
        if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
            return Err(OrbitError::unprocessable(
                crate::error::error_codes::FORM_PARAM_VALUE_INVALID,
                "limit must be between 1 and 500",
            )
            .with_meta(serde_json::json!({ "param_name": "limit" })));
        }
        if offset < 0 {
            return Err(OrbitError::unprocessable(
                crate::error::error_codes::FORM_PARAM_VALUE_INVALID,
                "offset must be 0 or greater",
            )
            .with_meta(serde_json::json!({ "param_name": "offset" })));
        }
        Ok(Self { limit, offset })
    }
}

/// Begins a transaction, for callers that need explicit control.
pub async fn begin(pool: &PgPool) -> Result<Transaction<'_, Postgres>> {
    Ok(pool.begin().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_escaping() {
        assert_eq!(escape_like("50%_off\\"), "50\\%\\_off\\\\");
        assert_eq!(contains_pattern("Foo"), "%foo%");
        assert_eq!(starts_with_pattern("Foo"), "foo%");
    }

    #[test]
    fn cursor_round_trip() {
        let cursor = encode_cursor("2026-01-01|user_1");
        assert_eq!(decode_cursor(&cursor).as_deref(), Some("2026-01-01|user_1"));
        assert!(decode_cursor("!!!").is_none());
    }

    #[test]
    fn pagination_bounds() {
        assert_eq!(
            PageQuery::new(None, None).unwrap(),
            PageQuery {
                limit: 10,
                offset: 0
            }
        );
        assert!(PageQuery::new(Some(0), None).is_err());
        assert!(PageQuery::new(Some(501), None).is_err());
        assert!(PageQuery::new(Some(10), Some(-1)).is_err());
        assert!(PageQuery::new(Some(500), Some(0)).is_ok());
    }
}
