//! Compact JWS serialization and claim validation.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::jwk::{b64_decode, b64_encode, Jwk, JwkError};
use super::jwks::JwkSet;
use super::JwsAlgorithm;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The protected header this server writes for its own tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwsHeader {
    pub alg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typ: Option<String>,
}

/// Validation parameters for [`verify_jws`], mirroring the `jose.jwtVerify`
/// options this server passes.
#[derive(Debug, Clone, Default)]
pub struct VerifyOptions {
    /// Accepted `alg` values. Empty means "any algorithm the key supports".
    pub algorithms: Vec<JwsAlgorithm>,
    /// Accepted issuers (exact match).
    pub issuer: Option<Vec<String>>,
    /// Accepted audiences (any overlap).
    pub audience: Option<Vec<String>>,
    /// Clock tolerance in seconds for `exp`/`nbf`.
    pub clock_tolerance_seconds: i64,
}

fn now_seconds() -> i64 {
    orbitid_core::http::now() / 1000
}

/// Signs `claims` as a compact JWS. `kid` is written into the protected header
/// when supplied (the instance key path); template keys omit it, like `jose`.
pub fn sign_jws(
    claims: &Value,
    algorithm: JwsAlgorithm,
    key: &Jwk,
    kid: Option<&str>,
) -> Result<String, JwkError> {
    if !key.has_private() {
        return Err(JwkError::KeyMismatch);
    }
    if !key.supports(algorithm) {
        return Err(JwkError::KeyMismatch);
    }
    let header = JwsHeader {
        alg: algorithm.as_str().to_string(),
        kid: kid.map(str::to_string),
        typ: Some("JWT".into()),
    };
    let header = serde_json::to_vec(&header)
        .map_err(|_| JwkError::InvalidToken("could not serialize header".into()))?;
    let payload = serde_json::to_vec(claims)
        .map_err(|_| JwkError::InvalidToken("could not serialize claims".into()))?;
    let signing_input = format!("{}.{}", b64_encode(&header), b64_encode(&payload));
    let signature = key.sign(algorithm, signing_input.as_bytes())?;
    Ok(format!("{signing_input}.{}", B64.encode(signature)))
}

/// Verifies a compact JWS against a local key set and validates its registered
/// claims. Returns the payload object.
pub fn verify_jws(token: &str, keys: &JwkSet, options: &VerifyOptions) -> Result<Value, JwkError> {
    let mut parts = token.split('.');
    let (Some(header_part), Some(payload_part), Some(signature_part), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(JwkError::InvalidToken("expected three segments".into()));
    };
    let header_bytes = B64
        .decode(header_part)
        .map_err(|_| JwkError::InvalidToken("header is not base64url".into()))?;
    let header: Value = serde_json::from_slice(&header_bytes)
        .map_err(|_| JwkError::InvalidToken("header is not JSON".into()))?;
    let header = header
        .as_object()
        .ok_or_else(|| JwkError::InvalidToken("header is not an object".into()))?;
    let alg_name = header
        .get("alg")
        .and_then(Value::as_str)
        .ok_or_else(|| JwkError::InvalidToken("missing alg".into()))?;
    let algorithm = JwsAlgorithm::parse(alg_name)
        .ok_or_else(|| JwkError::UnsupportedAlgorithm(alg_name.to_string()))?;
    if !options.algorithms.is_empty() && !options.algorithms.contains(&algorithm) {
        return Err(JwkError::UnsupportedAlgorithm(alg_name.to_string()));
    }
    let kid = header.get("kid").and_then(Value::as_str);
    let candidates = keys.candidates(kid, algorithm);
    if candidates.is_empty() {
        return Err(JwkError::InvalidSignature);
    }
    let signature = b64_decode(signature_part)?;
    let signing_input = format!("{header_part}.{payload_part}");
    let mut verified = false;
    for key in candidates {
        if key
            .verify(algorithm, signing_input.as_bytes(), &signature)
            .is_ok()
        {
            verified = true;
            break;
        }
    }
    if !verified {
        return Err(JwkError::InvalidSignature);
    }
    let payload_bytes = b64_decode(payload_part)?;
    let payload: Value = serde_json::from_slice(&payload_bytes)
        .map_err(|_| JwkError::InvalidToken("payload is not JSON".into()))?;
    let payload_map = payload
        .as_object()
        .ok_or_else(|| JwkError::InvalidToken("payload is not an object".into()))?;
    validate_claims(payload_map, options)?;
    Ok(payload)
}

fn numeric_claim(map: &Map<String, Value>, claim: &str) -> Result<Option<i64>, JwkError> {
    match map.get(claim) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value as i64))
            .map(Some)
            .ok_or_else(|| JwkError::InvalidClaims(format!("{claim} is not a number"))),
        Some(_) => Err(JwkError::InvalidClaims(format!("{claim} is not a number"))),
    }
}

fn validate_claims(map: &Map<String, Value>, options: &VerifyOptions) -> Result<(), JwkError> {
    let now = now_seconds();
    let tolerance = options.clock_tolerance_seconds;
    if let Some(exp) = numeric_claim(map, "exp")? {
        if exp + tolerance < now {
            return Err(JwkError::Expired);
        }
    }
    if let Some(nbf) = numeric_claim(map, "nbf")? {
        if nbf > now + tolerance {
            return Err(JwkError::NotYetValid);
        }
    }
    if let Some(expected) = &options.issuer {
        let issuer = map.get("iss").and_then(Value::as_str);
        if !issuer.is_some_and(|issuer| expected.iter().any(|value| value == issuer)) {
            return Err(JwkError::InvalidClaims("unexpected iss".into()));
        }
    }
    if let Some(expected) = &options.audience {
        let matches = match map.get("aud") {
            Some(Value::String(value)) => expected.iter().any(|audience| audience == value),
            Some(Value::Array(values)) => values.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|value| expected.iter().any(|audience| audience == value))
            }),
            _ => false,
        };
        if !matches {
            return Err(JwkError::InvalidClaims("unexpected aud".into()));
        }
    }
    Ok(())
}

/// Decodes a JWT payload without verifying it (used for diagnostics/logout
/// hints, mirroring `jose.decodeJwt`). Returns `None` for malformed input.
pub fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = b64_decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_tokens() {
        let keys = JwkSet::default();
        assert!(verify_jws("a.b", &keys, &VerifyOptions::default()).is_err());
        assert!(verify_jws("a.b.c.d", &keys, &VerifyOptions::default()).is_err());
        assert!(verify_jws("!!!.e30.!!!", &keys, &VerifyOptions::default()).is_err());
    }
}
