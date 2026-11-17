//! Bounded concurrency for CPU-heavy work (argon2, scrypt, bcrypt, RSA
//! keygen). Without a bound a login burst can occupy every blocking thread and
//! starve the async runtime.

use std::sync::OnceLock;

use tokio::sync::Semaphore;

use orbitid_core::{OrbitError, Result};

/// Four concurrent password hashes / key generations per replica. Argon2id at
/// the production parameters uses ~19 MiB each, so this keeps the worst case
/// around 76 MiB while still using multiple cores.
const PERMITS: usize = 4;

fn limiter() -> &'static Semaphore {
    static LIMITER: OnceLock<Semaphore> = OnceLock::new();
    LIMITER.get_or_init(|| Semaphore::new(PERMITS))
}

/// Runs `body` on the blocking pool while holding one CPU permit.
pub(crate) async fn run_cpu<T, F>(body: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let permit = limiter()
        .acquire()
        .await
        .map_err(|_| OrbitError::internal("CPU work queue is closed"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        body()
    })
    .await
    .map_err(|error| OrbitError::internal(format!("CPU work failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_work() {
        let value = run_cpu(|| 2 + 2).await.unwrap();
        assert_eq!(value, 4);
    }
}
