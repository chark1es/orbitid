//! Error constructors shared by the federation adapters.
//!
//! Status codes and error codes mirror the TypeScript implementation:
//! provider configuration errors are 400 `oauth_provider_not_enabled`, provider
//! transport/verification failures are 502 `oauth_callback_error`, and SAML
//! validation failures are 400 `verification_failed`.

use orbitid_core::error::{error_codes, OrbitError};

/// 400 `oauth_provider_not_enabled`.
pub fn provider_not_enabled(message: impl Into<String>) -> OrbitError {
    OrbitError::bad_request(error_codes::OAUTH_PROVIDER_NOT_ENABLED, message)
}

/// 502 `oauth_callback_error` — the identity provider failed us.
pub fn callback_error(message: impl Into<String>) -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        error_codes::OAUTH_CALLBACK_ERROR,
        message,
    )
}

/// 400 `oauth_callback_error` — the callback itself was invalid.
pub fn callback_invalid(message: impl Into<String>) -> OrbitError {
    OrbitError::bad_request(error_codes::OAUTH_CALLBACK_ERROR, message)
}

/// 400 `verification_failed` — a SAML assertion did not validate.
pub fn verification_failed(message: impl Into<String>) -> OrbitError {
    OrbitError::bad_request(error_codes::VERIFICATION_FAILED, message)
}

/// 422 `form_param_format_invalid` with the offending parameter name.
pub fn invalid_param(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(serde_json::json!({ "param_name": param }))
}

/// 422 `form_param_missing`.
pub fn missing_param(message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, message)
}
