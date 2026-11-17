//! Small HTTP helpers for provider endpoints: wall-clock time and the
//! `requestJson` wrapper around [`orbitid_core::safe_fetch`].

use std::time::{SystemTime, UNIX_EPOCH};

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::safe_fetch::{headers as header_map, safe_fetch, SafeFetchOptions};
use orbitid_core::AppState;
use serde_json::Value;

use crate::error::callback_error;

/// Unix epoch milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Serializes form pairs the way `URLSearchParams.toString()` does.
pub fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

/// `requestJson()` from `profiles.ts`.
///
/// A URL the SSRF guard refuses is reported as such; every other transport
/// problem is "could not reach the identity provider". A non-2xx answer is a
/// 502 `oauth_callback_error`, and a body that is not JSON is returned as a
/// string value, matching the TypeScript helper.
pub async fn request_json(
    state: Option<&AppState>,
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<String>,
) -> Result<Value, OrbitError> {
    let mut map = axum::http::HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            name.parse::<axum::http::HeaderName>(),
            axum::http::HeaderValue::from_str(value),
        ) {
            map.insert(name, value);
        }
    }
    let response = safe_fetch(
        state,
        url,
        SafeFetchOptions {
            method: Some(method.to_string()),
            headers: map,
            body: body.map(String::into_bytes),
            timeout_ms: Some(10_000),
            max_bytes: Some(512 * 1024),
            ..SafeFetchOptions::default()
        },
    )
    .await
    .map_err(|error| {
        if error.code == error_codes::FORM_PARAM_FORMAT_INVALID {
            callback_error(format!(
                "The identity provider URL was refused: {}",
                error.message
            ))
        } else {
            callback_error("Could not reach the identity provider")
        }
    })?;
    if !response.ok() {
        return Err(callback_error(format!(
            "Identity provider request failed ({})",
            response.status
        )));
    }
    Ok(serde_json::from_str(&response.body).unwrap_or(Value::String(response.body)))
}

/// Builds the header list for a JSON request (accept + optional entries).
pub fn json_headers(extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut out = vec![("accept".to_string(), "application/json".to_string())];
    for (name, value) in extra {
        out.push(((*name).to_string(), (*value).to_string()));
    }
    out
}

/// Re-export so callers building non-`request_json` calls share one builder.
pub fn header_pairs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect()
}

/// Header map helper mirroring core's, kept here so adapters do not import it twice.
pub fn headers(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
    header_map(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_body_percent_encodes() {
        assert_eq!(form_body(&[("a", "x y"), ("b", "1&2")]), "a=x+y&b=1%262");
    }

    #[test]
    fn now_is_a_plausible_epoch() {
        assert!(now_ms() > 1_700_000_000_000);
    }
}
