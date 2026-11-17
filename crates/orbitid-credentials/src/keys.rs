//! Instance signing keys and JWKS, ported from `services/tokens.ts` and
//! `modules/jwks.ts`.
//!
//! Private JWKs are sealed with `ORBITID_ENCRYPTION_KEY` in exactly the format
//! the TypeScript server uses, so keys created before the port keep working.
//! Decrypted keys are cached per process keyed by `(kid, ciphertext)`: a kid's
//! key material never changes, so the cache cannot go stale. The *active* key
//! is always read from Postgres, and creation/rotation runs under a Postgres
//! advisory lock so replicas booting together cannot create two active keys.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;
use sqlx::PgPool;

use orbitid_core::crypto::{decrypt, encrypt, random_token};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::SigningKeyRow;
use orbitid_core::AppState;

use crate::jwt::{Jwk, JwkError, JwsAlgorithm};
use crate::limits::run_cpu;

/// Wire algorithm for every instance key (TS `const ALG = "RS256"`).
pub const INSTANCE_KEY_ALGORITHM: &str = "RS256";
const ADVISORY_LOCK: i64 = 0x4f52_4249_545f_4b59;

/// A first-boot failure that names the cause instead of silently minting a key.
pub const UNREADABLE_KEY_HINT: &str = "Restore the key value this instance was created with: a different key cannot read the stored signing keys, and generating new ones would sign every user out. No key was regenerated.";

struct LoadedKey {
    algorithm: JwsAlgorithm,
    key: Jwk,
}

fn key_cache() -> &'static Mutex<HashMap<String, Arc<LoadedKey>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<LoadedKey>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The currently active instance signing key.
#[derive(Clone, Debug)]
pub struct ActiveSigningKey {
    pub row: SigningKeyRow,
    /// Public JWK exactly as stored (includes `alg`, `use`, `kid`).
    pub public_jwk: Value,
}

/// Result of minting a new signing key.
#[derive(Clone, Debug)]
pub struct GeneratedSigningKey {
    pub kid: String,
    pub public_jwk: Value,
}

struct PreparedKey {
    kid: String,
    public_jwk: Value,
    encrypted_private_jwk: String,
    created_at: i64,
}

async fn load_key(state: &AppState, row: &SigningKeyRow) -> Result<Arc<LoadedKey>> {
    let cache_key = format!("{}\u{0}{}", row.kid, row.private_jwk_enc);
    if let Some(cached) = key_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(&cache_key)
        .cloned()
    {
        return Ok(cached);
    }
    let algorithm = JwsAlgorithm::parse(&row.alg).ok_or_else(|| {
        OrbitError::internal(format!(
            "Signing key \"{}\" uses unsupported algorithm {}",
            row.kid, row.alg
        ))
    })?;
    let plaintext = decrypt(&state.env.encryption_key, &row.private_jwk_enc).map_err(|_| {
        OrbitError::internal(format!(
            "Cannot decrypt signing key \"{}\" with the configured ORBITID_ENCRYPTION_KEY",
            row.kid
        ))
    })?;
    let value: Value = serde_json::from_str(&plaintext).map_err(|_| {
        OrbitError::internal(format!(
            "Signing key \"{}\" does not contain a JSON private JWK",
            row.kid
        ))
    })?;
    let key = Jwk::from_value(&value).map_err(|error| {
        OrbitError::internal(format!(
            "Signing key \"{}\" is not a usable JWK: {error}",
            row.kid
        ))
    })?;
    if !key.supports(algorithm) {
        return Err(OrbitError::internal(format!(
            "Signing key \"{}\" does not match algorithm {}",
            row.kid, row.alg
        )));
    }
    let loaded = Arc::new(LoadedKey { algorithm, key });
    let mut cache = key_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    cache.insert(cache_key, Arc::clone(&loaded));
    Ok(loaded)
}

async fn prepare_key(state: &AppState) -> Result<PreparedKey> {
    let kid = random_token(9);
    let encryption_key = state.env.encryption_key.clone();
    let generation_kid = kid.clone();
    run_cpu(move || {
        let mut rng = rand_core::OsRng;
        let private = rsa::RsaPrivateKey::new(&mut rng, 2048).map_err(|error| {
            OrbitError::internal(format!("Could not generate an RSA key: {error}"))
        })?;
        let algorithm = JwsAlgorithm::RS256;
        let key = Jwk::Rsa {
            kid: Some(generation_kid.clone()),
            alg: Some(algorithm),
            use_: Some("sig".into()),
            public: rsa::RsaPublicKey::from(&private),
            private: Some(private),
        };
        let public_jwk = key.to_value(false);
        let private_json = serde_json::to_string(&key.to_value(true)).map_err(|error| {
            OrbitError::internal(format!("Could not serialize signing key: {error}"))
        })?;
        let encrypted = encrypt(&encryption_key, &private_json).map_err(|error| {
            OrbitError::internal(format!("Could not encrypt signing key: {error}"))
        })?;
        Ok(PreparedKey {
            kid: generation_kid,
            public_jwk,
            encrypted_private_jwk: encrypted,
            created_at: orbitid_core::http::now(),
        })
    })
    .await?
}

async fn insert_prepared(pool: &PgPool, prepared: &PreparedKey, active: bool) -> Result<()> {
    sqlx::query(
        "INSERT INTO signing_keys \
         (kid, alg, public_jwk, private_jwk_enc, active, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&prepared.kid)
    .bind(INSTANCE_KEY_ALGORITHM)
    .bind(sqlx::types::Json(&prepared.public_jwk))
    .bind(&prepared.encrypted_private_jwk)
    .bind(active)
    .bind(prepared.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

async fn active_row(pool: &PgPool) -> Result<Option<SigningKeyRow>> {
    Ok(sqlx::query_as::<_, SigningKeyRow>(
        "SELECT * FROM signing_keys WHERE active = true ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?)
}

/// Generates and persists a new signing key. The caller chooses whether it
/// becomes the active key (rotation inserts it active in the same transaction).
pub async fn generate_signing_key(state: &AppState, active: bool) -> Result<GeneratedSigningKey> {
    let prepared = prepare_key(state).await?;
    insert_prepared(&state.pool, &prepared, active).await?;
    Ok(GeneratedSigningKey {
        kid: prepared.kid,
        public_jwk: prepared.public_jwk,
    })
}

/// Returns the active signing key, creating the instance's first key on first
/// boot. Concurrent first boots are serialized by a transaction-scoped advisory
/// lock; the generated key of a loser is discarded.
pub async fn get_active_signing_key(state: &AppState) -> Result<ActiveSigningKey> {
    if let Some(row) = active_row(&state.pool).await? {
        let public_jwk = row.public_jwk.0.clone();
        let _ = load_key(state, &row).await?;
        return Ok(ActiveSigningKey { row, public_jwk });
    }
    let prepared = prepare_key(state).await?;
    let mut tx = state.pool.begin().await?;
    let outcome: Result<SigningKeyRow> = async {
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(ADVISORY_LOCK)
            .execute(&mut *tx)
            .await?;
        let existing = sqlx::query_as::<_, SigningKeyRow>(
            "SELECT * FROM signing_keys WHERE active = true ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let row = if let Some(row) = existing {
            row
        } else {
            let latest = sqlx::query_as::<_, SigningKeyRow>(
                "SELECT * FROM signing_keys ORDER BY created_at DESC LIMIT 1",
            )
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(mut latest) = latest {
                sqlx::query("UPDATE signing_keys SET active = true WHERE kid = $1")
                    .bind(&latest.kid)
                    .execute(&mut *tx)
                    .await?;
                latest.active = true;
                latest
            } else {
                insert_prepared_tx(&mut tx, &prepared).await?;
                sqlx::query_as::<_, SigningKeyRow>("SELECT * FROM signing_keys WHERE kid = $1")
                    .bind(&prepared.kid)
                    .fetch_one(&mut *tx)
                    .await?
            }
        };
        Ok(row)
    }
    .await;
    let row = orbitid_core::db::finish_transaction(tx, outcome).await?;
    let public_jwk = row.public_jwk.0.clone();
    let _ = load_key(state, &row).await?;
    Ok(ActiveSigningKey { row, public_jwk })
}

async fn insert_prepared_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    prepared: &PreparedKey,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO signing_keys \
         (kid, alg, public_jwk, private_jwk_enc, active, created_at) \
         VALUES ($1, $2, $3, $4, true, $5)",
    )
    .bind(&prepared.kid)
    .bind(INSTANCE_KEY_ALGORITHM)
    .bind(sqlx::types::Json(&prepared.public_jwk))
    .bind(&prepared.encrypted_private_jwk)
    .bind(prepared.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Marks every active key rotated and mints a new active key in one
/// transaction. Old public keys remain in the JWKS.
pub async fn rotate_signing_key(state: &AppState) -> Result<String> {
    let prepared = prepare_key(state).await?;
    let now = orbitid_core::http::now();
    let mut tx = state.pool.begin().await?;
    let outcome: Result<()> = async {
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(ADVISORY_LOCK)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE signing_keys SET active = false, rotated_at = $1 WHERE active = true")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        insert_prepared_tx(&mut tx, &prepared).await
    }
    .await;
    orbitid_core::db::finish_transaction(tx, outcome).await?;
    Ok(prepared.kid)
}

/// Every stored public JWK, minting the first key when the table is empty.
/// Used by `.well-known/jwks.json` and the OIDC discovery document.
pub async fn get_jwks(state: &AppState) -> Result<Vec<Value>> {
    let mut rows =
        sqlx::query_as::<_, SigningKeyRow>("SELECT * FROM signing_keys ORDER BY created_at ASC")
            .fetch_all(&state.pool)
            .await?;
    if rows.is_empty() {
        get_active_signing_key(state).await?;
        rows = sqlx::query_as::<_, SigningKeyRow>(
            "SELECT * FROM signing_keys ORDER BY created_at ASC",
        )
        .fetch_all(&state.pool)
        .await?;
    }
    Ok(rows.into_iter().map(|row| row.public_jwk.0).collect())
}

/// Boot-time guard: every stored key must decrypt and parse with the configured
/// encryption key. Runs before the server accepts traffic.
pub async fn assert_signing_keys_readable(state: &AppState) -> Result<()> {
    let rows = sqlx::query_as::<_, SigningKeyRow>("SELECT * FROM signing_keys")
        .fetch_all(&state.pool)
        .await?;
    for row in rows {
        if let Err(cause) = load_key(state, &row).await {
            return Err(OrbitError::internal(format!(
                "Cannot decrypt signing key \"{}\" with the configured ORBITID_ENCRYPTION_KEY. {} ({})",
                row.kid, UNREADABLE_KEY_HINT, cause.message
            )));
        }
    }
    Ok(())
}

/// Signs arbitrary claims with the active instance key (or a specific kid).
pub(crate) async fn sign_with_instance_key(
    state: &AppState,
    claims: &Value,
    kid: Option<&str>,
) -> Result<String> {
    let active = get_active_signing_key(state).await?;
    let (row, loaded) = if kid.is_some_and(|kid| kid != active.row.kid) {
        let kid = kid.unwrap_or_default();
        let row = sqlx::query_as::<_, SigningKeyRow>("SELECT * FROM signing_keys WHERE kid = $1")
            .bind(kid)
            .fetch_optional(&state.pool)
            .await?;
        match row {
            Some(row) => {
                let loaded = load_key(state, &row).await?;
                (row, loaded)
            }
            None => {
                let loaded = load_key(state, &active.row).await?;
                (active.row, loaded)
            }
        }
    } else {
        let loaded = load_key(state, &active.row).await?;
        (active.row, loaded)
    };
    crate::jwt::sign_jws(claims, loaded.algorithm, &loaded.key, Some(&row.kid)).map_err(jwt_error)
}

pub(crate) fn jwt_error(error: JwkError) -> OrbitError {
    match error {
        JwkError::Expired | JwkError::NotYetValid => {
            OrbitError::unauthorized(error_codes::AUTHENTICATION_INVALID, "Invalid session token")
        }
        _ => OrbitError::internal(format!("JWT operation failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_hint_mentions_the_cause() {
        assert!(UNREADABLE_KEY_HINT.contains("No key was regenerated"));
    }
}
