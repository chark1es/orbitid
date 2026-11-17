use super::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    EmailCode,
    EmailLink,
    Sms,
    Passkey,
    Oauth,
    Sso,
    Ticket,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Ended,
    Expired,
    Removed,
    Abandoned,
    Replaced,
    Revoked,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PublicUserData {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub image_url: String,
    pub has_image: bool,
    pub identifier: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionActivityJson {
    pub id: String,
    pub is_mobile: bool,
    pub ip_address: String,
    pub city: Option<String>,
    pub country: Option<String>,
    pub browser_name: String,
    pub browser_version: String,
    pub device_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionJson {
    pub object: String,
    pub id: String,
    pub status: SessionStatus,
    pub expire_at: i64,
    pub abandon_at: i64,
    pub last_active_at: i64,
    pub last_active_organization_id: Option<String>,
    pub actor: Option<Value>,
    pub user: Option<UserJson>,
    pub public_user_data: Option<PublicUserData>,
    pub factor_verification_age: Option<[i64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub second_factor_skipped_by_trusted_device: Option<bool>,
    pub sign_in_method: Option<AuthMethod>,
    pub last_active_token: Option<TokenJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_activity: Option<SessionActivityJson>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TokenJson {
    pub object: String,
    pub jwt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClientJson {
    pub object: String,
    pub id: String,
    pub sessions: Vec<SessionJson>,
    pub sign_in: Option<SignInJson>,
    pub sign_up: Option<SignUpJson>,
    pub last_active_session_id: Option<String>,
    pub cookie_expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
