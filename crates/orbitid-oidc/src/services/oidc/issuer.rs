//! Public origin used as the OIDC `issuer` and as the base of every advertised
//! endpoint, ported from `services/oidc/issuer.ts`.
//!
//! `ORBITID_BASE_URL` (env.base_url) is the stable, canonical answer and wins
//! everywhere. Only when the operator did not set it *and* explicitly trusts a
//! reverse proxy do we read the forwarded scheme and host.

use axum::http::HeaderMap;
use url::Url;

use orbitid_core::state::AppState;

fn first_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn strip_slash(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

/// Absolute public origin, never with a trailing slash.
pub fn issuer_for(state: &AppState, headers: &HeaderMap) -> String {
    let env = &state.env;
    if env.base_url_explicit || env.trust_proxy < 1 {
        return strip_slash(&env.base_url);
    }
    let proto = first_value(headers, "x-forwarded-proto").to_ascii_lowercase();
    let host = first_value(headers, "x-forwarded-host");
    if (proto != "https" && proto != "http") || host.is_empty() {
        return strip_slash(&env.base_url);
    }
    let port = first_value(headers, "x-forwarded-port");
    let has_port = host
        .rsplit_once(':')
        .map(|(_, port)| port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty())
        .unwrap_or(false);
    let authority = if has_port || port.is_empty() {
        host
    } else {
        format!("{host}:{port}")
    };
    match Url::parse(&format!("{proto}://{authority}")) {
        // Reject credentials, paths or query strings smuggled into the forwarded host.
        Ok(url)
            if url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none() =>
        {
            url.origin().ascii_serialization()
        }
        _ => strip_slash(&env.base_url),
    }
}

/// Builds an absolute URL below the public issuer, appending non-empty params.
pub fn issuer_url(
    state: &AppState,
    headers: &HeaderMap,
    path: &str,
    params: &[(&str, Option<&str>)],
) -> String {
    let base = format!("{}{}", issuer_for(state, headers), path);
    crate::web::url_with(&base, params)
}

/// True when the loopback redirect URI matches on scheme/host/path and only the
/// port differs (RFC 8252 §7.3).
pub fn loopback_redirect_match(registered: &str, requested: &str) -> bool {
    let is_loopback = |host: &str| host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    let (Ok(a), Ok(b)) = (Url::parse(registered), Url::parse(requested)) else {
        return false;
    };
    if a.scheme() != "http" || b.scheme() != "http" {
        return false;
    }
    let (Some(a_host), Some(b_host)) = (a.host_str(), b.host_str()) else {
        return false;
    };
    if !is_loopback(a_host) || a_host != b_host {
        return false;
    }
    a.path() == b.path() && a.query() == b.query()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_accepts_another_port_only() {
        assert!(loopback_redirect_match(
            "http://127.0.0.1/callback",
            "http://127.0.0.1:53121/callback"
        ));
        assert!(!loopback_redirect_match(
            "http://127.0.0.1/callback",
            "http://localhost:53121/callback"
        ));
        assert!(!loopback_redirect_match(
            "http://127.0.0.1/callback",
            "http://127.0.0.1:53121/other"
        ));
        assert!(!loopback_redirect_match(
            "https://127.0.0.1/callback",
            "https://127.0.0.1:53121/callback"
        ));
    }
}
