//! Publishable keys, cookie names and lifetime constants, ported from
//! `packages/shared/src/keys.ts`.

use base64::Engine;

/// Publishable key format: `pk_(test|live)_<base64url(frontendApiUrl)>`.
pub fn encode_publishable_key(frontend_api: &str, env: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(frontend_api.as_bytes());
    format!("pk_{env}_{encoded}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishableKey {
    pub frontend_api: String,
    pub env: String,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("Invalid OrbitID publishable key")]
pub struct InvalidPublishableKey;

/// Decodes a publishable key. The accepted alphabet and shape match the TS regex.
pub fn decode_publishable_key(pk: &str) -> Result<PublishableKey, InvalidPublishableKey> {
    let rest = pk
        .strip_prefix("pk_test_")
        .map(|rest| ("test", rest))
        .or_else(|| pk.strip_prefix("pk_live_").map(|rest| ("live", rest)))
        .ok_or(InvalidPublishableKey)?;
    let (env, encoded) = rest;
    let valid = !encoded.is_empty()
        && encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !valid {
        return Err(InvalidPublishableKey);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| InvalidPublishableKey)?;
    let frontend_api = String::from_utf8(bytes).map_err(|_| InvalidPublishableKey)?;
    Ok(PublishableKey {
        frontend_api,
        env: env.to_string(),
    })
}

pub fn is_publishable_key(key: &str) -> bool {
    key.starts_with("pk_test_") || key.starts_with("pk_live_")
}

pub fn is_secret_key(key: &str) -> bool {
    key.starts_with("sk_test_") || key.starts_with("sk_live_")
}

/// Browser-owned cookies are capped at 400 days by browsers and rewritten on use.
pub const COOKIE_MAX_AGE_SECONDS: i64 = 400 * 24 * 60 * 60;

/// `sessions.expire_at` for an unlimited-lifetime session.
pub const SESSION_NEVER_EXPIRES_AT: i64 = 8_640_000_000_000_000;

/// Cookie names.
pub mod cookies {
    pub const SESSION: &str = "__session";
    pub const CLIENT: &str = "__client";
    pub const CLIENT_UAT: &str = "__client_uat";
    pub const HANDSHAKE: &str = "__orbit_handshake";
    pub const DEV_BROWSER: &str = "__orbit_db_jwt";
    pub const TRUSTED_DEVICE: &str = "__orbit_trusted";
    /// Dashboard operator session; HttpOnly, `Path=/v1`, `SameSite=Strict`.
    pub const OPERATOR: &str = "__orbit_operator";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publishable_key_round_trip() {
        let key = encode_publishable_key("http://localhost:4000", "test");
        assert_eq!(key, "pk_test_aHR0cDovL2xvY2FsaG9zdDo0MDAw");
        let decoded = decode_publishable_key(&key).unwrap();
        assert_eq!(decoded.frontend_api, "http://localhost:4000");
        assert_eq!(decoded.env, "test");
    }

    #[test]
    fn rejects_invalid_keys() {
        assert!(decode_publishable_key("pk_test_***").is_err());
        assert!(decode_publishable_key("sk_test_abc").is_err());
        assert!(decode_publishable_key("pk_prod_abc").is_err());
        assert!(is_publishable_key("pk_live_abc"));
        assert!(is_secret_key("sk_test_abc"));
        assert!(!is_secret_key("pk_test_abc"));
    }
}
