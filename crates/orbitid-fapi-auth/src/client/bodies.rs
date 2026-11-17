use orbitid_core::error::{error_codes, OrbitError, Result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Default, Deserialize)]
pub struct TouchBody {
    pub(super) active_organization_id: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
pub struct TokenBody {
    pub(super) template: Option<String>,
    #[allow(dead_code)]
    pub(super) skip_cache: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
pub struct VerifyBody {
    pub(super) level: Option<String>,
}

impl VerifyBody {
    pub(super) fn validate(self) -> Result<Self> {
        if let Some(level) = &self.level {
            if !["first_factor", "second_factor", "multi_factor"].contains(&level.as_str()) {
                return Err(bad_enum("level"));
            }
        }
        Ok(self)
    }
}

pub(super) fn bad_enum(param: &str) -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PARAM_FORMAT_INVALID,
        format!("{param}: invalid option"),
    )
    .with_meta(serde_json::json!({ "param_name": param }))
}

pub(super) fn bad_missing(param: &str) -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PARAM_MISSING,
        format!("{param} is missing"),
    )
    .with_meta(serde_json::json!({ "param_name": param }))
}

#[derive(Debug, Default, Deserialize)]
pub struct PrepareFirstBody {
    pub(super) strategy: Option<String>,
    pub(super) email_address_id: Option<String>,
    pub(super) phone_number_id: Option<String>,
}

impl PrepareFirstBody {
    pub(super) fn validate(self) -> Result<Self> {
        if let Some(strategy) = &self.strategy {
            if !["email_code", "phone_code", "password"].contains(&strategy.as_str()) {
                return Err(bad_enum("strategy"));
            }
        }
        Ok(self)
    }
}

#[derive(Default, Deserialize)]
pub struct AttemptFirstBody {
    pub(super) strategy: Option<String>,
    pub(super) code: Option<String>,
    pub(super) password: Option<String>,
}

impl std::fmt::Debug for AttemptFirstBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttemptFirstBody")
            .field("strategy", &self.strategy)
            .field("code", &self.code)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl AttemptFirstBody {
    pub(super) fn validate(self) -> Result<Self> {
        if let Some(strategy) = &self.strategy {
            if !["email_code", "phone_code", "password"].contains(&strategy.as_str()) {
                return Err(bad_enum("strategy"));
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct PrepareSecondBody {
    pub(super) strategy: Option<String>,
    pub(super) phone_number_id: Option<String>,
}

impl PrepareSecondBody {
    pub(super) fn validate(self) -> Result<Self> {
        let Some(strategy) = &self.strategy else {
            return Err(bad_missing("strategy"));
        };
        if !["totp", "phone_code", "backup_code"].contains(&strategy.as_str()) {
            return Err(bad_enum("strategy"));
        }
        Ok(self)
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct AttemptSecondBody {
    pub(super) strategy: Option<String>,
    pub(super) code: Option<String>,
}

impl AttemptSecondBody {
    pub(super) fn validate(self) -> Result<Self> {
        let Some(strategy) = &self.strategy else {
            return Err(bad_missing("strategy"));
        };
        if !["totp", "phone_code", "backup_code"].contains(&strategy.as_str()) {
            return Err(bad_enum("strategy"));
        }
        if self.code.as_deref().unwrap_or_default().is_empty() {
            // `z.string().min(1)` on a missing or empty code.
            return Err(bad_enum("code"));
        }
        Ok(self)
    }
}
