//! Persisted sign-in / sign-up state, ported from the `state` / `fields` /
//! `verifications` JSON columns of `modules/auth/{signin-core,signup-core}.ts`.
//!
//! The TypeScript server stores camelCase JSON; the wire resources are built
//! from these structs by [`crate::signin::core`] and [`crate::signup::core`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FactorError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FactorState {
    pub strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FactorError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_verification_redirect_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trusted_device_id: Option<String>,
}

impl FactorState {
    pub fn new(strategy: impl Into<String>) -> Self {
        Self {
            strategy: strategy.into(),
            ..Default::default()
        }
    }

    pub fn status(mut self, status: impl Into<String>) -> Self {
        self.status = Some(status.into());
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResetPasswordState {
    pub verified: bool,
    pub strategy: String,
}

/// The OAuth profile stashed on a sign-in so the SDK can transfer it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StashedProfile {
    pub provider: String,
    pub provider_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token_enc: Option<String>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignInState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<FactorState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub second: Option<FactorState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_password: Option<ResetPasswordState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_profile: Option<StashedProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enterprise_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_complete_redirect_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azp: Option<String>,
    /// Set when the identifier matched no account and enumeration protection answered with a stand-in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoy: Option<DecoyState>,
}

/// The made-up channel ids a decoy sign-in shows, kept so every read of it returns the same ones.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DecoyState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_id: Option<String>,
}

impl std::fmt::Debug for SignInState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInState")
            .field("first", &self.first)
            .field("second", &self.second)
            .field("reset_password", &"<redacted>")
            .field("requested_reset", &self.requested_reset)
            .field("transfer_profile", &self.transfer_profile)
            .field("enterprise_connection_id", &self.enterprise_connection_id)
            .field("redirect_url", &self.redirect_url)
            .field(
                "action_complete_redirect_url",
                &self.action_complete_redirect_url,
            )
            .field("azp", &self.azp)
            .field("decoy", &self.decoy.is_some())
            .finish()
    }
}

impl SignInState {
    pub fn from_json(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }
}

/// The stashed external account attached to a sign-up.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StashedExternalAccount {
    pub provider: String,
    pub provider_user_id: String,
    pub email_address: String,
    pub first_name: String,
    pub last_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub approved_scopes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token_enc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<i64>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignUpFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legal_accepted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_account: Option<StashedExternalAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anonymous: Option<bool>,
}

impl std::fmt::Debug for SignUpFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignUpFields")
            .field("email_address", &self.email_address)
            .field("phone_number", &self.phone_number)
            .field("username", &self.username)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("password_hash", &self.password_hash)
            .field("external_id", &self.external_id)
            .field("legal_accepted_at", &self.legal_accepted_at)
            .field("external_account", &self.external_account)
            .field("anonymous", &self.anonymous)
            .finish()
    }
}

impl SignUpFields {
    pub fn from_json(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }

    pub fn value_of(&self, kind: &str) -> Option<&str> {
        match kind {
            "email_address" => self.email_address.as_deref(),
            "phone_number" => self.phone_number.as_deref(),
            "username" => self.username.as_deref(),
            "first_name" => self.first_name.as_deref(),
            "last_name" => self.last_name.as_deref(),
            "password" => self.password_hash.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VerificationSnapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_id: Option<String>,
    pub status: String,
    pub strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expire_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_verification_redirect_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SignUpVerifications {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_address: Option<VerificationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number: Option<VerificationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_account: Option<VerificationSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web3_wallet: Option<VerificationSnapshot>,
}

impl SignUpVerifications {
    pub fn from_json(value: &Value) -> Self {
        serde_json::from_value(value.clone()).unwrap_or_default()
    }
}
