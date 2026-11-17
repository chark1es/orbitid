//! Distributed SAML request/replay cache backed by `oauth_states`.
//!
//! `@node-saml/node-saml` normally keeps AuthnRequest IDs and accepted assertion
//! IDs in process memory. Several replicas behind a load balancer cannot do
//! that, so the same keys live in Postgres (one statement per check-and-write,
//! so parallel responses cannot both claim a replay key).

use orbitid_core::models::OauthStateRow;
use sqlx::PgPool;

use crate::http::now_ms;

/// How long an AuthnRequest ID or accepted assertion is remembered.
pub const SAML_CACHE_TTL_MS: i64 = 10 * 60_000;

/// The row-key prefix used by the TypeScript implementation.
const ROW_PREFIX: &str = "saml:";

/// Cache operations used by AuthnRequest generation and assertion validation.
#[derive(Debug, Clone)]
pub struct SamlCache {
    pool: PgPool,
}

impl SamlCache {
    /// Wraps a connection pool.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    fn row_key(key: &str) -> String {
        format!("{ROW_PREFIX}{key}")
    }

    fn value_of(row: Option<&OauthStateRow>) -> Option<String> {
        let row = row?;
        match row.flow.0.get("value") {
            Some(serde_json::Value::String(value)) => Some(value.clone()),
            Some(value) => Some(value.to_string()),
            None => None,
        }
    }

    /// Stores `value` for the default TTL, replacing an existing value.
    pub async fn save(&self, key: &str, value: &str) -> Result<(), orbitid_core::OrbitError> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO oauth_states (state, provider, flow, expires_at) VALUES ($1, 'saml_cache', $2, $3) \
             ON CONFLICT (state) DO UPDATE SET flow = EXCLUDED.flow, expires_at = EXCLUDED.expires_at",
        )
        .bind(Self::row_key(key))
        .bind(sqlx::types::Json(serde_json::json!({ "value": value })))
        .bind(now + SAML_CACHE_TTL_MS)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Reads a value that has not expired.
    pub async fn get(&self, key: &str) -> Result<Option<String>, orbitid_core::OrbitError> {
        let row = sqlx::query_as::<_, OauthStateRow>(
            "SELECT state, provider, code_verifier, nonce, flow, expires_at FROM oauth_states \
             WHERE state = $1 AND expires_at > $2",
        )
        .bind(Self::row_key(key))
        .bind(now_ms())
        .fetch_optional(&self.pool)
        .await?;
        Ok(Self::value_of(row.as_ref()))
    }

    /// Removes a value and returns it when it had not expired.
    pub async fn remove(&self, key: &str) -> Result<Option<String>, orbitid_core::OrbitError> {
        let row = sqlx::query_as::<_, OauthStateRow>(
            "DELETE FROM oauth_states WHERE state = $1 \
             RETURNING state, provider, code_verifier, nonce, flow, expires_at",
        )
        .bind(Self::row_key(key))
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .as_ref()
            .filter(|row| row.expires_at > now_ms())
            .and_then(|row| Self::value_of(Some(row))))
    }

    /// Atomically removes and returns a request ID (the `once` semantics of a state).
    pub async fn consume(&self, key: &str) -> Result<Option<String>, orbitid_core::OrbitError> {
        let row = sqlx::query_as::<_, OauthStateRow>(
            "DELETE FROM oauth_states WHERE state = $1 AND expires_at > $2 \
             RETURNING state, provider, code_verifier, nonce, flow, expires_at",
        )
        .bind(Self::row_key(key))
        .bind(now_ms())
        .fetch_optional(&self.pool)
        .await?;
        Ok(Self::value_of(row.as_ref()))
    }

    /// Saves only when the key is absent or already expired. Returns whether the
    /// caller claimed the key; a replay loses the race and gets `false`.
    pub async fn save_if_absent(
        &self,
        key: &str,
        value: &str,
        expires_at_ms: i64,
    ) -> Result<bool, orbitid_core::OrbitError> {
        let now = now_ms();
        let written = sqlx::query_as::<_, OauthStateRow>(
            "INSERT INTO oauth_states (state, provider, flow, expires_at) VALUES ($1, 'saml_cache', $2, $3) \
             ON CONFLICT (state) DO UPDATE SET flow = EXCLUDED.flow, expires_at = EXCLUDED.expires_at \
             WHERE oauth_states.expires_at <= $4 \
             RETURNING state, provider, code_verifier, nonce, flow, expires_at",
        )
        .bind(Self::row_key(key))
        .bind(sqlx::types::Json(serde_json::json!({ "value": value })))
        .bind(expires_at_ms)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(written.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_keys_are_prefixed_like_the_typescript_cache() {
        assert_eq!(SAMLCacheKeyProbe::key("_abc"), "saml:_abc");
    }

    struct SAMLCacheKeyProbe;

    impl SAMLCacheKeyProbe {
        fn key(key: &str) -> String {
            SamlCache::row_key(key)
        }
    }

    #[test]
    fn cache_ttl_matches_the_typescript_constant() {
        assert_eq!(SAML_CACHE_TTL_MS, 10 * 60_000);
    }
}
