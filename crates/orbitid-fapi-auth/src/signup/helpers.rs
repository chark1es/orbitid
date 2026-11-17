//! Shared sign-up request helpers: body application, legal consent and the
//! metadata validator, ported from `modules/sign-up.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::SignUpRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::{client_azp, get_or_create_client};
use orbitid_identity::users::{
    assert_username_available, is_valid_email, normalize_email, normalize_phone,
};

use crate::state::SignUpFields;
use crate::util::{bounded, nullable_bounded, Reply};

#[derive(Default, serde::Deserialize)]
pub struct CreateBody {
    pub email_address: Option<String>,
    pub phone_number: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub password: Option<String>,
    pub external_id: Option<serde_json::Value>,
    pub strategy: Option<String>,
    pub redirect_url: Option<String>,
    pub action_complete_redirect_url: Option<String>,
    pub ticket: Option<String>,
    pub transfer: Option<bool>,
    pub unsafe_metadata: Option<serde_json::Value>,
    pub legal_accepted: Option<bool>,
    pub captcha_token: Option<String>,
}

impl std::fmt::Debug for CreateBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateBody")
            .field("email_address", &self.email_address)
            .field("phone_number", &self.phone_number)
            .field("username", &self.username)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("password", &"<redacted>")
            .field("external_id", &self.external_id)
            .field("strategy", &self.strategy)
            .field("redirect_url", &self.redirect_url)
            .field(
                "action_complete_redirect_url",
                &self.action_complete_redirect_url,
            )
            .field("ticket", &self.ticket)
            .field("transfer", &self.transfer)
            .field("unsafe_metadata", &self.unsafe_metadata)
            .field("legal_accepted", &self.legal_accepted)
            .field("captcha_token", &"<redacted>")
            .finish()
    }
}

impl CreateBody {
    pub fn validate(self) -> Result<Self> {
        let mut body = self;
        body.email_address = bounded(body.email_address, 320, "email_address")?;
        body.phone_number = bounded(body.phone_number, 32, "phone_number")?;
        body.username = bounded(body.username, 64, "username")?;
        body.first_name = bounded(body.first_name, 256, "first_name")?;
        body.last_name = bounded(body.last_name, 256, "last_name")?;
        body.password = bounded(body.password, 256, "password")?;
        body.strategy = bounded(body.strategy, 64, "strategy")?;
        body.redirect_url = bounded(body.redirect_url, 2048, "redirect_url")?;
        body.action_complete_redirect_url = bounded(
            body.action_complete_redirect_url,
            2048,
            "action_complete_redirect_url",
        )?;
        body.ticket = bounded(body.ticket, 512, "ticket")?;
        body.captcha_token = bounded(body.captcha_token, 4096, "captcha_token")?;
        if let Some(value) = &body.external_id {
            nullable_bounded(Some(value.clone()), 256, "external_id")?;
        }
        body.unsafe_metadata = validate_metadata(body.unsafe_metadata)?;
        Ok(body)
    }
}

#[derive(Default, serde::Deserialize)]
pub struct UpdateBody {
    pub email_address: Option<serde_json::Value>,
    pub phone_number: Option<serde_json::Value>,
    pub username: Option<serde_json::Value>,
    pub first_name: Option<serde_json::Value>,
    pub last_name: Option<serde_json::Value>,
    pub password: Option<serde_json::Value>,
    pub external_id: Option<serde_json::Value>,
    pub unsafe_metadata: Option<serde_json::Value>,
    pub legal_accepted: Option<bool>,
    pub redirect_url: Option<String>,
    pub captcha_token: Option<String>,
}

impl std::fmt::Debug for UpdateBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateBody")
            .field("email_address", &self.email_address)
            .field("phone_number", &self.phone_number)
            .field("username", &self.username)
            .field("first_name", &self.first_name)
            .field("last_name", &self.last_name)
            .field("password", &"<redacted>")
            .field("external_id", &self.external_id)
            .field("unsafe_metadata", &self.unsafe_metadata)
            .field("legal_accepted", &self.legal_accepted)
            .field("redirect_url", &self.redirect_url)
            .field("captcha_token", &"<redacted>")
            .finish()
    }
}

impl UpdateBody {
    pub fn validate(self) -> Result<Self> {
        let mut body = self;
        body.email_address = validate_nullable(body.email_address, 320, "email_address")?;
        body.phone_number = validate_nullable(body.phone_number, 32, "phone_number")?;
        body.username = validate_nullable(body.username, 64, "username")?;
        body.first_name = validate_nullable(body.first_name, 256, "first_name")?;
        body.last_name = validate_nullable(body.last_name, 256, "last_name")?;
        body.password = validate_nullable(body.password, 256, "password")?;
        body.external_id = validate_nullable(body.external_id, 256, "external_id")?;
        body.unsafe_metadata = validate_metadata(body.unsafe_metadata)?;
        body.redirect_url = bounded(body.redirect_url, 2048, "redirect_url")?;
        body.captcha_token = bounded(body.captcha_token, 4096, "captcha_token")?;
        Ok(body)
    }
}

fn validate_nullable(
    value: Option<serde_json::Value>,
    max: usize,
    param: &str,
) -> Result<Option<serde_json::Value>> {
    match value {
        Some(serde_json::Value::String(text)) => {
            bounded(Some(text), max, param).map(|value| value.map(serde_json::Value::String))
        }
        other => Ok(other),
    }
}

/// `zMetadata`: a JSON object (or JSON-encoded form string) bounded to 100 keys
/// and 16 KB.
pub fn validate_metadata(value: Option<serde_json::Value>) -> Result<Option<serde_json::Value>> {
    let Some(value) = value else { return Ok(None) };
    let value = match value {
        serde_json::Value::String(text) => match serde_json::from_str(&text) {
            Ok(parsed) => parsed,
            Err(_) => {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "unsafe_metadata must be an object",
                )
                .with_meta(serde_json::json!({ "param_name": "unsafe_metadata" })))
            }
        },
        other => other,
    };
    let serde_json::Value::Object(map) = value else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "unsafe_metadata must be an object",
        )
        .with_meta(serde_json::json!({ "param_name": "unsafe_metadata" })));
    };
    if map.len() > 100 || serde_json::to_string(&map).map(|s| s.len()).unwrap_or(0) > 16 * 1024 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "unsafe_metadata is too large",
        )
        .with_meta(serde_json::json!({ "param_name": "unsafe_metadata" })));
    }
    Ok(Some(serde_json::Value::Object(map)))
}

/// The object form of validated metadata, if any.
pub fn as_metadata(value: &Option<serde_json::Value>) -> Option<Metadata> {
    value.as_ref().and_then(|value| value.as_object().cloned())
}

fn string_field(value: &Option<serde_json::Value>) -> Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(serde_json::Value::String(text)) => Ok(Some(text.clone())),
        Some(serde_json::Value::Null) => Ok(None),
        Some(_) => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "Expected a string",
        )),
    }
}

/// `applyBodyFields`: merges a create/patch body into the stored fields.
pub async fn apply_body_fields(
    state: &AppState,
    fields: &SignUpFields,
    body: &UpdateBody,
) -> Result<SignUpFields> {
    let settings = state.settings.get();
    let mut next = fields.clone();
    if let Some(serde_json::Value::String(raw)) = &body.email_address {
        if !settings.attributes.email_address.enabled {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_UNKNOWN,
                "Email addresses are disabled for this instance",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
        let email = normalize_email(raw);
        if !is_valid_email(&email) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "email_address is not valid",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
        next.email_address = Some(email);
    }
    if let Some(serde_json::Value::String(raw)) = &body.phone_number {
        if !settings.attributes.phone_number.enabled {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_UNKNOWN,
                "Phone numbers are disabled for this instance",
            )
            .with_meta(serde_json::json!({ "param_name": "phone_number" })));
        }
        next.phone_number = Some(normalize_phone(raw)?);
    }
    if let Some(username) = string_field(&body.username)? {
        if !settings.attributes.username.enabled {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_UNKNOWN,
                "Usernames are disabled for this instance",
            )
            .with_meta(serde_json::json!({ "param_name": "username" })));
        }
        if Some(&username) != fields.username.as_ref() {
            assert_username_available(state, &username, None).await?;
        }
        next.username = Some(username);
    }
    if body.first_name.is_some() {
        next.first_name = string_field(&body.first_name)?;
    }
    if body.last_name.is_some() {
        next.last_name = string_field(&body.last_name)?;
    }
    if body.external_id.is_some() {
        next.external_id = string_field(&body.external_id)?;
    }
    if let Some(password) = string_field(&body.password)? {
        if !password.is_empty() {
            orbitid_credentials::assert_password_valid(state, &password).await?;
            next.password_hash = Some(orbitid_credentials::hash_password(&password).await?);
        }
    }
    Ok(next)
}

/// `validateLegal`: a required consent must be explicitly accepted.
pub fn validate_legal(state: &AppState, accepted: Option<bool>) -> Result<()> {
    let settings = state.settings.get();
    if settings.sign_up.legal_consent_required && accepted != Some(true) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "You must accept the terms to sign up",
        )
        .with_meta(serde_json::json!({ "param_name": "legal_accepted" })));
    }
    Ok(())
}

pub async fn load_sign_up(state: &AppState, client_id: &str, id: &str) -> Result<SignUpRow> {
    let row = crate::signup::core::reload_sign_up(state, id).await?;
    if row.client_id != client_id {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Sign-up not found",
        ));
    }
    Ok(row)
}

pub async fn abandon_previous(state: &AppState, client_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE sign_ups SET status = 'abandoned', version = version + 1, updated_at = $1 \
         WHERE client_id = $2 AND status NOT IN ('complete','abandoned')",
    )
    .bind(orbitid_core::http::now())
    .bind(client_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Opens the request's client and returns it with any minted cookie.
pub async fn open_client(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    method: &str,
    path: &str,
) -> Result<(orbitid_core::models::ClientRow, Option<String>)> {
    get_or_create_client(state, headers, method, path).await
}

pub fn azp(headers: &axum::http::HeaderMap) -> Option<String> {
    client_azp(headers)
}

pub async fn respond(
    state: &AppState,
    client: &orbitid_core::models::ClientRow,
    azp: Option<&str>,
    row: &SignUpRow,
    cookies: Vec<String>,
) -> Result<Reply> {
    crate::signin::helpers::respond_sign_up(state, client, azp, row, cookies).await
}
