//! Bounded retry of a unit of work that failed with a retryable Postgres
//! transaction error (`40P01` deadlock, `40001` serialization failure).
//!
//! This is the inner half of the defence-in-depth in `crates/README.md`: a
//! handler (or a test) can wrap **only the transaction** in [`with_retry`], so
//! nothing outside the rolled-back transaction can be repeated. The HTTP layer
//! additionally replays whole requests for the routes where that is safe.

use std::future::Future;
use std::time::Duration;

use crate::error::{OrbitError, Result};

/// Total attempts (the first try plus two retries).
pub const MAX_TRANSACTION_ATTEMPTS: u32 = 3;

/// Small, jittered delay before retry `attempt` (1-based).
fn backoff(attempt: u32) -> Duration {
    let jitter = rand::Rng::random_range(&mut rand::rng(), 0..5u64);
    Duration::from_millis(u64::from(attempt) * 2 + jitter)
}

/// Runs `operation` up to [`MAX_TRANSACTION_ATTEMPTS`] times, retrying only
/// when the error is the 409 `transaction_conflict` produced by a deadlock or
/// serialization failure.
///
/// `operation` receives the 1-based attempt number so a closure that opens a
/// transaction can log it. It must contain only work that is safe to repeat
/// (normally: one `pool.begin()` … `commit()`). External effects belong after a
/// successful return, never inside the closure.
pub async fn with_retry<T, F, Fut>(label: &str, mut operation: F) -> Result<T>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T>>,
{
    let mut attempt = 1;
    loop {
        match operation(attempt).await {
            Ok(value) => return Ok(value),
            Err(error)
                if attempt < MAX_TRANSACTION_ATTEMPTS && error.is_retryable_transaction() =>
            {
                tracing::warn!(
                    label = %label,
                    attempt,
                    "retryable transaction conflict; retrying after a short backoff"
                );
                tokio::time::sleep(backoff(attempt)).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

/// A 409 `transaction_conflict`, exposed so callers/tests can construct one.
pub fn retryable_conflict() -> OrbitError {
    OrbitError::conflict(
        crate::error::error_codes::TRANSACTION_CONFLICT,
        "The request conflicted with another concurrent change. Retry it.",
    )
    .with_meta(serde_json::json!({ "retryable": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    /// A retryable conflict on the first attempt; the second succeeds. The
    /// side-effect counter is outside the closure, so it is written once.
    #[tokio::test]
    async fn retries_a_deadlock_and_does_not_repeat_a_side_effect() {
        let attempts = Arc::new(AtomicU32::new(0));
        let side_effects = Arc::new(AtomicU32::new(0));
        // Simulates a counter committed separately before the transaction (the
        // rate-limit budget / failed-attempt counter): it is outside the retry
        // closure by design.
        side_effects.fetch_add(1, Ordering::SeqCst);
        let result: Result<u32> = with_retry("test", {
            let attempts = Arc::clone(&attempts);
            move |attempt| {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.store(attempt, Ordering::SeqCst);
                    if attempt == 1 {
                        Err(retryable_conflict())
                    } else {
                        Ok(attempt)
                    }
                }
            }
        })
        .await;
        assert_eq!(result.ok(), Some(2));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(side_effects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn does_not_retry_a_non_retryable_conflict() {
        let attempts = Arc::new(AtomicU32::new(0));
        let result: Result<()> = with_retry("test", {
            let attempts = Arc::clone(&attempts);
            move |_| {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err(OrbitError::conflict(
                        crate::error::error_codes::DUPLICATE_RECORD,
                        "already exists",
                    ))
                }
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn gives_up_after_the_attempt_cap() {
        let attempts = Arc::new(AtomicU32::new(0));
        let result: Result<()> = with_retry("test", {
            let attempts = Arc::clone(&attempts);
            move |_| {
                let attempts = Arc::clone(&attempts);
                async move {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err(retryable_conflict())
                }
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_TRANSACTION_ATTEMPTS);
    }
}
