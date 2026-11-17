//! Single-use backup codes.

use rand::Rng;
use sqlx::PgPool;

use orbitid_core::crypto::sha256;
use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::models::UserRow;

const BACKUP_ALPHABET: &[u8] = b"abcdefghijkmnopqrstuvwxyz23456789";

/// Plaintext and stored forms of a fresh backup-code batch.
#[derive(Debug, Clone)]
pub struct BackupCodes {
    pub plain: Vec<String>,
    pub hashed: Vec<String>,
}

// ───────────── backup codes ─────────────

/// Generates `count` single-use `xxxxx-xxxxx` backup codes.
pub fn generate_backup_codes(count: usize) -> BackupCodes {
    let mut rng = rand::rng();
    let mut plain = Vec::with_capacity(count);
    for _ in 0..count {
        let mut raw = String::with_capacity(10);
        for _ in 0..10 {
            let index = rng.random_range(0..BACKUP_ALPHABET.len());
            raw.push(BACKUP_ALPHABET[index] as char);
        }
        plain.push(format!("{}-{}", &raw[..5], &raw[5..]));
    }
    let hashed = plain.iter().map(|code| hash_backup_code(code)).collect();
    BackupCodes { plain, hashed }
}

/// Normalizes a presented backup code the way every writer does.
pub fn hash_backup_code(code: &str) -> String {
    let normalized: String = code
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    sha256(&normalized)
}

/// Spends a backup code with a compare-and-set on the serialized array, so two
/// parallel requests cannot both use one code.
pub async fn consume_backup_code(pool: &PgPool, user_id: &str, code: &str) -> Result<bool> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?;
    let Some(user) = user else {
        return Ok(false);
    };
    let Some(hashes) = user.backup_codes.as_ref().map(|codes| codes.0.clone()) else {
        return Ok(false);
    };
    let hash = hash_backup_code(code);
    if !hashes.contains(&hash) {
        return Ok(false);
    }
    let remaining: Vec<String> = hashes
        .iter()
        .filter(|value| **value != hash)
        .cloned()
        .collect();
    let result = sqlx::query(
        "UPDATE users SET backup_codes = $1, updated_at = $2 \
         WHERE id = $3 AND backup_codes = $4",
    )
    .bind(sqlx::types::Json(&remaining))
    .bind(now())
    .bind(user_id)
    .bind(sqlx::types::Json(&hashes))
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Replaces the user's backup codes and returns the fresh plaintext batch.
pub async fn regenerate_backup_codes(pool: &PgPool, user_id: &str) -> Result<Vec<String>> {
    let codes = generate_backup_codes(10);
    sqlx::query("UPDATE users SET backup_codes = $1, updated_at = $2 WHERE id = $3")
        .bind(sqlx::types::Json(&codes.hashed))
        .bind(now())
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(codes.plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_codes_have_the_expected_shape() {
        let codes = generate_backup_codes(10);
        assert_eq!(codes.plain.len(), 10);
        for code in &codes.plain {
            assert_eq!(code.len(), 11);
            assert_eq!(code.as_bytes()[5], b'-');
        }
        assert_eq!(
            hash_backup_code("ABCDE-12345"),
            hash_backup_code("abcde12345")
        );
        assert_eq!(
            hash_backup_code("abcde 12345"),
            hash_backup_code("abcde12345")
        );
    }
}
