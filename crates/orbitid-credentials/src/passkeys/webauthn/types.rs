//! WebAuthn wire types and option builders matching
//! `@simplewebauthn/server` v13.

use base64::Engine;
use serde::{Deserialize, Serialize};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// Errors a ceremony verification can produce.
#[derive(Debug, Clone, thiserror::Error)]
pub enum WebauthnError {
    #[error("invalid response: {0}")]
    Invalid(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

pub(crate) fn invalid(message: impl Into<String>) -> WebauthnError {
    WebauthnError::Invalid(message.into())
}

pub(crate) fn b64_decode(value: &str) -> Result<Vec<u8>, WebauthnError> {
    B64.decode(value.trim_end_matches('='))
        .map_err(|_| invalid("value is not base64url"))
}

pub(crate) fn b64_encode(value: &[u8]) -> String {
    B64.encode(value)
}

/// A fresh 32-byte base64url challenge, like `generateChallenge`.
pub fn new_challenge() -> String {
    let mut bytes = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut bytes);
    b64_encode(&bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpEntity {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserEntity {
    pub id: String,
    pub name: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PubKeyCredParam {
    pub alg: i64,
    #[serde(rename = "type")]
    pub key_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialDescriptor {
    pub id: String,
    #[serde(rename = "type")]
    pub key_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transports: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatorSelection {
    pub resident_key: String,
    pub require_resident_key: bool,
    pub user_verification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authenticator_attachment: Option<String>,
}

/// `PublicKeyCredentialCreationOptionsJSON`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationOptionsJson {
    pub challenge: String,
    pub rp: RpEntity,
    pub user: UserEntity,
    pub pub_key_cred_params: Vec<PubKeyCredParam>,
    pub timeout: i64,
    pub attestation: String,
    pub exclude_credentials: Vec<CredentialDescriptor>,
    pub authenticator_selection: AuthenticatorSelection,
    pub extensions: serde_json::Value,
    pub hints: Vec<String>,
}

/// `PublicKeyCredentialRequestOptionsJSON`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestOptionsJson {
    pub rp_id: String,
    pub challenge: String,
    pub allow_credentials: Vec<CredentialDescriptor>,
    pub timeout: i64,
    pub user_verification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<serde_json::Value>,
}

/// Registration options with the defaults `generateRegistrationOptions` uses.
pub fn creation_options(
    rp_name: &str,
    rp_id: &str,
    user_id: &str,
    user_name: &str,
    display_name: &str,
    authenticator_type: Option<&str>,
    exclude: Vec<CredentialDescriptor>,
) -> CreationOptionsJson {
    let attachment = match authenticator_type {
        Some("platform") => Some("platform".to_string()),
        Some("cross-platform") => Some("cross-platform".to_string()),
        _ => None,
    };
    CreationOptionsJson {
        challenge: new_challenge(),
        rp: RpEntity {
            name: rp_name.to_string(),
            id: rp_id.to_string(),
        },
        user: UserEntity {
            id: b64_encode(user_id.as_bytes()),
            name: user_name.to_string(),
            display_name: display_name.to_string(),
        },
        pub_key_cred_params: [-8, -7, -257]
            .into_iter()
            .map(|alg| PubKeyCredParam {
                alg,
                key_type: "public-key".into(),
            })
            .collect(),
        timeout: 5 * 60_000,
        attestation: "none".into(),
        exclude_credentials: exclude,
        authenticator_selection: AuthenticatorSelection {
            resident_key: "preferred".into(),
            require_resident_key: false,
            user_verification: "preferred".into(),
            authenticator_attachment: attachment,
        },
        extensions: serde_json::json!({ "credProps": true }),
        hints: Vec::new(),
    }
}

/// Authentication options with the defaults `generateAuthenticationOptions`
/// uses.
pub fn request_options(rp_id: &str, allow: Vec<CredentialDescriptor>) -> RequestOptionsJson {
    RequestOptionsJson {
        rp_id: rp_id.to_string(),
        challenge: new_challenge(),
        allow_credentials: allow,
        timeout: 5 * 60_000,
        user_verification: "preferred".into(),
        extensions: None,
    }
}

// ───────────── response JSON ─────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponseData {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub attestation_object: String,
    #[serde(default)]
    pub transports: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_algorithm: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationResponseJson {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    #[serde(default)]
    pub authenticator_attachment: Option<String>,
    #[serde(default)]
    pub client_extension_results: serde_json::Value,
    pub response: RegistrationResponseData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationResponseData {
    #[serde(rename = "clientDataJSON")]
    pub client_data_json: String,
    pub authenticator_data: String,
    pub signature: String,
    #[serde(default)]
    pub user_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticationResponseJson {
    pub id: String,
    pub raw_id: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    #[serde(default)]
    pub authenticator_attachment: Option<String>,
    #[serde(default)]
    pub client_extension_results: serde_json::Value,
    pub response: AuthenticationResponseData,
}

/// Verified registration data.
#[derive(Debug, Clone)]
pub struct RegistrationInfo {
    /// base64url raw credential id
    pub credential_id: String,
    /// COSE public key bytes from the authenticator data
    pub public_key: Vec<u8>,
    pub counter: i64,
    pub transports: Option<Vec<String>>,
    pub device_type: String,
    pub backed_up: bool,
}

/// Verified authentication data.
#[derive(Debug, Clone)]
pub struct AuthenticationInfo {
    pub new_counter: i64,
}
