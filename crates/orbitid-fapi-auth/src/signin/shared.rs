//! Request schemas and identifier helpers for the sign-in routes, ported from
//! `modules/sign-in/shared.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::util::bounded;

#[derive(Default, Deserialize)]
pub struct CreateBody {
    pub identifier: Option<String>,
    pub strategy: Option<String>,
    pub password: Option<String>,
    pub ticket: Option<String>,
    pub redirect_url: Option<String>,
    pub action_complete_redirect_url: Option<String>,
    pub captcha_token: Option<String>,
    pub transfer: Option<bool>,
}

impl std::fmt::Debug for CreateBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateBody")
            .field("identifier", &self.identifier)
            .field("strategy", &self.strategy)
            .field("password", &"<redacted>")
            .field("ticket", &self.ticket)
            .field("redirect_url", &self.redirect_url)
            .field(
                "action_complete_redirect_url",
                &self.action_complete_redirect_url,
            )
            .field("captcha_token", &"<redacted>")
            .field("transfer", &self.transfer)
            .finish()
    }
}

impl CreateBody {
    pub fn validate(self) -> Result<Self> {
        Ok(Self {
            identifier: bounded(self.identifier, 320, "identifier")?,
            strategy: bounded(self.strategy, 64, "strategy")?,
            password: bounded(self.password, 256, "password")?,
            ticket: bounded(self.ticket, 512, "ticket")?,
            redirect_url: bounded(self.redirect_url, 2048, "redirect_url")?,
            action_complete_redirect_url: bounded(
                self.action_complete_redirect_url,
                2048,
                "action_complete_redirect_url",
            )?,
            captcha_token: bounded(self.captcha_token, 4096, "captcha_token")?,
            transfer: self.transfer,
        })
    }
}

#[derive(Default, Deserialize)]
pub struct PrepareFirstBody {
    pub strategy: Option<String>,
    pub email_address_id: Option<String>,
    pub phone_number_id: Option<String>,
    pub redirect_url: Option<String>,
    pub captcha_token: Option<String>,
}

impl std::fmt::Debug for PrepareFirstBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrepareFirstBody")
            .field("strategy", &self.strategy)
            .field("email_address_id", &self.email_address_id)
            .field("phone_number_id", &self.phone_number_id)
            .field("redirect_url", &self.redirect_url)
            .field("captcha_token", &"<redacted>")
            .finish()
    }
}

impl PrepareFirstBody {
    pub fn validate(self) -> Result<Self> {
        Ok(Self {
            strategy: bounded(self.strategy, 64, "strategy")?,
            email_address_id: bounded(self.email_address_id, 64, "email_address_id")?,
            phone_number_id: bounded(self.phone_number_id, 64, "phone_number_id")?,
            redirect_url: bounded(self.redirect_url, 2048, "redirect_url")?,
            captcha_token: bounded(self.captcha_token, 4096, "captcha_token")?,
        })
    }
}

#[derive(Default, Deserialize)]
pub struct AttemptFirstBody {
    pub strategy: Option<String>,
    pub code: Option<String>,
    pub password: Option<String>,
    pub signature: Option<String>,
    pub public_key_credential: Option<Value>,
}

impl std::fmt::Debug for AttemptFirstBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AttemptFirstBody")
            .field("strategy", &self.strategy)
            .field("code", &self.code)
            .field("password", &"<redacted>")
            .field("signature", &self.signature)
            .field("public_key_credential", &self.public_key_credential)
            .finish()
    }
}

impl AttemptFirstBody {
    pub fn validate(self) -> Result<Self> {
        let _ = bounded(self.signature, 8192, "signature")?;
        Ok(Self {
            strategy: bounded(self.strategy, 64, "strategy")?,
            code: bounded(self.code, 64, "code")?,
            password: bounded(self.password, 256, "password")?,
            signature: None,
            public_key_credential: self.public_key_credential,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct PrepareSecondBody {
    pub strategy: Option<String>,
    pub phone_number_id: Option<String>,
    pub email_address_id: Option<String>,
}

impl PrepareSecondBody {
    pub fn validate(self) -> Result<Self> {
        Ok(Self {
            strategy: bounded(self.strategy, 64, "strategy")?,
            phone_number_id: bounded(self.phone_number_id, 64, "phone_number_id")?,
            email_address_id: bounded(self.email_address_id, 64, "email_address_id")?,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct AttemptSecondBody {
    pub strategy: Option<String>,
    pub code: Option<String>,
    pub trust_device: Option<bool>,
}

impl AttemptSecondBody {
    pub fn validate(self) -> Result<Self> {
        Ok(Self {
            strategy: bounded(self.strategy, 64, "strategy")?,
            code: bounded(self.code, 64, "code")?,
            trust_device: self.trust_device,
        })
    }
}

#[derive(Deserialize)]
pub struct ResetPasswordBody {
    pub password: Option<String>,
    pub sign_out_of_other_sessions: Option<bool>,
    pub redirect_url: Option<String>,
}

impl std::fmt::Debug for ResetPasswordBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResetPasswordBody")
            .field("password", &"<redacted>")
            .field(
                "sign_out_of_other_sessions",
                &self.sign_out_of_other_sessions,
            )
            .field("redirect_url", &self.redirect_url)
            .finish()
    }
}

impl ResetPasswordBody {
    pub fn validate(self) -> Result<(String, Option<bool>, Option<String>)> {
        let password = self.password.ok_or_else(|| {
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "password is missing")
                .with_meta(serde_json::json!({ "param_name": "password" }))
        })?;
        let password = bounded(Some(password), 256, "password")?.unwrap_or_default();
        Ok((
            password,
            self.sign_out_of_other_sessions,
            bounded(self.redirect_url, 2048, "redirect_url")?,
        ))
    }
}

/// `body.captcha_token ?? header("x-captcha-token")`.
pub fn captcha_token(body_token: Option<&str>, headers: &axum::http::HeaderMap) -> Option<String> {
    body_token.map(str::to_string).or_else(|| {
        headers
            .get("x-captcha-token")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    })
}

/// A hash no password matches, so unknown-account checks cost the same.
pub async fn dummy_password_hash() -> String {
    let token = orbitid_core::crypto::random_token(24);
    orbitid_credentials::hash_password(&token)
        .await
        .unwrap_or_else(|_| "invalid".to_string())
}
