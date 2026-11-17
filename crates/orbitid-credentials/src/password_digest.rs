//! Imported password digest parsing, ported from `lib/password-digest.ts`.
//!
//! Imported hashes are untrusted work-factor instructions: every parser bounds
//! the cost before a verifier runs, and the digest length is capped.

use regex::Regex;

/// Supported stored formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestKind {
    Argon2,
    Bcrypt,
    Scrypt,
}

/// Larger stored values are refused before any parser or verifier runs.
pub const MAX_DIGEST_LENGTH: usize = 1024;

const BASE64_CHARS: &str = r"^[A-Za-z0-9+/_-]+={0,2}$";

/// A parsed `scrypt$N$r$p$salt$key` digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScryptDigest {
    pub n: u64,
    pub r: u32,
    pub p: u32,
    pub salt: Vec<u8>,
    pub expected: Vec<u8>,
}

fn pattern(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let normalized: String = value
        .trim_end_matches('=')
        .chars()
        .map(|ch| match ch {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(normalized)
        .ok()
}

/// Parses the scrypt digest format after enforcing the same work-factor bounds
/// as the TypeScript parser.
pub fn parse_scrypt_digest(digest: &str) -> Option<ScryptDigest> {
    let parts: Vec<&str> = digest.split('$').collect();
    if parts.len() != 6 || parts[0] != "scrypt" {
        return None;
    }
    let digits = pattern(r"^\d+$")?;
    if !parts[1..4].iter().all(|part| digits.is_match(part)) {
        return None;
    }
    let n: u64 = parts[1].parse().ok()?;
    let r: u64 = parts[2].parse().ok()?;
    let p: u64 = parts[3].parse().ok()?;
    if !(2..=65_536).contains(&n) || !n.is_power_of_two() {
        return None;
    }
    if !(1..=16).contains(&r) || !(1..=4).contains(&p) {
        return None;
    }
    if 128 * n as u128 * r as u128 > 128 * 1024 * 1024 {
        return None;
    }
    if n as u128 * r as u128 * p as u128 > 2_097_152 {
        return None;
    }
    let base64 = pattern(BASE64_CHARS)?;
    if !base64.is_match(parts[4]) || !base64.is_match(parts[5]) {
        return None;
    }
    let salt = decode_base64(parts[4])?;
    let expected = decode_base64(parts[5])?;
    if !(8..=64).contains(&salt.len()) || !(16..=64).contains(&expected.len()) {
        return None;
    }
    Some(ScryptDigest {
        n,
        r: r as u32,
        p: p as u32,
        salt,
        expected,
    })
}

/// The stored format of a digest, or `None` when it is unsupported or its work
/// factor exceeds the import limits.
pub fn password_digest_kind(digest: &str) -> Option<DigestKind> {
    if digest.is_empty() || digest.len() > MAX_DIGEST_LENGTH {
        return None;
    }
    if digest.starts_with("scrypt$") {
        return parse_scrypt_digest(digest).map(|_| DigestKind::Scrypt);
    }
    let bcrypt = pattern(r"^\$2[abxy]\$(\d{2})\$[./A-Za-z0-9]{53}$")?;
    if let Some(captures) = bcrypt.captures(digest) {
        let cost: u32 = captures.get(1)?.as_str().parse().ok()?;
        return (4..=14).contains(&cost).then_some(DigestKind::Bcrypt);
    }
    let argon = pattern(
        r"^\$argon2(?:id|i|d)\$v=(?:16|19)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$",
    )?;
    let captures = argon.captures(digest)?;
    let m: u64 = captures.get(1)?.as_str().parse().ok()?;
    let t: u64 = captures.get(2)?.as_str().parse().ok()?;
    let p: u64 = captures.get(3)?.as_str().parse().ok()?;
    if m < 8 * p || m > 65_536 || !(1..=8).contains(&t) || !(1..=4).contains(&p) || m * t > 262_144
    {
        return None;
    }
    let salt = decode_base64(captures.get(4)?.as_str())?;
    let hash = decode_base64(captures.get(5)?.as_str())?;
    if salt.len() < 8 || hash.len() < 16 {
        return None;
    }
    Some(DigestKind::Argon2)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRYPT: &str =
        "scrypt$16384$8$1$c2FmZS1pbXBvcnQtc2FsdA==$AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    #[test]
    fn classifies_supported_formats() {
        assert_eq!(password_digest_kind(SCRYPT), Some(DigestKind::Scrypt));
        assert_eq!(
            password_digest_kind("$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234"),
            Some(DigestKind::Bcrypt)
        );
        assert_eq!(
            password_digest_kind(
                "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000"
            ),
            Some(DigestKind::Argon2)
        );
    }

    #[test]
    fn refuses_unsafe_work_factors_and_oversized_values() {
        assert_eq!(
            password_digest_kind(&SCRYPT.replace("16384", "1073741824")),
            None
        );
        assert_eq!(
            password_digest_kind(&SCRYPT.replace("$8$1$", "$8$999999$")),
            None
        );
        assert_eq!(
            password_digest_kind("$argon2id$v=19$m=999999999,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000"),
            None
        );
        assert_eq!(
            password_digest_kind(&format!("$2b$31${}", "a".repeat(53))),
            None
        );
        assert_eq!(password_digest_kind(&"x".repeat(1025)), None);
    }

    #[test]
    fn parses_a_scrypt_digest() {
        let parsed = parse_scrypt_digest(SCRYPT).unwrap();
        assert_eq!(parsed.n, 16384);
        assert_eq!(parsed.r, 8);
        assert_eq!(parsed.p, 1);
    }
}
