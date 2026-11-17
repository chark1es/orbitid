//! JSON Web Keys: parsing, export and the signing/verification primitives
//! behind [`super::sign_jws`]. Supports the key types the server writes (RSA,
//! P-256, oct) plus Ed25519 for third-party JWKS documents.

use base64::Engine;
use ed25519_dalek::{Signer as _, Verifier as _};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rsa::traits::PublicKeyParts;
use rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::{Map, Value};

use super::rsa::{add_rsa_private, b64_value, rsa_sign, rsa_verify};
use super::JwsAlgorithm;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Errors from JWK parsing and JWS verification.
#[derive(Debug, Clone, thiserror::Error)]
pub enum JwkError {
    #[error("Invalid JWK: {0}")]
    InvalidJwk(String),
    #[error("Unsupported algorithm: {0}")]
    UnsupportedAlgorithm(String),
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Invalid token: {0}")]
    InvalidToken(String),
    #[error("Token expired")]
    Expired,
    #[error("Token is not valid yet")]
    NotYetValid,
    #[error("Invalid claims: {0}")]
    InvalidClaims(String),
    #[error("Key material mismatch")]
    KeyMismatch,
    #[error("Remote JWKS fetch failed: {0}")]
    Fetch(String),
}

pub(crate) fn b64_decode(value: &str) -> Result<Vec<u8>, JwkError> {
    let trimmed = value.trim_end_matches('=');
    B64.decode(trimmed)
        .map_err(|_| JwkError::InvalidJwk("value is not base64url".into()))
}

pub(crate) fn b64_encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub(crate) fn string_field(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

pub(crate) fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

pub(crate) fn required<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, JwkError> {
    map.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| JwkError::InvalidJwk(format!("missing {key}")))
}

/// A JSON Web Key. Private material is optional; a public JWK parsed from a
/// JWKS document can verify but not sign.
#[derive(Clone)]
pub enum Jwk {
    Rsa {
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
        public: RsaPublicKey,
        private: Option<RsaPrivateKey>,
    },
    Ec {
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
        public: p256::PublicKey,
        private: Option<p256::SecretKey>,
    },
    Oct {
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
        secret: Vec<u8>,
    },
    Okp {
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
        public: ed25519_dalek::VerifyingKey,
        private: Option<ed25519_dalek::SigningKey>,
    },
}

impl std::fmt::Debug for Jwk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Jwk")
            .field("kid", &self.kid())
            .field("alg", &self.alg())
            .finish_non_exhaustive()
    }
}

impl Jwk {
    /// Parses a JWK object. `sign`/`use`/`kid` are carried through unchanged.
    pub fn from_value(value: &Value) -> Result<Self, JwkError> {
        let map = value
            .as_object()
            .ok_or_else(|| JwkError::InvalidJwk("expected an object".into()))?;
        let kid = non_empty(string_field(map, "kid"));
        let alg = non_empty(string_field(map, "alg"))
            .map(|value| {
                JwsAlgorithm::parse(&value)
                    .ok_or_else(|| JwkError::UnsupportedAlgorithm(value.clone()))
            })
            .transpose()?;
        let use_ = non_empty(string_field(map, "use"));
        let kty =
            string_field(map, "kty").ok_or_else(|| JwkError::InvalidJwk("missing kty".into()))?;
        match kty.as_str() {
            "RSA" => Self::parse_rsa(map, kid, alg, use_),
            "EC" => Self::parse_ec(map, kid, alg, use_),
            "oct" => {
                let secret = b64_decode(required(map, "k")?)?;
                if secret.is_empty() {
                    return Err(JwkError::InvalidJwk("empty HMAC secret".into()));
                }
                Ok(Self::Oct {
                    kid,
                    alg,
                    use_,
                    secret,
                })
            }
            "OKP" => Self::parse_okp(map, kid, alg, use_),
            other => Err(JwkError::InvalidJwk(format!("unsupported kty {other}"))),
        }
    }

    pub fn kid(&self) -> Option<&str> {
        match self {
            Self::Rsa { kid, .. }
            | Self::Ec { kid, .. }
            | Self::Oct { kid, .. }
            | Self::Okp { kid, .. } => kid.as_deref(),
        }
    }

    pub fn alg(&self) -> Option<JwsAlgorithm> {
        match self {
            Self::Rsa { alg, .. }
            | Self::Ec { alg, .. }
            | Self::Oct { alg, .. }
            | Self::Okp { alg, .. } => *alg,
        }
    }

    fn key_use(&self) -> Option<&str> {
        match self {
            Self::Rsa { use_, .. }
            | Self::Ec { use_, .. }
            | Self::Oct { use_, .. }
            | Self::Okp { use_, .. } => use_.as_deref(),
        }
    }

    /// True when this key can verify/sign `algorithm`.
    pub fn supports(&self, algorithm: JwsAlgorithm) -> bool {
        match self {
            Self::Rsa { .. } => algorithm.is_rsa(),
            Self::Ec { .. } => algorithm.is_ec(),
            Self::Oct { .. } => algorithm.is_hmac(),
            Self::Okp { .. } => algorithm == JwsAlgorithm::EdDsa,
        }
    }

    fn is_private(&self) -> bool {
        match self {
            Self::Rsa { private, .. } => private.is_some(),
            Self::Ec { private, .. } => private.is_some(),
            Self::Oct { .. } => true,
            Self::Okp { private, .. } => private.is_some(),
        }
    }

    /// Exports the key. `include_private` is ignored for public-only keys.
    pub fn to_value(&self, include_private: bool) -> Value {
        let mut map = Map::new();
        match self {
            Self::Rsa {
                kid,
                alg,
                use_,
                public,
                private,
            } => {
                map.insert("kty".into(), Value::String("RSA".into()));
                map.insert("n".into(), b64_value(&public.n().to_bytes_be()));
                map.insert("e".into(), b64_value(&public.e().to_bytes_be()));
                if include_private {
                    if let Some(private) = private {
                        add_rsa_private(&mut map, private);
                    }
                }
                add_metadata(&mut map, kid, *alg, use_);
            }
            Self::Ec {
                kid,
                alg,
                use_,
                public,
                private,
            } => {
                let point = public.to_encoded_point(false);
                map.insert("kty".into(), Value::String("EC".into()));
                map.insert("crv".into(), Value::String("P-256".into()));
                map.insert(
                    "x".into(),
                    b64_value(point.x().map(|x| x.as_slice()).unwrap_or(&[])),
                );
                map.insert(
                    "y".into(),
                    b64_value(point.y().map(|y| y.as_slice()).unwrap_or(&[])),
                );
                if include_private {
                    if let Some(private) = private {
                        map.insert("d".into(), b64_value(&private.to_bytes()));
                    }
                }
                add_metadata(&mut map, kid, *alg, use_);
            }
            Self::Oct {
                kid,
                alg,
                use_,
                secret,
            } => {
                map.insert("kty".into(), Value::String("oct".into()));
                map.insert("k".into(), b64_value(secret));
                add_metadata(&mut map, kid, *alg, use_);
            }
            Self::Okp {
                kid,
                alg,
                use_,
                public,
                private,
            } => {
                map.insert("kty".into(), Value::String("OKP".into()));
                map.insert("crv".into(), Value::String("Ed25519".into()));
                map.insert("x".into(), b64_value(public.as_bytes()));
                if include_private {
                    if let Some(private) = private {
                        map.insert("d".into(), b64_value(&private.to_bytes()));
                    }
                }
                add_metadata(&mut map, kid, *alg, use_);
            }
        }
        Value::Object(map)
    }

    /// Signs `data` with this key. Fails for public-only keys.
    pub fn sign(&self, algorithm: JwsAlgorithm, data: &[u8]) -> Result<Vec<u8>, JwkError> {
        if !self.supports(algorithm) {
            return Err(JwkError::KeyMismatch);
        }
        match self {
            Self::Rsa {
                public,
                private: Some(private),
                ..
            } => {
                let _ = public;
                rsa_sign(algorithm, private, data)
            }
            Self::Ec {
                public,
                private: Some(private),
                ..
            } => {
                let _ = public;
                let signing = p256::ecdsa::SigningKey::from(private.clone());
                let signature: p256::ecdsa::Signature = signing.sign(data);
                Ok(signature.to_bytes().to_vec())
            }
            Self::Oct { secret, .. } => Ok(super::hmac::sign(algorithm, secret, data)?),
            Self::Okp {
                private: Some(private),
                ..
            } => Ok(private.sign(data).to_bytes().to_vec()),
            _ => Err(JwkError::KeyMismatch),
        }
    }

    /// Verifies `data` against `signature`.
    pub fn verify(
        &self,
        algorithm: JwsAlgorithm,
        data: &[u8],
        signature: &[u8],
    ) -> Result<(), JwkError> {
        if !self.supports(algorithm) {
            return Err(JwkError::KeyMismatch);
        }
        match self {
            Self::Rsa { public, .. } => rsa_verify(algorithm, public, data, signature),
            Self::Ec { public, .. } => {
                let verifying = p256::ecdsa::VerifyingKey::from(*public);
                let signature = p256::ecdsa::Signature::from_slice(signature)
                    .map_err(|_| JwkError::InvalidSignature)?;
                verifying
                    .verify(data, &signature)
                    .map_err(|_| JwkError::InvalidSignature)
            }
            Self::Oct { secret, .. } => {
                let expected = super::hmac::sign(algorithm, secret, data)?;
                if expected.len() == signature.len()
                    && bool::from(subtle::ConstantTimeEq::ct_eq(
                        expected.as_slice(),
                        signature,
                    ))
                {
                    Ok(())
                } else {
                    Err(JwkError::InvalidSignature)
                }
            }
            Self::Okp { public, .. } => {
                let signature = ed25519_dalek::Signature::from_slice(signature)
                    .map_err(|_| JwkError::InvalidSignature)?;
                public
                    .verify(data, &signature)
                    .map_err(|_| JwkError::InvalidSignature)
            }
        }
    }

    /// A JWK with a private key removed (used by the Backend API).
    pub fn public_value(&self) -> Value {
        self.to_value(false)
    }

    pub(crate) fn key_use_is_sig(&self) -> bool {
        self.key_use().is_none_or(|value| value == "sig")
    }

    pub(crate) fn has_private(&self) -> bool {
        self.is_private()
    }
}

fn add_metadata(
    map: &mut Map<String, Value>,
    kid: &Option<String>,
    alg: Option<JwsAlgorithm>,
    use_: &Option<String>,
) {
    if let Some(kid) = kid {
        map.insert("kid".into(), Value::String(kid.clone()));
    }
    if let Some(alg) = alg {
        map.insert("alg".into(), Value::String(alg.as_str().to_string()));
    }
    if let Some(use_) = use_ {
        map.insert("use".into(), Value::String(use_.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_keys() {
        assert!(Jwk::from_value(&serde_json::json!({"keys":[]})).is_err());
        assert!(Jwk::from_value(&serde_json::json!({"kty":"RSA"})).is_err());
        assert!(
            Jwk::from_value(&serde_json::json!({"kty":"EC","crv":"P-384","x":"AA","y":"AA"}))
                .is_err()
        );
        assert!(Jwk::from_value(&serde_json::json!({"kty":"oct","k":""})).is_err());
    }
}
