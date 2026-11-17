//! COSE public keys used by WebAuthn credentials.

use super::types::{invalid, WebauthnError};
use super::verify::{bytes_of, cbor_map, int_of, read_cbor};

pub(crate) struct CoseKey {
    alg: i64,
    kty: i64,
    curve: Option<i64>,
    /// EC x/y or RSA n/e.
    x: Option<Vec<u8>>,
    y: Option<Vec<u8>>,
    n: Option<Vec<u8>>,
    e: Option<Vec<u8>>,
}

impl CoseKey {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, WebauthnError> {
        let (value, _) = read_cbor(bytes)?;
        let map = cbor_map(&value)?;
        let get = |key: i64| {
            map.iter()
                .find(|(k, _)| int_of(k) == Some(key))
                .map(|(_, v)| v)
        };
        let alg = get(3)
            .and_then(int_of)
            .ok_or_else(|| invalid("missing COSE alg"))?;
        let kty = get(1)
            .and_then(int_of)
            .ok_or_else(|| invalid("missing COSE kty"))?;
        let mut key = Self {
            alg,
            kty,
            curve: None,
            x: None,
            y: None,
            n: None,
            e: None,
        };
        match kty {
            2 => {
                key.curve = get(-1).and_then(int_of);
                key.x = get(-2).map(bytes_of).transpose()?;
                key.y = get(-3).map(bytes_of).transpose()?;
            }
            1 => {
                key.curve = get(-1).and_then(int_of);
                key.x = get(-2).map(bytes_of).transpose()?;
            }
            3 => {
                key.n = get(-1).map(bytes_of).transpose()?;
                key.e = get(-2).map(bytes_of).transpose()?;
            }
            _ => return Err(invalid("unsupported COSE kty")),
        }
        Ok(key)
    }

    pub(crate) fn is_supported(&self) -> bool {
        matches!(self.alg, -7 | -257 | -258 | -259 | -37 | -38 | -39 | -8)
    }

    pub(crate) fn verify(&self, data: &[u8], signature: &[u8]) -> Result<(), WebauthnError> {
        match self.alg {
            -7 => {
                if self.kty != 2 || self.curve != Some(1) {
                    return Err(invalid("ES256 key is not P-256"));
                }
                let (Some(x), Some(y)) = (&self.x, &self.y) else {
                    return Err(invalid("ES256 key is incomplete"));
                };
                let mut point = vec![4u8];
                point.extend_from_slice(x);
                point.extend_from_slice(y);
                let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(&point)
                    .map_err(|_| invalid("bad ES256 key"))?;
                let signature = p256::ecdsa::Signature::from_der(signature)
                    .map_err(|_| invalid("bad ES256 signature"))?;
                use p256::ecdsa::signature::Verifier;
                key.verify(data, &signature)
                    .map_err(|_| invalid("bad ES256 signature"))
            }
            -257 | -258 | -259 | -37 | -38 | -39 => self.verify_rsa(data, signature),
            -8 => {
                let (Some(x), _) = (&self.x, &self.y) else {
                    return Err(invalid("EdDSA key is incomplete"));
                };
                let key: [u8; 32] = x
                    .as_slice()
                    .try_into()
                    .map_err(|_| invalid("bad EdDSA key"))?;
                let key = ed25519_dalek::VerifyingKey::from_bytes(&key)
                    .map_err(|_| invalid("bad EdDSA key"))?;
                let signature = ed25519_dalek::Signature::from_slice(signature)
                    .map_err(|_| invalid("bad EdDSA signature"))?;
                use ed25519_dalek::Verifier;
                key.verify(data, &signature)
                    .map_err(|_| invalid("bad EdDSA signature"))
            }
            _ => Err(WebauthnError::Unsupported("signature algorithm".into())),
        }
    }

    fn verify_rsa(&self, data: &[u8], signature: &[u8]) -> Result<(), WebauthnError> {
        use rsa::signature::Verifier;
        let (Some(n), Some(e)) = (&self.n, &self.e) else {
            return Err(invalid("RSA key is incomplete"));
        };
        let key = rsa::RsaPublicKey::new(
            rsa::BigUint::from_bytes_be(n),
            rsa::BigUint::from_bytes_be(e),
        )
        .map_err(|_| invalid("bad RSA key"))?;
        let bad = |_| invalid("bad RSA signature");
        match self.alg {
            -257 => rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(key)
                .verify(
                    data,
                    &rsa::pkcs1v15::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            -258 => rsa::pkcs1v15::VerifyingKey::<sha2::Sha384>::new(key)
                .verify(
                    data,
                    &rsa::pkcs1v15::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            -259 => rsa::pkcs1v15::VerifyingKey::<sha2::Sha512>::new(key)
                .verify(
                    data,
                    &rsa::pkcs1v15::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            -37 => rsa::pss::VerifyingKey::<sha2::Sha256>::new(key)
                .verify(
                    data,
                    &rsa::pss::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            -38 => rsa::pss::VerifyingKey::<sha2::Sha384>::new(key)
                .verify(
                    data,
                    &rsa::pss::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            -39 => rsa::pss::VerifyingKey::<sha2::Sha512>::new(key)
                .verify(
                    data,
                    &rsa::pss::Signature::try_from(signature).map_err(bad)?,
                )
                .map_err(bad),
            _ => Err(WebauthnError::Unsupported("RSA algorithm".into())),
        }
    }
}

/// Encodes a COSE key for the virtual authenticator tests.
#[cfg(any(feature = "test-util", test))]
pub(crate) fn encode_cose_map(entries: Vec<(i64, ciborium::value::Value)>) -> Vec<u8> {
    let map = ciborium::value::Value::Map(
        entries
            .into_iter()
            .map(|(key, value)| {
                (
                    ciborium::value::Value::Integer(ciborium::value::Integer::from(key)),
                    value,
                )
            })
            .collect(),
    );
    let mut out = Vec::new();
    let _ = ciborium::ser::into_writer(&map, &mut out);
    out
}
