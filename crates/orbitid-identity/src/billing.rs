//! Operator-configured external billing portals (migration 0021).
//!
//! OrbitID does not process payments. An operator may store one external
//! billing-portal link per organization and per OAuth application; the
//! prebuilt account components link to it. This module owns the write-time
//! validation shared by the Backend API (organizations) and the OIDC crate
//! (applications), so both accept exactly the same URLs.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

/// Longest accepted billing-portal URL, in characters.
pub const MAX_BILLING_PORTAL_URL_CHARS: usize = 2048;

fn invalid(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(serde_json::json!({ "param_name": param }))
}

/// Validates a billing-portal URL from an operator request.
///
/// `None` or a blank string clears the link (`Ok(None)`). Anything else must
/// be an absolute `https` URL that passes the instance's outbound-URL checks
/// ([`orbitid_core::safe_fetch::assert_public_url`]: no embedded credentials,
/// a host, no private or loopback IP literal unless private networks are
/// allowed). The stored value is the parsed, normalized URL.
pub async fn validate_billing_portal_url(
    state: &AppState,
    raw: Option<&str>,
    param: &str,
) -> Result<Option<String>> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_BILLING_PORTAL_URL_CHARS {
        return Err(invalid(
            param,
            format!("{param} must be at most {MAX_BILLING_PORTAL_URL_CHARS} characters"),
        ));
    }
    if value
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(invalid(
            param,
            format!("{param} must not contain whitespace"),
        ));
    }
    let url = orbitid_core::safe_fetch::assert_public_url(Some(state), value, param).await?;
    if url.scheme() != "https" {
        return Err(invalid(
            param,
            format!("{param} must be an absolute https URL"),
        ));
    }
    Ok(Some(url.to_string()))
}
