//! Safe redirect validation for post-auth navigation, ported from
//! `modules/auth/redirects.ts`.
//!
//! The sign-in routes live in `orbitid-fapi-auth`, so this crate keeps its own
//! copy of the pure helper instead of depending on a sibling L3 crate.

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::state::AppState;
use url::Url;

pub fn is_dev_localhost(origin: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
}

fn safe_origin(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

fn home_base(state: &AppState) -> String {
    let settings = state.settings.get();
    if settings.application.home_url.is_empty() {
        state.env.base_url.clone()
    } else {
        settings.application.home_url.clone()
    }
}

/// Returns the normalized absolute URL, or an error for untrusted origins.
pub fn validate_redirect_url(
    state: &AppState,
    value: Option<&str>,
    param: &str,
) -> Result<Option<String>, OrbitError> {
    let Some(value) = value else { return Ok(None) };
    let raw = value.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let base = home_base(state);
    let url = Url::parse(raw).or_else(|_| Url::parse(&base).and_then(|base| base.join(raw)));
    let Ok(url) = url else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} is not a valid URL"),
        )
        .with_meta(serde_json::json!({ "param_name": param })));
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must use http(s)"),
        )
        .with_meta(serde_json::json!({ "param_name": param })));
    }
    let settings = state.settings.get();
    let app = &settings.application;
    let allowed: Vec<String> = app
        .allowed_origins
        .iter()
        .chain(app.allowed_redirect_origins.iter())
        .filter_map(|origin| safe_origin(origin))
        .collect();
    let origin = url.origin().ascii_serialization();
    if allowed.contains(&origin) {
        return Ok(Some(url.to_string()));
    }
    if app.development_mode && is_dev_localhost(&origin) {
        return Ok(Some(url.to_string()));
    }
    if safe_origin(&app.home_url).as_deref() == Some(origin.as_str()) {
        return Ok(Some(url.to_string()));
    }
    Err(OrbitError::unprocessable(
        error_codes::FORM_PARAM_FORMAT_INVALID,
        format!("{param} origin is not allowed"),
    )
    .with_meta(serde_json::json!({ "param_name": param, "allowed_origins": allowed })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_localhost_matches_ports_only() {
        assert!(is_dev_localhost("http://localhost:3000"));
        assert!(is_dev_localhost("https://127.0.0.1"));
        assert!(!is_dev_localhost("http://localhost.evil.example"));
    }
}
