//! Cryptographic primitives, ported from the retired TypeScript server.
//!
//! The AES-256-GCM key derivation (`scrypt(secret, "orbitid-at-rest", 32)`)
//! and the `v1.<iv>.<tag>.<ciphertext>` format are part of the on-disk
//! contract: data encrypted by the TypeScript server must keep decrypting.
//! Deriving a key is deliberately cached (scrypt is expensive); callers on the
//! async runtime should wrap the *first* derivation in `spawn_blocking` (the
//! settings store does).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const AES_SALT: &str = "orbitid-at-rest";
const DIGEST_SALT: &str = "orbitid-at-rest/digest/v1";
/// Derived-key cache bound. A process only ever uses a handful of keys; when
/// the cache reaches this size it is cleared wholesale, which is deterministic
/// and keeps the lookup lock holder's work bounded.
const DERIVED_KEY_CACHE_LIMIT: usize = 16;

type DerivedKeyCache = HashMap<String, Arc<[u8; 32]>>;

fn store_derived_key(cache: &mut DerivedKeyCache, cache_key: String, key: Arc<[u8; 32]>) {
    if cache.len() >= DERIVED_KEY_CACHE_LIMIT {
        cache.clear();
    }
    cache.insert(cache_key, key);
}

/// Prefix of a keyed digest produced by [`hash_low_entropy`].
pub const KEYED_DIGEST_PREFIX: &str = "h1:";

#[derive(Debug, Clone, thiserror::Error)]
pub enum CryptoError {
    #[error("Invalid ciphertext")]
    InvalidCiphertext,
    #[error("Invalid key")]
    InvalidKey,
}

/// Lowercase hex SHA-256.
pub fn sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// `randomBytes(bytes).toString("base64url")`, no padding.
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer)
}

/// Numeric one-time code of `len` digits, zero padded.
pub fn random_code(len: usize) -> String {
    if (1..=15).contains(&len) {
        let max = 10u64.pow(len as u32);
        let value = rand::rng().random_range(0..max);
        return format!("{value:0len$}");
    }
    let mut out = String::with_capacity(len);
    for _ in 0..len {
        out.push(char::from(b'0' + rand::rng().random_range(0..10) as u8));
    }
    out
}

/// Constant-time string comparison (length is allowed to leak, as in Node).
pub fn safe_equal(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    // HMAC accepts keys of any length, so this cannot fail; the fallback keeps
    // the function panic-free.
    let Ok(mut mac) = <Hmac<Sha256> as Mac>::new_from_slice(key) else {
        return Vec::new();
    };
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub fn hmac_sha256_hex(key: &[u8], data: &str) -> String {
    hex_encode(&hmac_sha256(key, data.as_bytes()))
}

fn derive_key(purpose: &str, secret: &str, salt: &str) -> Arc<[u8; 32]> {
    static CACHE: Mutex<Option<HashMap<String, Arc<[u8; 32]>>>> = Mutex::new(None);
    let cache_key = format!("{purpose}\u{0}{secret}");
    {
        let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some(key) = cache.get(&cache_key) {
            return Arc::clone(key);
        }
    }
    let mut key = [0u8; 32];
    // Node's scryptSync defaults: N=16384 (log_n=14), r=8, p=1, keylen=32.
    let Ok(params) = scrypt::Params::new(14, 8, 1, 32) else {
        // Unreachable for these constants; a SHA-256 fallback is still better
        // than panicking inside a request path.
        return Arc::new(Sha256::digest(secret.as_bytes()).into());
    };
    if scrypt::scrypt(secret.as_bytes(), salt.as_bytes(), &params, &mut key).is_err() {
        return Arc::new(Sha256::digest(secret.as_bytes()).into());
    }
    let key = Arc::new(key);
    let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    store_derived_key(cache, cache_key, Arc::clone(&key));
    key
}

/// AES-256-GCM key (the original derivation; changing it would orphan every stored secret).
fn key32(secret: &str) -> Arc<[u8; 32]> {
    derive_key("aes", secret, AES_SALT)
}

fn digest_key(secret: &str) -> Arc<[u8; 32]> {
    derive_key("digest", secret, DIGEST_SALT)
}

/// Keyed digest for values an attacker could enumerate offline (codes, backup codes).
pub fn hash_low_entropy(secret: &str, value: &str) -> String {
    format!(
        "{KEYED_DIGEST_PREFIX}{}",
        hmac_sha256_hex(&*digest_key(secret), value)
    )
}

/// Compares a presented low-entropy value against a stored digest (keyed now,
/// plain sha256 in older rows).
pub fn verify_low_entropy(secret: &str, value: &str, stored: Option<&str>) -> bool {
    match stored {
        None | Some("") => false,
        Some(stored) => {
            let expected = if stored.starts_with(KEYED_DIGEST_PREFIX) {
                hash_low_entropy(secret, value)
            } else {
                sha256(value)
            };
            safe_equal(&expected, stored)
        }
    }
}

/// AES-256-GCM → `v1.<iv>.<tag>.<ciphertext>` (base64url, no padding).
pub fn encrypt(secret: &str, plaintext: &str) -> Result<String, CryptoError> {
    let key = key32(secret);
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| CryptoError::InvalidKey)?;
    let mut iv = [0u8; 12];
    rand::rng().fill_bytes(&mut iv);
    let sealed = cipher
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    if sealed.len() < 16 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let (ciphertext, tag) = sealed.split_at(sealed.len() - 16);
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok(format!(
        "v1.{}.{}.{}",
        engine.encode(iv),
        engine.encode(tag),
        engine.encode(ciphertext)
    ))
}

pub fn decrypt(secret: &str, payload: &str) -> Result<String, CryptoError> {
    let mut parts = payload.split('.');
    let version = parts.next();
    let iv = parts.next();
    let tag = parts.next();
    let ciphertext = parts.next();
    if parts.next().is_some() || version != Some("v1") {
        return Err(CryptoError::InvalidCiphertext);
    }
    let (Some(iv), Some(tag), Some(ciphertext)) = (iv, tag, ciphertext) else {
        return Err(CryptoError::InvalidCiphertext);
    };
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let iv = engine
        .decode(iv)
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    if iv.len() != 12 {
        return Err(CryptoError::InvalidCiphertext);
    }
    let tag = engine
        .decode(tag)
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    let ciphertext = engine
        .decode(ciphertext)
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    let key = key32(secret);
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| CryptoError::InvalidKey)?;
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&iv), sealed.as_ref())
        .map_err(|_| CryptoError::InvalidCiphertext)?;
    String::from_utf8(plaintext).map_err(|_| CryptoError::InvalidCiphertext)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ciphertext produced by the TypeScript implementation (`lib/crypto.ts`)
    /// for secret `test-encryption-key-0123456789abcdef`, iv
    /// `000102030405060708090a0b` and plaintext `hello orbitid`.
    const TS_CIPHERTEXT: &str = "v1.AAECAwQFBgcICQoL.9cJTKWX_i5guBPTBEQwpFQ.QP_eHDwlwXxCqAPTrQ";

    #[test]
    fn decrypts_typescript_ciphertext() {
        assert_eq!(
            decrypt("test-encryption-key-0123456789abcdef", TS_CIPHERTEXT).unwrap(),
            "hello orbitid"
        );
    }

    #[test]
    fn round_trips_and_rejects_tampering() {
        let sealed = encrypt("key-0123456789abcdef0123456789abcdef", "s3cret").unwrap();
        assert_eq!(
            decrypt("key-0123456789abcdef0123456789abcdef", &sealed).unwrap(),
            "s3cret"
        );
        assert!(decrypt("different-key-0123456789abcdef0123", &sealed).is_err());
        let mut tampered = sealed.clone();
        if let Some(last) = tampered.pop() {
            tampered.push(if last == 'A' { 'B' } else { 'A' });
        }
        assert!(decrypt("key-0123456789abcdef0123456789abcdef", &tampered).is_err());
        assert!(decrypt("key", "v2.a.b.c").is_err());
    }

    #[test]
    fn sha_and_hmac_vectors() {
        assert_eq!(
            sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hmac_sha256_hex(b"key", "data").len(), 64);
    }

    #[test]
    fn constant_time_compare() {
        assert!(safe_equal("abc", "abc"));
        assert!(!safe_equal("abc", "abd"));
        assert!(!safe_equal("abc", "ab"));
    }

    #[test]
    fn codes_are_zero_padded() {
        for _ in 0..50 {
            let code = random_code(6);
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn low_entropy_digests_verify_both_formats() {
        let secret = "k".repeat(40);
        let digest = hash_low_entropy(&secret, "123456");
        assert!(digest.starts_with(KEYED_DIGEST_PREFIX));
        assert!(verify_low_entropy(&secret, "123456", Some(&digest)));
        assert!(!verify_low_entropy(&secret, "123457", Some(&digest)));
        let legacy = sha256("123456");
        assert!(verify_low_entropy(&secret, "123456", Some(&legacy)));
    }

    #[test]
    fn tokens_are_url_safe() {
        let token = random_token(32);
        assert!(!token.contains('='));
        assert!(token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn the_derived_key_cache_is_bounded_and_deterministic() {
        let mut cache: DerivedKeyCache = HashMap::new();
        for index in 0..DERIVED_KEY_CACHE_LIMIT {
            store_derived_key(
                &mut cache,
                format!("key-{index}"),
                Arc::new([index as u8; 32]),
            );
        }
        assert_eq!(cache.len(), DERIVED_KEY_CACHE_LIMIT);
        // Reaching the bound clears the map; the newly derived key is the only
        // occupant, so no arbitrary hash-map entry survives.
        store_derived_key(&mut cache, "overflow".to_string(), Arc::new([0xFF; 32]));
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("overflow"));
    }
}
