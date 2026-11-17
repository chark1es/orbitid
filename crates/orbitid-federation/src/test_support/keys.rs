//! Throwaway keys and certificates for the federation tests and for upper
//! crates that exercise SAML/OIDC in their own integration tests.

use openssl::asn1::Asn1Time;
use openssl::bn::{BigNum, MsbOption};
use openssl::ec::{EcGroup, EcKey};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::{PKey, Private};
use openssl::rsa::Rsa;
use openssl::x509::extension::{BasicConstraints, KeyUsage};
use openssl::x509::{X509NameBuilder, X509};

/// An RSA key pair with a self-signed certificate, in the shapes a SAML or OIDC
/// fixture needs.
#[derive(Debug, Clone)]
pub struct TestKeyPair {
    pub private_key_pem: String,
    pub private_key_der: Vec<u8>,
    pub certificate_pem: String,
    pub certificate_der: Vec<u8>,
    pub key: PKey<Private>,
}

/// Generates a 2048-bit RSA key and a two-day self-signed certificate.
pub fn make_key_pair(label: &str) -> Result<TestKeyPair, String> {
    let rsa = Rsa::generate(2048).map_err(|error| error.to_string())?;
    let key = PKey::from_rsa(rsa).map_err(|error| error.to_string())?;
    with_certificate(label, key)
}

/// Generates a P-256 key (Apple ES256 client secrets and ID tokens).
pub fn make_ec_key_pair(label: &str) -> Result<TestKeyPair, String> {
    let group =
        EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).map_err(|error| error.to_string())?;
    let ec = EcKey::generate(&group).map_err(|error| error.to_string())?;
    let key = PKey::from_ec_key(ec).map_err(|error| error.to_string())?;
    with_certificate(label, key)
}

/// The public half of a key as PEM (for verifying ES256 signatures in tests).
pub fn public_key_pem(key: &PKey<Private>) -> Result<String, String> {
    let pem = key.public_key_to_pem().map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&pem).into_owned())
}

/// EC public coordinates as JWK-style base64url strings.
pub fn ec_jwk_parts(key: &PKey<Private>) -> Result<(String, String), String> {
    let ec = key.ec_key().map_err(|error| error.to_string())?;
    let mut ctx = openssl::bn::BigNumContext::new().map_err(|error| error.to_string())?;
    let mut x = openssl::bn::BigNum::new().map_err(|error| error.to_string())?;
    let mut y = openssl::bn::BigNum::new().map_err(|error| error.to_string())?;
    ec.public_key()
        .affine_coordinates_gfp(ec.group(), &mut x, &mut y, &mut ctx)
        .map_err(|error| error.to_string())?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok((
        base64::Engine::encode(&engine, x.to_vec_padded(32).map_err(|e| e.to_string())?),
        base64::Engine::encode(&engine, y.to_vec_padded(32).map_err(|e| e.to_string())?),
    ))
}

fn with_certificate(label: &str, key: PKey<Private>) -> Result<TestKeyPair, String> {
    let private_key_pem = key
        .private_key_to_pem_pkcs8()
        .map_err(|error| error.to_string())?;
    let private_key_der = key
        .private_key_to_der()
        .map_err(|error| error.to_string())?;

    let mut name = X509NameBuilder::new().map_err(|error| error.to_string())?;
    name.append_entry_by_text("CN", label)
        .map_err(|error| error.to_string())?;
    let name = name.build();

    let mut builder = X509::builder().map_err(|error| error.to_string())?;
    builder.set_version(2).map_err(|error| error.to_string())?;
    let mut serial = BigNum::new().map_err(|error| error.to_string())?;
    serial
        .rand(128, MsbOption::MAYBE_ZERO, false)
        .map_err(|error| error.to_string())?;
    let serial = serial
        .to_asn1_integer()
        .map_err(|error| error.to_string())?;
    builder
        .set_serial_number(&serial)
        .map_err(|error| error.to_string())?;
    builder
        .set_subject_name(&name)
        .map_err(|error| error.to_string())?;
    builder
        .set_issuer_name(&name)
        .map_err(|error| error.to_string())?;
    let not_before = Asn1Time::days_from_now(0).map_err(|error| error.to_string())?;
    let not_after = Asn1Time::days_from_now(2).map_err(|error| error.to_string())?;
    builder
        .set_not_before(&not_before)
        .map_err(|error| error.to_string())?;
    builder
        .set_not_after(&not_after)
        .map_err(|error| error.to_string())?;
    builder
        .set_pubkey(&key)
        .map_err(|error| error.to_string())?;
    builder
        .append_extension(
            BasicConstraints::new()
                .critical()
                .build()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    builder
        .append_extension(
            KeyUsage::new()
                .digital_signature()
                .build()
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    builder
        .sign(&key, MessageDigest::sha256())
        .map_err(|error| error.to_string())?;
    let certificate = builder.build();
    Ok(TestKeyPair {
        private_key_pem: String::from_utf8_lossy(&private_key_pem).into_owned(),
        private_key_der,
        certificate_pem: String::from_utf8_lossy(&certificate.to_pem().map_err(|e| e.to_string())?)
            .into_owned(),
        certificate_der: certificate.to_der().map_err(|error| error.to_string())?,
        key,
    })
}

/// RSA public components as JWK-style base64url strings.
pub fn rsa_jwk_parts(key: &PKey<Private>) -> Result<(String, String), String> {
    let rsa = key.rsa().map_err(|error| error.to_string())?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    Ok((
        base64::Engine::encode(&engine, rsa.n().to_vec()),
        base64::Engine::encode(&engine, rsa.e().to_vec()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_usable_certificate() {
        let pair = make_key_pair("fixture").expect("key pair");
        assert!(pair.certificate_pem.contains("BEGIN CERTIFICATE"));
        assert!(X509::from_pem(pair.certificate_pem.as_bytes()).is_ok());
        let (n, e) = rsa_jwk_parts(&pair.key).expect("jwk parts");
        assert!(!n.is_empty());
        assert_eq!(e, "AQAB");
    }
}
