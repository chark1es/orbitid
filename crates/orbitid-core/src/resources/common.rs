use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type Metadata = Map<String, Value>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Unverified,
    Verified,
    Transferable,
    Failed,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerificationErrorJson {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerificationJson {
    pub status: VerificationStatus,
    pub strategy: String,
    /// Required nullable: an OAuth account has no attempt counter.
    pub attempts: Option<i64>,
    pub expire_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_verification_redirect_url: Option<String>,
    /// Always serialized, including `null`: the TypeScript serializer emits the
    /// key on every status.
    pub error: Option<VerificationErrorJson>,
    pub nonce: Option<String>,
}
