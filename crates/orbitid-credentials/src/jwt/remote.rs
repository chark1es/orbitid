//! Remote JWKS documents (`jose.createRemoteJWKSet` equivalent) fetched through
//! the SSRF-safe transport and cached per process with a TTL. The cache never
//! decides whether a key is trusted: a stale entry is refreshed on expiry, and
//! every verification still checks the signature.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;
use tokio::sync::Mutex;

use orbitid_core::safe_fetch::{self, SafeFetchOptions};
use orbitid_core::AppState;

use super::jwk::JwkError;
use super::jwks::JwkSet;

/// Default cache lifetime; `jose` uses 10 minutes, this server refreshes the
/// document every five so key rotation does not leave replicas diverged for
/// long.
pub const DEFAULT_TTL_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone)]
pub struct RemoteJwksOptions {
    pub ttl_ms: i64,
    /// Fetch even when a fresh cache entry exists.
    pub force: bool,
}

impl Default for RemoteJwksOptions {
    fn default() -> Self {
        Self {
            ttl_ms: DEFAULT_TTL_MS,
            force: false,
        }
    }
}

struct CacheEntry {
    fetched_at_ms: i64,
    keys: JwkSet,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fetches (or returns a cached) JWKS document for `url`.
pub async fn fetch_remote_jwks(
    state: Option<&AppState>,
    url: &str,
    options: RemoteJwksOptions,
) -> Result<JwkSet, JwkError> {
    let now = orbitid_core::http::now();
    if !options.force {
        if let Some(entry) = cache().lock().await.get(url) {
            if now - entry.fetched_at_ms < options.ttl_ms {
                return Ok(entry.keys.clone());
            }
        }
    }
    let response = safe_fetch::safe_fetch(
        state,
        url,
        SafeFetchOptions {
            method: Some("GET".into()),
            headers: safe_fetch::headers(&[
                ("accept", "application/json"),
                ("user-agent", "OrbitID"),
            ]),
            timeout_ms: Some(10_000),
            max_bytes: Some(1024 * 1024),
            ..Default::default()
        },
    )
    .await
    .map_err(|error| JwkError::Fetch(error.message))?;
    if !response.ok() {
        return Err(JwkError::Fetch(format!("HTTP {}", response.status)));
    }
    let value: Value = serde_json::from_str(&response.body)
        .map_err(|_| JwkError::Fetch("response is not JSON".into()))?;
    let keys = JwkSet::from_value(&value).map_err(|error| JwkError::Fetch(error.to_string()))?;
    if keys.is_empty() {
        return Err(JwkError::Fetch("no usable keys".into()));
    }
    cache().lock().await.insert(
        url.to_string(),
        CacheEntry {
            fetched_at_ms: now,
            keys: keys.clone(),
        },
    );
    Ok(keys)
}

/// Drops a cached document (e.g. after the provider rotated a key).
pub async fn invalidate_remote_jwks(url: &str) {
    cache().lock().await.remove(url);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalidating_an_unknown_url_is_harmless() {
        invalidate_remote_jwks("https://keys.example.test/jwks.json").await;
    }
}
