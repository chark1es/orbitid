//! Minimal JWT/JWKS verification for identity-provider ID tokens.
//!
//! Mirrors the `jose` calls the TypeScript server makes: verify against a remote
//! JWKS, pin the accepted algorithms (RS256/ES256/PS256/EdDSA), check issuer,
//! audience, expiry and — when one was sent — the nonce. Key sets are cached for
//! five minutes because they are safely re-fetchable data.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Header, Validation};
use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::safe_fetch::{safe_fetch, SafeFetchOptions};
use orbitid_core::AppState;
use serde_json::Value;
use url::Url;

use crate::error::callback_error;

/// The algorithms OrbitID accepts for provider ID tokens. Pinning these blocks
/// the "alg confusion" attack where an RSA public key is used as an HMAC secret.
pub const ACCEPTED_ALGORITHMS: [Algorithm; 4] = [
    Algorithm::RS256,
    Algorithm::ES256,
    Algorithm::PS256,
    Algorithm::EdDSA,
];

/// `jose`'s `decodeJwt`: base64url payload decoded without verifying anything.
pub fn decode_claims(token: &str) -> Result<Value, OrbitError> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| callback_error("Identity provider returned a malformed ID token"))?;
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        payload.trim_end_matches('='),
    )
    .map_err(|_| callback_error("Identity provider returned a malformed ID token"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| callback_error("Identity provider returned a malformed ID token"))
}

#[derive(Clone)]
struct CachedJwks {
    set: JwkSet,
    expires_at: Instant,
}

fn cache() -> &'static RwLock<HashMap<String, CachedJwks>> {
    static CACHE: OnceLock<RwLock<HashMap<String, CachedJwks>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Forgets cached key sets (tests change providers between cases).
pub fn reset_jwks_cache() {
    if let Ok(mut guard) = cache().write() {
        guard.clear();
    }
}

fn cache_ttl() -> Duration {
    Duration::from_secs(5 * 60)
}

/// Loads a provider's JWKS through the SSRF guard. `force_refresh` bypasses the
/// cache once, which is what the adapters do after a signature failure to survive
/// a normal key rotation.
pub async fn remote_jwks(
    state: Option<&AppState>,
    uri: &str,
    force_refresh: bool,
) -> Result<JwkSet, OrbitError> {
    if !force_refresh {
        if let Ok(guard) = cache().read() {
            if let Some(cached) = guard.get(uri) {
                if cached.expires_at > Instant::now() {
                    return Ok(cached.set.clone());
                }
            }
        }
    }
    let host = Url::parse(uri)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| "the identity provider".to_string());
    let response = safe_fetch(
        state,
        uri,
        SafeFetchOptions {
            timeout_ms: Some(5_000),
            max_bytes: Some(256 * 1024),
            headers: orbitid_core::safe_fetch::headers(&[("accept", "application/json")]),
            ..SafeFetchOptions::default()
        },
    )
    .await?;
    if !response.ok() {
        return Err(OrbitError::bad_request(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!(
                "Could not load the key set from {host} ({})",
                response.status
            ),
        ));
    }
    let set: JwkSet = serde_json::from_str(&response.body).map_err(|_| {
        OrbitError::bad_request(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("The key set at {host} has no keys"),
        )
    })?;
    if set.keys.is_empty() {
        return Err(OrbitError::bad_request(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("The key set at {host} has no keys"),
        ));
    }
    if let Ok(mut guard) = cache().write() {
        guard.insert(
            uri.to_string(),
            CachedJwks {
                set: set.clone(),
                expires_at: Instant::now() + cache_ttl(),
            },
        );
    }
    Ok(set)
}

fn header_of(token: &str) -> Result<Header, OrbitError> {
    jsonwebtoken::decode_header(token).map_err(|_| {
        callback_error("The identity provider returned an ID token that could not be verified")
    })
}

/// Claim checks matching `jose`'s `jwtVerify` (`jwt_claims_set.js`): `jsonwebtoken`
/// silently skips unparseable optional time claims and accepts an `iss` array.
fn claims_are_valid(
    claims: &Value,
    issuer: Option<&str>,
    audience: &str,
    leeway_seconds: u64,
) -> bool {
    let Some(map) = claims.as_object() else {
        return false;
    };
    if let Some(issuer) = issuer {
        if map.get("iss").and_then(Value::as_str) != Some(issuer) {
            return false;
        }
    }
    let audience_ok = match map.get("aud") {
        Some(Value::String(value)) => value == audience,
        Some(Value::Array(values)) => values.iter().any(|value| value.as_str() == Some(audience)),
        _ => false,
    };
    if !audience_ok {
        return false;
    }
    let now = (crate::http::now_ms() / 1000) as f64;
    let tolerance = leeway_seconds as f64;
    // `iat`, when present, must be a number (no age check without `maxTokenAge`).
    if matches!(map.get("iat"), Some(value) if !value.is_number()) {
        return false;
    }
    if let Some(nbf) = map.get("nbf") {
        match nbf.as_f64() {
            Some(nbf) if nbf <= now + tolerance => {}
            _ => return false,
        }
    }
    if let Some(exp) = map.get("exp") {
        match exp.as_f64() {
            Some(exp) if exp > now - tolerance => {}
            _ => return false,
        }
    }
    true
}

fn key_candidates<'a>(set: &'a JwkSet, header: &Header) -> Vec<&'a Jwk> {
    set.keys
        .iter()
        .filter(|jwk| match (&header.kid, &jwk.common.key_id) {
            (Some(kid), Some(candidate)) => kid == candidate,
            (Some(_), None) => false,
            (None, _) => true,
        })
        .filter(|jwk| match jwk.common.key_algorithm {
            Some(algorithm) => algorithm.to_string() == format!("{:?}", header.alg),
            None => true,
        })
        .collect()
}

/// Verifies an ID token against a JWKS. When `nonce` is set the token must repeat it.
///
/// A failed signature check is final here; callers that want the key-rotation
/// retry call this twice with a fresh key set.
pub fn verify_id_token(
    set: &JwkSet,
    token: &str,
    issuer: Option<&str>,
    audience: &str,
    leeway_seconds: u64,
    nonce: Option<&str>,
) -> Result<Value, OrbitError> {
    let header = header_of(token)?;
    if !ACCEPTED_ALGORITHMS.contains(&header.alg) {
        return Err(callback_error(
            "The identity provider returned an ID token that could not be verified",
        ));
    }
    let candidates = key_candidates(set, &header);
    if candidates.is_empty() {
        return Err(callback_error(
            "The identity provider returned an ID token that could not be verified",
        ));
    }

    // Signature and algorithm are checked by `jsonwebtoken`; every claim is checked by
    // `claims_are_valid` below.
    let mut validation = Validation::new(header.alg);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;

    let issuer = issuer.filter(|value| !value.is_empty());
    for jwk in candidates {
        let Ok(key) = DecodingKey::from_jwk(jwk) else {
            continue;
        };
        let Ok(decoded) = decode::<Value>(token, &key, &validation) else {
            continue;
        };
        if !claims_are_valid(&decoded.claims, issuer, audience, leeway_seconds) {
            return Err(callback_error(
                "The identity provider returned an ID token that could not be verified",
            ));
        }
        if let Some(nonce) = nonce {
            if decoded.claims.get("nonce").and_then(Value::as_str) != Some(nonce) {
                return Err(callback_error(
                    "The identity provider returned an ID token whose nonce did not match",
                ));
            }
        }
        return Ok(decoded.claims);
    }
    Err(callback_error(
        "The identity provider returned an ID token that could not be verified",
    ))
}

/// Signs an ES256 JWT with a PKCS#8 (`.p8`) private key. Used for Apple's client secret.
pub fn sign_es256_pem(
    claims: &Value,
    kid: &str,
    private_key_pem: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(kid.to_string());
    header.typ = Some("JWT".to_string());
    let key = jsonwebtoken::EncodingKey::from_ec_pem(private_key_pem.as_bytes())?;
    jsonwebtoken::encode(&header, claims, &key)
}

#[cfg(test)]
mod tests;
