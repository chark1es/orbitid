//! Registration/authentication response verification rules.

use std::io::Cursor;

use ciborium::value::Value as Cbor;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::cose::CoseKey;
use super::types::*;

#[derive(Debug, Clone, Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    data_type: String,
    challenge: String,
    origin: String,
    #[serde(default, rename = "crossOrigin")]
    _cross_origin: Option<bool>,
    #[serde(default, rename = "tokenBinding")]
    _token_binding: Option<serde_json::Value>,
}

fn parse_client_data(encoded: &str, expected_type: &str) -> Result<ClientData, WebauthnError> {
    let bytes = b64_decode(encoded)?;
    let data: ClientData =
        serde_json::from_slice(&bytes).map_err(|_| invalid("clientDataJSON is not valid JSON"))?;
    if data.data_type != expected_type {
        return Err(invalid("unexpected clientDataJSON type"));
    }
    Ok(data)
}

pub(crate) struct ParsedAuthData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub counter: u32,
    pub credential_id: Option<Vec<u8>>,
    pub public_key: Option<Vec<u8>>,
    pub aaguid: Option<[u8; 16]>,
}

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;

pub(crate) fn read_cbor(bytes: &[u8]) -> Result<(Cbor, usize), WebauthnError> {
    let mut cursor = Cursor::new(bytes);
    let value: Cbor =
        ciborium::de::from_reader(&mut cursor).map_err(|_| invalid("invalid CBOR"))?;
    Ok((value, cursor.position() as usize))
}

pub(crate) fn map_get<'a>(map: &'a [(Cbor, Cbor)], key: &str) -> Option<&'a Cbor> {
    map.iter()
        .find(|(name, _)| name.as_text() == Some(key))
        .map(|(_, value)| value)
}

pub(crate) fn int_of(value: &Cbor) -> Option<i64> {
    match value {
        Cbor::Integer(integer) => i64::try_from(i128::from(*integer)).ok(),
        _ => None,
    }
}

pub(crate) fn cbor_map(value: &Cbor) -> Result<&[(Cbor, Cbor)], WebauthnError> {
    match value {
        Cbor::Map(map) => Ok(map),
        _ => Err(invalid("expected a CBOR map")),
    }
}

pub(crate) fn bytes_of(value: &Cbor) -> Result<Vec<u8>, WebauthnError> {
    match value {
        Cbor::Bytes(bytes) => Ok(bytes.clone()),
        Cbor::Text(text) => Ok(text.as_bytes().to_vec()),
        _ => Err(invalid("expected CBOR bytes")),
    }
}

pub(crate) fn parse_auth_data(bytes: &[u8]) -> Result<ParsedAuthData, WebauthnError> {
    if bytes.len() < 37 {
        return Err(invalid("authenticator data is truncated"));
    }
    let mut rp_id_hash = [0u8; 32];
    rp_id_hash.copy_from_slice(&bytes[..32]);
    let flags = bytes[32];
    let counter = u32::from_be_bytes([bytes[33], bytes[34], bytes[35], bytes[36]]);
    let mut parsed = ParsedAuthData {
        rp_id_hash,
        flags,
        counter,
        credential_id: None,
        public_key: None,
        aaguid: None,
    };
    if flags & FLAG_AT != 0 {
        if bytes.len() < 55 {
            return Err(invalid("attested credential data is truncated"));
        }
        let mut aaguid = [0u8; 16];
        aaguid.copy_from_slice(&bytes[37..53]);
        let id_len = u16::from_be_bytes([bytes[53], bytes[54]]) as usize;
        let id_start = 55;
        let id_end = id_start + id_len;
        if bytes.len() < id_end {
            return Err(invalid("credential id is truncated"));
        }
        let credential_id = bytes[id_start..id_end].to_vec();
        let (key, _) = read_cbor(&bytes[id_end..])?;
        let _ = cbor_map(&key)?;
        let key_end = read_cbor(&bytes[id_end..])?.1 + id_end;
        parsed.aaguid = Some(aaguid);
        parsed.credential_id = Some(credential_id);
        parsed.public_key = Some(bytes[id_end..key_end].to_vec());
    }
    Ok(parsed)
}

fn check_rp_id(hash: &[u8; 32], rp_id: &str) -> Result<(), WebauthnError> {
    if hash.as_slice() != Sha256::digest(rp_id.as_bytes()).as_slice() {
        return Err(invalid("rpIdHash does not match the relying party"));
    }
    Ok(())
}

fn backup_flags(flags: u8) -> Result<(String, bool), WebauthnError> {
    let backed_up = flags & FLAG_BS != 0;
    let multi_device = flags & FLAG_BE != 0;
    if !multi_device && backed_up {
        return Err(invalid("single-device credential reported a backup"));
    }
    Ok((
        if multi_device {
            "multiDevice".into()
        } else {
            "singleDevice".into()
        },
        backed_up,
    ))
}

/// Verifies a registration response.
pub fn verify_registration(
    response: &RegistrationResponseJson,
    expected_challenge: &str,
    expected_origin: &str,
    expected_rp_id: &str,
    require_user_verification: bool,
) -> Result<RegistrationInfo, WebauthnError> {
    if response.id.is_empty() || response.id != response.raw_id {
        return Err(invalid("credential id was not base64url-encoded"));
    }
    if response.credential_type != "public-key" {
        return Err(invalid("unexpected credential type"));
    }
    let client_data = parse_client_data(&response.response.client_data_json, "webauthn.create")?;
    if client_data.challenge != expected_challenge {
        return Err(invalid("unexpected registration challenge"));
    }
    if client_data.origin != expected_origin {
        return Err(invalid("unexpected registration origin"));
    }
    let attestation_bytes = b64_decode(&response.response.attestation_object)?;
    let (attestation, _) = read_cbor(&attestation_bytes)?;
    let attestation = cbor_map(&attestation)?;
    let fmt = map_get(attestation, "fmt")
        .and_then(Cbor::as_text)
        .ok_or_else(|| invalid("attestation object has no fmt"))?;
    let auth_data = map_get(attestation, "authData")
        .ok_or_else(|| invalid("attestation object has no authData"))
        .and_then(bytes_of)?;
    let att_stmt = map_get(attestation, "attStmt")
        .ok_or_else(|| invalid("attestation object has no attStmt"))
        .and_then(cbor_map)?;
    if fmt != "none" {
        return Err(WebauthnError::Unsupported(format!(
            "attestation format {fmt}"
        )));
    }
    if !att_stmt.is_empty() {
        return Err(invalid("none attestation had an attestation statement"));
    }
    let parsed = parse_auth_data(&auth_data)?;
    check_rp_id(&parsed.rp_id_hash, expected_rp_id)?;
    if parsed.flags & FLAG_UP == 0 {
        return Err(invalid("user was not present"));
    }
    if require_user_verification && parsed.flags & FLAG_UV == 0 {
        return Err(invalid("user verification was required"));
    }
    let credential_id = parsed
        .credential_id
        .ok_or_else(|| invalid("no credential id"))?;
    let public_key = parsed.public_key.ok_or_else(|| invalid("no public key"))?;
    let cose = CoseKey::parse(&public_key)?;
    if !cose.is_supported() {
        return Err(WebauthnError::Unsupported(
            "credential public key algorithm".into(),
        ));
    }
    let (device_type, backed_up) = backup_flags(parsed.flags)?;
    Ok(RegistrationInfo {
        credential_id: b64_encode(&credential_id),
        public_key,
        counter: parsed.counter as i64,
        transports: response.response.transports.clone(),
        device_type,
        backed_up,
    })
}

/// Verifies an authentication response against the stored COSE public key.
pub fn verify_authentication(
    response: &AuthenticationResponseJson,
    expected_challenge: &str,
    expected_origin: &str,
    expected_rp_id: &str,
    stored_public_key: &[u8],
    stored_counter: i64,
    require_user_verification: bool,
) -> Result<AuthenticationInfo, WebauthnError> {
    if response.id.is_empty() || response.id != response.raw_id {
        return Err(invalid("credential id was not base64url-encoded"));
    }
    if response.credential_type != "public-key" {
        return Err(invalid("unexpected credential type"));
    }
    let client_data = parse_client_data(&response.response.client_data_json, "webauthn.get")?;
    if client_data.challenge != expected_challenge {
        return Err(invalid("unexpected authentication challenge"));
    }
    if client_data.origin != expected_origin {
        return Err(invalid("unexpected authentication origin"));
    }
    let auth_data = b64_decode(&response.response.authenticator_data)?;
    let signature = b64_decode(&response.response.signature)?;
    let parsed = parse_auth_data(&auth_data)?;
    check_rp_id(&parsed.rp_id_hash, expected_rp_id)?;
    if parsed.flags & FLAG_UP == 0 {
        return Err(invalid("user was not present"));
    }
    if require_user_verification && parsed.flags & FLAG_UV == 0 {
        return Err(invalid("user verification was required"));
    }
    let client_data_hash = Sha256::digest(b64_decode(&response.response.client_data_json)?);
    let mut signed = auth_data.clone();
    signed.extend_from_slice(&client_data_hash);
    let cose = CoseKey::parse(stored_public_key)?;
    cose.verify(&signed, &signature)?;
    let new_counter = parsed.counter as i64;
    if (new_counter > 0 || stored_counter > 0) && new_counter <= stored_counter {
        return Err(invalid("signature counter went backwards"));
    }
    Ok(AuthenticationInfo { new_counter })
}
