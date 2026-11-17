//! RSA signature primitives shared by JWS and JWK export.

use ::rsa::signature::SignatureEncoding;
use ::rsa::traits::PrivateKeyParts;
use ::rsa::{RsaPrivateKey, RsaPublicKey};
use serde_json::{Map, Value};
use sha2::{Sha256, Sha384, Sha512};

use super::{JwkError, JwsAlgorithm};

pub(crate) fn b64_value(bytes: &[u8]) -> Value {
    Value::String(super::jwk::b64_encode(bytes))
}

pub(crate) fn add_rsa_private(map: &mut Map<String, Value>, private: &RsaPrivateKey) {
    let primes = private.primes();
    map.insert("d".into(), b64_value(&private.d().to_bytes_be()));
    if let [p, q] = primes {
        map.insert("p".into(), b64_value(&p.to_bytes_be()));
        map.insert("q".into(), b64_value(&q.to_bytes_be()));
        let p_minus_one = p - 1u32;
        let q_minus_one = q - 1u32;
        let dp = private.d() % &p_minus_one;
        let dq = private.d() % &q_minus_one;
        let qi = q.modpow(&(p - 2u32), p);
        map.insert("dp".into(), b64_value(&dp.to_bytes_be()));
        map.insert("dq".into(), b64_value(&dq.to_bytes_be()));
        map.insert("qi".into(), b64_value(&qi.to_bytes_be()));
    }
}

pub(crate) fn rsa_sign(
    algorithm: JwsAlgorithm,
    private: &RsaPrivateKey,
    data: &[u8],
) -> Result<Vec<u8>, JwkError> {
    use ::rsa::signature::Signer;
    match algorithm {
        JwsAlgorithm::RS256 => Ok(::rsa::pkcs1v15::SigningKey::<Sha256>::new(private.clone())
            .sign(data)
            .to_vec()),
        JwsAlgorithm::RS384 => Ok(::rsa::pkcs1v15::SigningKey::<Sha384>::new(private.clone())
            .sign(data)
            .to_vec()),
        JwsAlgorithm::RS512 => Ok(::rsa::pkcs1v15::SigningKey::<Sha512>::new(private.clone())
            .sign(data)
            .to_vec()),
        JwsAlgorithm::PS256 => {
            use ::rsa::signature::RandomizedSigner;
            let mut rng = rand_core::OsRng;
            Ok(::rsa::pss::SigningKey::<Sha256>::new(private.clone())
                .sign_with_rng(&mut rng, data)
                .to_vec())
        }
        JwsAlgorithm::PS384 => {
            use ::rsa::signature::RandomizedSigner;
            let mut rng = rand_core::OsRng;
            Ok(::rsa::pss::SigningKey::<Sha384>::new(private.clone())
                .sign_with_rng(&mut rng, data)
                .to_vec())
        }
        JwsAlgorithm::PS512 => {
            use ::rsa::signature::RandomizedSigner;
            let mut rng = rand_core::OsRng;
            Ok(::rsa::pss::SigningKey::<Sha512>::new(private.clone())
                .sign_with_rng(&mut rng, data)
                .to_vec())
        }
        _ => Err(JwkError::UnsupportedAlgorithm(algorithm.as_str().into())),
    }
}

pub(crate) fn rsa_verify(
    algorithm: JwsAlgorithm,
    public: &RsaPublicKey,
    data: &[u8],
    signature: &[u8],
) -> Result<(), JwkError> {
    use ::rsa::signature::Verifier;
    let invalid = |_| JwkError::InvalidSignature;
    match algorithm {
        JwsAlgorithm::RS256 => {
            let key = ::rsa::pkcs1v15::VerifyingKey::<Sha256>::new(public.clone());
            let sig = ::rsa::pkcs1v15::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        JwsAlgorithm::RS384 => {
            let key = ::rsa::pkcs1v15::VerifyingKey::<Sha384>::new(public.clone());
            let sig = ::rsa::pkcs1v15::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        JwsAlgorithm::RS512 => {
            let key = ::rsa::pkcs1v15::VerifyingKey::<Sha512>::new(public.clone());
            let sig = ::rsa::pkcs1v15::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        JwsAlgorithm::PS256 => {
            let key = ::rsa::pss::VerifyingKey::<Sha256>::new(public.clone());
            let sig = ::rsa::pss::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        JwsAlgorithm::PS384 => {
            let key = ::rsa::pss::VerifyingKey::<Sha384>::new(public.clone());
            let sig = ::rsa::pss::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        JwsAlgorithm::PS512 => {
            let key = ::rsa::pss::VerifyingKey::<Sha512>::new(public.clone());
            let sig = ::rsa::pss::Signature::try_from(signature).map_err(invalid)?;
            key.verify(data, &sig).map_err(invalid)
        }
        _ => Err(JwkError::UnsupportedAlgorithm(algorithm.as_str().into())),
    }
}
