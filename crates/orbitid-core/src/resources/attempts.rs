use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignInStatus {
    NeedsIdentifier,
    NeedsFirstFactor,
    NeedsSecondFactor,
    NeedsNewPassword,
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignInFactor {
    pub strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email_address_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_identifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone_number_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignInUserData {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub image_url: String,
    pub has_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignInJson {
    pub object: String,
    pub id: String,
    pub status: SignInStatus,
    pub supported_identifiers: Vec<String>,
    pub supported_first_factors: Option<Vec<SignInFactor>>,
    pub supported_second_factors: Option<Vec<SignInFactor>>,
    pub first_factor_verification: Option<VerificationJson>,
    pub second_factor_verification: Option<VerificationJson>,
    pub identifier: Option<String>,
    pub user_data: Option<SignInUserData>,
    pub created_session_id: Option<String>,
    pub abandon_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SignUpStatus {
    MissingRequirements,
    Complete,
    Abandoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignUpVerificationsJson {
    pub email_address: Option<VerificationJson>,
    pub phone_number: Option<VerificationJson>,
    pub external_account: Option<VerificationJson>,
    pub web3_wallet: Option<VerificationJson>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignUpJson {
    pub object: String,
    pub id: String,
    pub status: SignUpStatus,
    pub required_fields: Vec<String>,
    pub optional_fields: Vec<String>,
    pub missing_fields: Vec<String>,
    pub unverified_fields: Vec<String>,
    pub verifications: SignUpVerificationsJson,
    pub username: Option<String>,
    pub email_address: Option<String>,
    pub phone_number: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub password_enabled: bool,
    pub unsafe_metadata: Metadata,
    pub public_metadata: Metadata,
    pub custom_action: bool,
    pub external_id: Option<String>,
    pub created_session_id: Option<String>,
    pub created_user_id: Option<String>,
    pub abandon_at: i64,
    pub legal_accepted_at: Option<i64>,
}

// ---------- organizations ----------
