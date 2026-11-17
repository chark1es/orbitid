//! Request schemas for the signed-in user routes (`modules/me/shared.ts`) and
//! the small validators that replace zod's `.max()` on strings.

use orbitid_core::error::{error_codes, OrbitError, Result};
use serde::Deserialize;
use serde_json::Value;

use super::types::{deserialize_opt_bool, NullableString};

/// Rejects a string longer than `max` characters with the TS zod error shape.
pub fn assert_max_chars(value: &str, max: usize, param: &str) -> Result<()> {
    if value.chars().count() > max {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param}: must be at most {max} characters"),
        )
        .with_meta(serde_json::json!({ "param_name": param })));
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateProfileBody {
    #[serde(default)]
    pub first_name: NullableString,
    #[serde(default)]
    pub last_name: NullableString,
    #[serde(default)]
    pub username: NullableString,
    #[serde(default)]
    pub unsafe_metadata: Option<Value>,
    #[serde(default)]
    pub primary_email_address_id: NullableString,
    #[serde(default)]
    pub primary_phone_number_id: NullableString,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub legal_accepted: Option<bool>,
}

#[derive(Deserialize)]
pub struct PasswordChangeBody {
    #[serde(default)]
    pub current_password: Option<String>,
    pub new_password: String,
    /// `z.boolean().optional()`: strict, unlike the `zBool` fields.
    #[serde(default)]
    pub sign_out_of_other_sessions: Option<bool>,
}

impl std::fmt::Debug for PasswordChangeBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordChangeBody")
            .field("current_password", &"<redacted>")
            .field("new_password", &"<redacted>")
            .field(
                "sign_out_of_other_sessions",
                &self.sign_out_of_other_sessions,
            )
            .finish()
    }
}

#[derive(Deserialize)]
pub struct PasswordRemoveBody {
    pub current_password: String,
}

impl std::fmt::Debug for PasswordRemoveBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordRemoveBody")
            .field("current_password", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Deserialize)]
pub struct EmailCreateBody {
    pub email_address: String,
}

#[derive(Debug, Deserialize)]
pub struct PhoneCreateBody {
    pub phone_number: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct PhoneUpdateBody {
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub reserved_for_second_factor: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub default_second_factor: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyCodeBody {
    pub code: String,
    #[serde(default)]
    pub strategy: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PrepareBody {
    #[serde(default)]
    pub strategy: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExternalAccountCreateBody {
    pub strategy: String,
    #[serde(default)]
    pub redirect_url: Option<String>,
    #[serde(default)]
    pub additional_scopes: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct TotpAttemptBody {
    pub code: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct PasskeyCreateBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub authenticator_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct PasskeyAttemptBody {
    #[serde(default)]
    pub public_key_credential: Option<Value>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PasskeyRenameBody {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct ImageBody {
    pub file: String,
}

/// Emulates zod's `z.enum(["platform", "cross-platform"]).optional()`.
pub fn validate_authenticator_type(value: &Option<String>) -> Result<()> {
    let Some(value) = value else { return Ok(()) };
    if value != "platform" && value != "cross-platform" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "authenticator_type: expected \"platform\" or \"cross-platform\"",
        )
        .with_meta(serde_json::json!({ "param_name": "authenticator_type" })));
    }
    Ok(())
}
