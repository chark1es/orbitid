//! JWK parsing for the key types this server supports.

use rsa::{BigUint, RsaPrivateKey, RsaPublicKey};
use serde_json::{Map, Value};

use super::jwk::{b64_decode, required};
use super::{Jwk, JwkError, JwsAlgorithm};

impl Jwk {
    pub(crate) fn parse_rsa(
        map: &Map<String, Value>,
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
    ) -> Result<Self, JwkError> {
        let n = BigUint::from_bytes_be(&b64_decode(required(map, "n")?)?);
        let e = BigUint::from_bytes_be(&b64_decode(required(map, "e")?)?);
        let public = RsaPublicKey::new(n.clone(), e.clone())
            .map_err(|_| JwkError::InvalidJwk("bad RSA key".into()))?;
        let private = match map.get("d").and_then(Value::as_str) {
            Some(d) => {
                let d = BigUint::from_bytes_be(&b64_decode(d)?);
                let p = BigUint::from_bytes_be(&b64_decode(required(map, "p")?)?);
                let q = BigUint::from_bytes_be(&b64_decode(required(map, "q")?)?);
                let mut key = RsaPrivateKey::from_components(n, e, d, vec![p, q])
                    .map_err(|_| JwkError::InvalidJwk("bad RSA private key".into()))?;
                key.precompute()
                    .map_err(|_| JwkError::InvalidJwk("bad RSA private key".into()))?;
                Some(key)
            }
            None => None,
        };
        Ok(Self::Rsa {
            kid,
            alg,
            use_,
            public,
            private,
        })
    }

    pub(crate) fn parse_ec(
        map: &Map<String, Value>,
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
    ) -> Result<Self, JwkError> {
        if map.get("crv").and_then(Value::as_str) != Some("P-256") {
            return Err(JwkError::InvalidJwk(
                "only P-256 EC keys are supported".into(),
            ));
        }
        let x = b64_decode(required(map, "x")?)?;
        let y = b64_decode(required(map, "y")?)?;
        if x.len() != 32 || y.len() != 32 {
            return Err(JwkError::InvalidJwk("bad P-256 coordinates".into()));
        }
        let mut point = vec![4u8];
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        let public = p256::PublicKey::from_sec1_bytes(&point)
            .map_err(|_| JwkError::InvalidJwk("bad P-256 point".into()))?;
        let private = match map.get("d").and_then(Value::as_str) {
            Some(d) => Some(
                p256::SecretKey::from_slice(&b64_decode(d)?)
                    .map_err(|_| JwkError::InvalidJwk("bad P-256 private key".into()))?,
            ),
            None => None,
        };
        Ok(Self::Ec {
            kid,
            alg,
            use_,
            public,
            private,
        })
    }

    pub(crate) fn parse_okp(
        map: &Map<String, Value>,
        kid: Option<String>,
        alg: Option<JwsAlgorithm>,
        use_: Option<String>,
    ) -> Result<Self, JwkError> {
        if map.get("crv").and_then(Value::as_str) != Some("Ed25519") {
            return Err(JwkError::InvalidJwk(
                "only Ed25519 OKP keys are supported".into(),
            ));
        }
        let x: [u8; 32] = b64_decode(required(map, "x")?)?
            .try_into()
            .map_err(|_| JwkError::InvalidJwk("bad Ed25519 public key".into()))?;
        let public = ed25519_dalek::VerifyingKey::from_bytes(&x)
            .map_err(|_| JwkError::InvalidJwk("bad Ed25519 public key".into()))?;
        let private = match map.get("d").and_then(Value::as_str) {
            Some(d) => {
                let bytes: [u8; 32] = b64_decode(d)?
                    .try_into()
                    .map_err(|_| JwkError::InvalidJwk("bad Ed25519 private key".into()))?;
                Some(ed25519_dalek::SigningKey::from_bytes(&bytes))
            }
            None => None,
        };
        Ok(Self::Okp {
            kid,
            alg,
            use_,
            public,
            private,
        })
    }
}
