//! A software WebAuthn authenticator for tests, ported from
//! the retired TypeScript test suite.
//!
//! It builds the exact JSON a browser hands to the server: base64url fields,
//! client data, authenticator data, a CBOR `fmt: "none"` attestation object and
//! spec-shaped assertion signatures. Exported behind the `test-util` feature so
//! upper crates can drive passkey flows from their own integration tests.

use ciborium::value::{Integer, Value as Cbor};
use sha2::{Digest, Sha256};

use super::webauthn::{
    b64_decode, b64_encode, encode_cose_map, AuthenticationResponseData,
    AuthenticationResponseJson, CreationOptionsJson, RegistrationResponseData,
    RegistrationResponseJson, RequestOptionsJson,
};

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;

/// COSE algorithm the virtual authenticator will create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VirtualAlgorithm {
    /// `-7`, a platform passkey.
    Es256,
    /// `-257`, a security key.
    Rs256,
}

enum KeyMaterial {
    Es256(p256::ecdsa::SigningKey),
    Rs256(Box<rsa::RsaPrivateKey>),
}

/// Configuration for [`VirtualAuthenticator`].
#[derive(Debug, Clone)]
pub struct VirtualAuthenticatorOptions {
    pub alg: VirtualAlgorithm,
    /// Relying party id (hostname, never including the port).
    pub rp_id: String,
    /// Full origin, e.g. `https://app.example.com`.
    pub origin: String,
    /// When false, assertions/attestations report UV=0.
    pub user_verification: bool,
    pub backup_eligible: bool,
    pub backup_state: bool,
    /// Signature counter start value; `0` models an authenticator that counts
    /// only after the first use.
    pub counter: i64,
    pub transports: Vec<String>,
    pub attachment: String,
    pub aaguid: [u8; 16],
}

impl VirtualAuthenticatorOptions {
    pub fn new(rp_id: impl Into<String>, origin: impl Into<String>) -> Self {
        Self {
            alg: VirtualAlgorithm::Es256,
            rp_id: rp_id.into(),
            origin: origin.into(),
            user_verification: true,
            backup_eligible: true,
            backup_state: true,
            counter: 0,
            transports: vec!["internal".into(), "hybrid".into()],
            attachment: "platform".into(),
            aaguid: random_bytes::<16>(),
        }
    }
}

/// Per-ceremony overrides used to model negative cases.
#[derive(Debug, Clone, Default)]
pub struct CredentialOverrides {
    pub challenge: Option<String>,
    pub origin: Option<String>,
    pub rp_id: Option<String>,
    pub credential_id: Option<String>,
    pub user_handle: Option<String>,
    pub user_verified: Option<bool>,
    pub user_present: Option<bool>,
    pub counter: Option<i64>,
    pub backup_state: Option<bool>,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut bytes);
    bytes
}

fn key_material(algorithm: VirtualAlgorithm) -> Result<KeyMaterial, String> {
    match algorithm {
        VirtualAlgorithm::Es256 => Ok(KeyMaterial::Es256(p256::ecdsa::SigningKey::random(
            &mut rand_core::OsRng,
        ))),
        VirtualAlgorithm::Rs256 => rsa::RsaPrivateKey::new(&mut rand_core::OsRng, 2048)
            .map(|key| KeyMaterial::Rs256(Box::new(key)))
            .map_err(|error| format!("could not generate an RSA test key: {error}")),
    }
}

fn cose_key(key: &KeyMaterial) -> Vec<u8> {
    match key {
        KeyMaterial::Es256(signing) => {
            let point = signing.verifying_key().to_encoded_point(false);
            encode_cose_map(vec![
                (1, Cbor::Integer(Integer::from(2i64))),
                (3, Cbor::Integer(Integer::from(-7i64))),
                (-1, Cbor::Integer(Integer::from(1i64))),
                (
                    -2,
                    Cbor::Bytes(point.x().map(|value| value.to_vec()).unwrap_or_default()),
                ),
                (
                    -3,
                    Cbor::Bytes(point.y().map(|value| value.to_vec()).unwrap_or_default()),
                ),
            ])
        }
        KeyMaterial::Rs256(private) => {
            use rsa::traits::PublicKeyParts;
            let public = rsa::RsaPublicKey::from(&**private);
            encode_cose_map(vec![
                (1, Cbor::Integer(Integer::from(3i64))),
                (3, Cbor::Integer(Integer::from(-257i64))),
                (-1, Cbor::Bytes(public.n().to_bytes_be())),
                (-2, Cbor::Bytes(public.e().to_bytes_be())),
            ])
        }
    }
}

fn sign(key: &KeyMaterial, data: &[u8]) -> Vec<u8> {
    match key {
        KeyMaterial::Es256(signing) => {
            use p256::ecdsa::signature::Signer;
            let signature: p256::ecdsa::Signature = signing.sign(data);
            signature.to_der().as_bytes().to_vec()
        }
        KeyMaterial::Rs256(private) => {
            use rsa::signature::{SignatureEncoding, Signer};
            rsa::pkcs1v15::SigningKey::<Sha256>::new((**private).clone())
                .sign(data)
                .to_vec()
        }
    }
}

/// A browser-like authenticator that keeps one credential.
pub struct VirtualAuthenticator {
    pub alg: VirtualAlgorithm,
    pub rp_id: String,
    pub origin: String,
    pub transports: Vec<String>,
    pub attachment: String,
    pub credential_id: String,
    pub user_handle: String,
    pub counter: i64,
    user_verification: bool,
    backup_eligible: bool,
    backup_state: bool,
    aaguid: [u8; 16],
    key: KeyMaterial,
}

impl VirtualAuthenticator {
    pub fn new(options: VirtualAuthenticatorOptions) -> Result<Self, String> {
        let key = key_material(options.alg)?;
        Ok(Self {
            alg: options.alg,
            rp_id: options.rp_id,
            origin: options.origin,
            transports: options.transports,
            attachment: options.attachment,
            credential_id: String::new(),
            user_handle: String::new(),
            counter: options.counter,
            user_verification: options.user_verification,
            backup_eligible: options.backup_eligible,
            backup_state: options.backup_state,
            aaguid: options.aaguid,
            key,
        })
    }

    fn client_data(&self, data_type: &str, challenge: &str, origin: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "type": data_type,
            "challenge": challenge,
            "origin": origin,
            "crossOrigin": false,
        }))
        .unwrap_or_default()
    }

    fn flags(&self, overrides: &CredentialOverrides) -> u8 {
        let uv = overrides.user_verified.unwrap_or(self.user_verification);
        let backup_state = overrides.backup_state.unwrap_or(self.backup_state);
        let mut flags = if overrides.user_present.unwrap_or(true) {
            FLAG_UP
        } else {
            0
        };
        if uv {
            flags |= FLAG_UV;
        }
        if self.backup_eligible {
            flags |= FLAG_BE;
            if backup_state {
                flags |= FLAG_BS;
            }
        }
        flags
    }

    fn auth_data(
        &self,
        rp_id: &str,
        flags: u8,
        counter: u32,
        attested: Option<(&[u8], &[u8])>,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
        out.push(flags);
        out.extend_from_slice(&counter.to_be_bytes());
        if let Some((credential_id, cose)) = attested {
            out.extend_from_slice(&self.aaguid);
            out.extend_from_slice(&(credential_id.len() as u16).to_be_bytes());
            out.extend_from_slice(credential_id);
            out.extend_from_slice(cose);
        }
        out
    }

    /// `navigator.credentials.create()`.
    pub fn register(
        &mut self,
        options: &CreationOptionsJson,
        overrides: CredentialOverrides,
    ) -> RegistrationResponseJson {
        let rp_id = overrides.rp_id.as_deref().unwrap_or(&options.rp.id);
        let origin = overrides.origin.as_deref().unwrap_or(&self.origin);
        let challenge = overrides.challenge.as_deref().unwrap_or(&options.challenge);
        let credential_id = overrides
            .credential_id
            .as_deref()
            .and_then(|id| b64_decode(id).ok())
            .unwrap_or_else(|| random_bytes::<32>().to_vec());
        let client_data = self.client_data("webauthn.create", challenge, origin);
        let cose = cose_key(&self.key);
        let auth_data = self.auth_data(
            rp_id,
            self.flags(&overrides) | FLAG_AT,
            0,
            Some((&credential_id, &cose)),
        );
        let attestation = Cbor::Map(vec![
            (Cbor::Text("fmt".into()), Cbor::Text("none".into())),
            (Cbor::Text("attStmt".into()), Cbor::Map(Vec::new())),
            (Cbor::Text("authData".into()), Cbor::Bytes(auth_data)),
        ]);
        let mut encoded = Vec::new();
        let _ = ciborium::ser::into_writer(&attestation, &mut encoded);
        self.credential_id = b64_encode(&credential_id);
        self.user_handle = overrides
            .user_handle
            .clone()
            .unwrap_or_else(|| options.user.id.clone());
        self.counter = 0;
        RegistrationResponseJson {
            id: self.credential_id.clone(),
            raw_id: self.credential_id.clone(),
            credential_type: "public-key".into(),
            authenticator_attachment: Some(self.attachment.clone()),
            client_extension_results: serde_json::json!({}),
            response: RegistrationResponseData {
                client_data_json: b64_encode(&client_data),
                attestation_object: b64_encode(&encoded),
                transports: Some(self.transports.clone()),
                public_key_algorithm: Some(match self.alg {
                    VirtualAlgorithm::Es256 => -7,
                    VirtualAlgorithm::Rs256 => -257,
                }),
            },
        }
    }

    /// `navigator.credentials.get()`.
    pub fn authenticate(
        &mut self,
        options: &RequestOptionsJson,
        overrides: CredentialOverrides,
    ) -> AuthenticationResponseJson {
        let challenge = overrides.challenge.as_deref().unwrap_or(&options.challenge);
        let origin = overrides.origin.as_deref().unwrap_or(&self.origin);
        let rp_id = overrides.rp_id.as_deref().unwrap_or(&options.rp_id);
        let counter = overrides.counter.unwrap_or(self.counter + 1);
        let client_data = self.client_data("webauthn.get", challenge, origin);
        let auth_data = self.auth_data(rp_id, self.flags(&overrides), counter as u32, None);
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&Sha256::digest(&client_data));
        let signature = sign(&self.key, &signed);
        self.counter = counter;
        let id = overrides
            .credential_id
            .clone()
            .unwrap_or_else(|| self.credential_id.clone());
        let user_handle = overrides
            .user_handle
            .clone()
            .unwrap_or_else(|| self.user_handle.clone());
        AuthenticationResponseJson {
            id: id.clone(),
            raw_id: id,
            credential_type: "public-key".into(),
            authenticator_attachment: Some(self.attachment.clone()),
            client_extension_results: serde_json::json!({}),
            response: AuthenticationResponseData {
                client_data_json: b64_encode(&client_data),
                authenticator_data: b64_encode(&auth_data),
                signature: b64_encode(&signature),
                user_handle: (!user_handle.is_empty()).then_some(user_handle),
            },
        }
    }
}

#[cfg(test)]
#[path = "authenticator_tests.rs"]
mod tests;
