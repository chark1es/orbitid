//! Session JWT claims and reverification types, ported from
//! `packages/shared/src/claims.ts`.
//!
//! `SessionClaims` is a wire type (it is what lands in `__session`), so field
//! names and optionality follow the TypeScript interface exactly. `AuthObject`
//! from the same TS module is a framework helper with closures; it belongs to
//! the client SDKs, not the server, and is intentionally not ported.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatusClaim {
    Active,
    Pending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActClaim {
    pub sub: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionClaims {
    /// issuer = frontend API URL
    pub iss: String,
    /// subject = user id
    pub sub: String,
    pub sid: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub azp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_permissions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_permissions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub act: Option<ActClaim>,
    /// `[firstFactorAgeMinutes, secondFactorAgeMinutes]`, -1 = not performed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fva: Option<[i64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sts: Option<SessionStatusClaim>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anonymous: Option<bool>,
    /// Custom claims from `session.customClaims` or a JWT template.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReverificationLevel {
    FirstFactor,
    SecondFactor,
    MultiFactor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ReverificationConfig {
    Level {
        level: ReverificationLevel,
        after_minutes: i64,
    },
    Named(String),
}

/// Claims that belong to the server and must never be set by a template.
pub const RESERVED_SESSION_CLAIMS: &[&str] = &[
    "iss",
    "sub",
    "sid",
    "iat",
    "nbf",
    "exp",
    "jti",
    "azp",
    "act",
    "sts",
    "fva",
    "anonymous",
    "token_type",
    "org_id",
    "org_slug",
    "org_role",
    "org_permissions",
    "roles",
    "role_permissions",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_shape_round_trips() {
        let claims = SessionClaims {
            iss: "http://localhost:4000".into(),
            sub: "user_1".into(),
            sid: "sess_1".into(),
            iat: 1,
            nbf: 1,
            exp: 2,
            azp: None,
            org_id: None,
            org_slug: None,
            org_role: None,
            org_permissions: None,
            roles: None,
            role_permissions: None,
            act: None,
            fva: Some([0, -1]),
            sts: Some(SessionStatusClaim::Active),
            anonymous: None,
            extra: Map::new(),
        };
        let json = serde_json::to_value(&claims).unwrap();
        assert_eq!(json["fva"], serde_json::json!([0, -1]));
        assert_eq!(json["sts"], "active");
        assert!(json.get("azp").is_none());
    }
}
