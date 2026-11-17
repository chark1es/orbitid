//! Password policy, argon2id hashing and imported-digest verification, ported
//! from `services/passwords.ts`.
//!
//! Argon2id uses the same parameters as the TypeScript server's production
//! path (`m=19456, t=2, p=1`), so hashes written by `@node-rs/argon2` verify
//! here and hashes written here verify there. Bcrypt and scrypt digests are
//! accepted for imported users, with the same conservative work-factor caps.

use argon2::password_hash::{PasswordHasher as _, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use sha1::{Digest, Sha1};

use orbitid_core::error::{error_codes, ApiErrorItem, OrbitError, Result};
use orbitid_core::safe_fetch::{self, SafeFetchOptions};
use orbitid_core::settings::{InstanceSettings, PasswordSettings};
use orbitid_core::AppState;

use crate::limits::run_cpu;
use crate::password_digest::{parse_scrypt_digest, password_digest_kind, DigestKind};

/// Production Argon2id parameters, matching `HASH_OPTIONS` outside test runs.
pub const ARGON2_MEMORY_COST: u32 = 19_456;
pub const ARGON2_TIME_COST: u32 = 2;
pub const ARGON2_PARALLELISM: u32 = 1;
pub const ARGON2_SALT_BYTES: usize = 16;
pub const ARGON2_HASH_BYTES: usize = 32;

/// Hashers accepted by the Backend API user import.
pub const PASSWORD_HASHERS: [&str; 3] = ["argon2", "bcrypt", "scrypt"];

/// The `password_hasher` wire value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordHasher {
    Argon2,
    Bcrypt,
    Scrypt,
}

impl PasswordHasher {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Argon2 => "argon2",
            Self::Bcrypt => "bcrypt",
            Self::Scrypt => "scrypt",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "argon2" => Some(Self::Argon2),
            "bcrypt" => Some(Self::Bcrypt),
            "scrypt" => Some(Self::Scrypt),
            _ => None,
        }
    }
}

impl From<DigestKind> for PasswordHasher {
    fn from(kind: DigestKind) -> Self {
        match kind {
            DigestKind::Argon2 => Self::Argon2,
            DigestKind::Bcrypt => Self::Bcrypt,
            DigestKind::Scrypt => Self::Scrypt,
        }
    }
}

/// Rejects a `password_hasher` this deployment cannot verify.
pub fn assert_password_hasher(hasher: &str) -> Result<PasswordHasher> {
    PasswordHasher::parse(hasher).ok_or_else(|| {
        OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!(
                "password_hasher must be one of {}.",
                PASSWORD_HASHERS.join(", ")
            ),
        )
        .with_meta(serde_json::json!({ "param_name": "password_hasher" }))
    })
}

/// Rejects malformed, mismatched or excessive-cost imported digests before
/// they are persisted.
pub fn assert_password_digest(digest: &str, hasher: &str) -> Result<()> {
    let expected = assert_password_hasher(hasher)?;
    if password_digest_kind(digest).map(PasswordHasher::from) != Some(expected) {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PARAM_VALUE_INVALID,
            "password_digest is malformed, does not match password_hasher, or exceeds the supported cost limits.",
        )
        .with_meta(serde_json::json!({ "param_name": "password_digest" })));
    }
    Ok(())
}

/// Backend API password-policy check: one violation per missing requirement
/// (unlike [`password_problems`], which returns an entry per problem).
pub fn assert_password_policy(
    settings: &InstanceSettings,
    password: &str,
    param_name: &str,
) -> Result<()> {
    let policy = &settings.password;
    let length = js_length(password);
    if length < policy.min_length as usize {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT,
            format!(
                "Passwords must be at least {} characters long.",
                policy.min_length
            ),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    }
    if length > policy.max_length as usize {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT,
            format!(
                "Passwords must be at most {} characters long.",
                policy.max_length
            ),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    }
    let mut missing = Vec::new();
    if policy.require_lowercase && !password.chars().any(|ch| ch.is_ascii_lowercase()) {
        missing.push("a lowercase letter");
    }
    if policy.require_uppercase && !password.chars().any(|ch| ch.is_ascii_uppercase()) {
        missing.push("an uppercase letter");
    }
    if policy.require_numbers && !password.chars().any(|ch| ch.is_ascii_digit()) {
        missing.push("a number");
    }
    if policy.require_special_character && !password.chars().any(|ch| !ch.is_ascii_alphanumeric()) {
        missing.push("a special character");
    }
    if !missing.is_empty() {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH,
            format!("Passwords must contain {}.", missing.join(", ")),
        )
        .with_meta(serde_json::json!({ "param_name": param_name })));
    }
    Ok(())
}

/// One policy violation, in the shape used by the Backend API as well.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordPolicyProblem {
    pub code: String,
    pub message: String,
}

fn hash_blocking(password: &str) -> Result<String> {
    let params = Params::new(
        ARGON2_MEMORY_COST,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(ARGON2_HASH_BYTES),
    )
    .map_err(|error| OrbitError::internal(format!("Invalid argon2 parameters: {error}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut salt_bytes = [0u8; ARGON2_SALT_BYTES];
    rand::rng().fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|error| OrbitError::internal(format!("Could not encode argon2 salt: {error}")))?;
    argon
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| OrbitError::internal(format!("Could not hash password: {error}")))
}

/// Hashes a password with Argon2id on the blocking pool.
pub async fn hash_password(password: &str) -> Result<String> {
    let password = password.to_string();
    run_cpu(move || hash_blocking(&password)).await?
}

fn verify_argon2(hash: &str, password: &str) -> bool {
    let Ok(parsed) = argon2::password_hash::PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

fn verify_scrypt(digest: &str, password: &str) -> bool {
    let Some(parsed) = parse_scrypt_digest(digest) else {
        return false;
    };
    let log_n = parsed.n.trailing_zeros() as u8;
    let Ok(params) = scrypt::Params::new(log_n, parsed.r, parsed.p, parsed.expected.len()) else {
        return false;
    };
    let mut actual = vec![0u8; parsed.expected.len()];
    if scrypt::scrypt(password.as_bytes(), &parsed.salt, &params, &mut actual).is_err() {
        return false;
    }
    if actual.len() != parsed.expected.len() {
        return false;
    }
    bool::from(subtle::ConstantTimeEq::ct_eq(
        actual.as_slice(),
        parsed.expected.as_slice(),
    ))
}

/// Verifies a stored digest of any supported format. Never panics and never
/// spends more than the parser-approved work factor.
pub async fn verify_password(password_hash: &str, password: &str) -> bool {
    let Some(kind) = password_digest_kind(password_hash) else {
        return false;
    };
    let hash = password_hash.to_string();
    let password = password.to_string();
    run_cpu(move || match kind {
        DigestKind::Argon2 => verify_argon2(&hash, &password),
        DigestKind::Bcrypt => bcrypt::verify(&password, &hash).unwrap_or(false),
        DigestKind::Scrypt => verify_scrypt(&hash, &password),
    })
    .await
    .unwrap_or(false)
}

fn sha1_hex_upper(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let digest = Sha1::digest(value.as_bytes());
    let mut out = String::with_capacity(40);
    for byte in digest {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// HaveIBeenPwned k-anonymity range check. Fails **open** on network errors so
/// password changes never depend on a third party being reachable.
pub async fn is_password_pwned(state: Option<&AppState>, password: &str) -> bool {
    let digest = sha1_hex_upper(password);
    let (prefix, suffix) = digest.split_at(5);
    let url = format!("https://api.pwnedpasswords.com/range/{prefix}");
    let result = safe_fetch::safe_fetch(
        state,
        &url,
        SafeFetchOptions {
            headers: safe_fetch::headers(&[("Add-Padding", "true"), ("User-Agent", "OrbitID")]),
            timeout_ms: Some(4_000),
            max_bytes: Some(256 * 1024),
            ..Default::default()
        },
    )
    .await;
    let Ok(response) = result else {
        return false;
    };
    if !response.ok() {
        return false;
    }
    for line in response.body.split('\n') {
        let mut parts = line.trim().split(':');
        let (Some(hash_suffix), Some(count)) = (parts.next(), parts.next()) else {
            continue;
        };
        if hash_suffix.eq_ignore_ascii_case(suffix)
            && count.trim().parse::<u64>().is_ok_and(|count| count > 0)
        {
            return true;
        }
    }
    false
}

fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Pure policy check, reused by the Backend API user import.
pub fn password_problems(password: &str, policy: &PasswordSettings) -> Vec<PasswordPolicyProblem> {
    let mut problems = Vec::new();
    let length = js_length(password);
    if length < policy.min_length as usize {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT.into(),
            message: format!(
                "Passwords must be at least {} characters long.",
                policy.min_length
            ),
        });
    }
    if length > policy.max_length as usize {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT.into(),
            message: format!(
                "Passwords must be at most {} characters long.",
                policy.max_length
            ),
        });
    }
    if policy.require_lowercase && !password.chars().any(|ch| ch.is_ascii_lowercase()) {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH.into(),
            message: "Passwords must contain a lowercase letter.".into(),
        });
    }
    if policy.require_uppercase && !password.chars().any(|ch| ch.is_ascii_uppercase()) {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH.into(),
            message: "Passwords must contain an uppercase letter.".into(),
        });
    }
    if policy.require_numbers && !password.chars().any(|ch| ch.is_ascii_digit()) {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH.into(),
            message: "Passwords must contain a number.".into(),
        });
    }
    if policy.require_special_character && !password.chars().any(|ch| !ch.is_ascii_alphanumeric()) {
        problems.push(PasswordPolicyProblem {
            code: error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH.into(),
            message: "Passwords must contain a special character.".into(),
        });
    }
    problems
}

/// Validates a password against the instance policy and, when enabled, HIBP.
pub async fn assert_password_valid(state: &AppState, password: &str) -> Result<()> {
    let policy = state.settings.get().password.clone();
    let problems = password_problems(password, &policy);
    if !problems.is_empty() {
        let first = &problems[0];
        let items = problems
            .iter()
            .map(|problem| ApiErrorItem {
                code: problem.code.clone(),
                message: problem.message.clone(),
                long_message: None,
                meta: Some(serde_json::json!({ "param_name": "password" })),
            })
            .collect();
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            first.code.clone(),
            first.message.clone(),
        )
        .with_meta(serde_json::json!({
            "param_name": "password",
            "min_length": policy.min_length,
            "max_length": policy.max_length,
            "require_lowercase": policy.require_lowercase,
            "require_uppercase": policy.require_uppercase,
            "require_numbers": policy.require_numbers,
            "require_special_char": policy.require_special_character,
        }))
        .with_items(items));
    }
    if policy.reject_pwned && is_password_pwned(Some(state), password).await {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PASSWORD_PWNED,
            "This password has been found in a data breach. Please choose another one.",
        )
        .with_meta(serde_json::json!({ "param_name": "password" })));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hashes_and_verifies_argon2id() {
        let hash = hash_password("correct horse battery staple").await.unwrap();
        assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_password(&hash, "correct horse battery staple").await);
        assert!(!verify_password(&hash, "wrong").await);
    }

    #[test]
    fn backend_digest_helpers_validate_kind_and_limits() {
        let scrypt = "scrypt$16384$8$1$c2FmZS1pbXBvcnQtc2FsdA==$AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        assert!(assert_password_digest(scrypt, "scrypt").is_ok());
        assert!(assert_password_digest(scrypt, "argon2").is_err());
        assert!(assert_password_hasher("md5").is_err());
        assert_eq!(
            assert_password_hasher("bcrypt").unwrap(),
            PasswordHasher::Bcrypt
        );
    }

    #[test]
    fn backend_policy_aggregates_missing_requirements() {
        let settings = InstanceSettings::default();
        assert!(assert_password_policy(&settings, "Abcdefg1!", "password").is_ok());
        let error = assert_password_policy(&settings, "short", "password").unwrap_err();
        assert_eq!(error.code, error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT);
        let mut policy = settings.clone();
        policy.password.require_lowercase = true;
        policy.password.require_uppercase = true;
        policy.password.require_numbers = true;
        policy.password.require_special_character = true;
        let error = assert_password_policy(&policy, "abcdefgh", "password").unwrap_err();
        assert_eq!(error.code, error_codes::FORM_PASSWORD_NOT_STRONG_ENOUGH);
        assert!(error.message.contains("an uppercase letter"));
        assert!(error.message.contains("a number"));
    }

    #[test]
    fn policy_reports_the_same_messages() {
        let policy = PasswordSettings {
            min_length: 8,
            max_length: 20,
            require_lowercase: true,
            require_uppercase: true,
            require_numbers: true,
            require_special_character: true,
            ..PasswordSettings::default()
        };
        let problems = password_problems("abc", &policy);
        assert_eq!(
            problems[0].code,
            error_codes::FORM_PASSWORD_LENGTH_TOO_SHORT
        );
        assert_eq!(
            problems[0].message,
            "Passwords must be at least 8 characters long."
        );
        assert!(password_problems("Abcdefg1!", &policy).is_empty());
    }
}
