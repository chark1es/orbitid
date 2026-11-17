//! HTTP routes for the OIDC surface, mirroring `modules/oidc.ts`,
//! `modules/oidc/*`, `modules/api-keys.ts` and `modules/m2m.ts`.

pub mod api_keys;
pub mod api_keys_frontend;
pub mod applications;
pub mod consent;
pub mod device;
pub mod device_client;
pub mod discovery;
pub mod logout;
pub mod m2m;
pub mod m2m_oauth;
pub mod machine;
pub mod token;
pub mod well_known;

use std::net::SocketAddr;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::client_ip;
use orbitid_core::state::AppState;

use crate::services::oidc::issuer::issuer_for;
use crate::web::{escape_html, html_response, redirect, url_with};

/// The socket address of the caller, when the server was started with
/// connect-info (production) — `None` in-process.
#[derive(Debug, Clone, Copy)]
pub struct Peer(pub Option<SocketAddr>);

impl<S> FromRequestParts<S> for Peer
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(Peer(
            parts
                .extensions
                .get::<axum::extract::ConnectInfo<SocketAddr>>()
                .map(|axum::extract::ConnectInfo(address)| *address),
        ))
    }
}

/// Resolves the caller's IP exactly like `clientIp(c)`.
pub fn ip_of(state: &AppState, headers: &HeaderMap, peer: Peer) -> String {
    client_ip(headers, peer.0, state.env.trust_proxy)
}

pub fn issuer_of(state: &AppState, headers: &HeaderMap) -> String {
    issuer_for(state, headers)
}

/// `currentUrl(ctx, c)`: the public authorize URL of this request.
pub fn current_url(state: &AppState, headers: &HeaderMap, uri: &Uri) -> String {
    let path = uri.path();
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let query = uri
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    format!("{}{path}{query}", issuer_of(state, headers))
}

/// The authorize URL to come back to after sign-in, with `prompt=login` /
/// `select_account` and `max_age` removed.
pub fn sign_in_return_url(state: &AppState, headers: &HeaderMap, uri: &Uri) -> String {
    let Ok(mut url) = url::Url::parse(&current_url(state, headers, uri)) else {
        return current_url(state, headers, uri);
    };
    let prompts: Vec<String> = url
        .query_pairs()
        .find(|(key, _)| key == "prompt")
        .map(|(_, value)| {
            value
                .split_whitespace()
                .filter(|prompt| *prompt != "login" && *prompt != "select_account")
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "prompt" && key != "max_age")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in &retained {
            pairs.append_pair(key, value);
        }
        if !prompts.is_empty() {
            pairs.append_pair("prompt", &prompts.join(" "));
        }
    }
    url.to_string()
}

pub fn app_base(state: &AppState) -> String {
    state
        .settings
        .get()
        .application
        .home_url
        .trim_end_matches('/')
        .to_string()
}

pub fn sign_in_url(state: &AppState, redirect_url: &str) -> String {
    url_with(
        &format!("{}/sign-in", app_base(state)),
        &[("redirect_url", Some(redirect_url))],
    )
}

pub fn consent_url(
    state: &AppState,
    app_name: &str,
    client_id: &str,
    scope: &str,
    authorize_url: &str,
) -> String {
    url_with(
        &format!("{}/oauth-consent", app_base(state)),
        &[
            ("client_id", Some(client_id)),
            ("client_name", Some(app_name)),
            ("scope", Some(scope)),
            ("redirect_url", Some(authorize_url)),
        ],
    )
}

/// Device verification URL; `verification_uri_complete` carries the code.
pub fn device_verification_url(state: &AppState, issuer: Option<&str>) -> String {
    let issuer = issuer
        .map(str::to_string)
        .unwrap_or_else(|| state.env.base_url.clone());
    format!("{}/oauth/device", issuer.trim_end_matches('/'))
}

/// Link to the app's sign-in screen that comes back to `target`.
pub fn sign_in_link(state: &AppState, target: &str) -> String {
    match crate::redirects::validate_redirect_url(state, Some(target), "redirect_url") {
        Ok(Some(redirect_url)) => sign_in_url(state, &redirect_url),
        _ => sign_in_url(state, &app_base(state)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseMode {
    Query,
    FormPost,
}

/// Returns the authorization response to the relying party. `form_post` posts
/// the parameters instead, with a nonce-protected inline script and a CSP that
/// allows the form to reach only the redirect URI's origin.
pub fn authorize_response(
    redirect_uri: &str,
    params: &[(&str, Option<&str>)],
    mode: ResponseMode,
) -> Response {
    if mode != ResponseMode::FormPost {
        return redirect(&url_with(redirect_uri, params));
    }
    let nonce = orbitid_core::http::security::csp_nonce();
    let mut inputs = String::new();
    for (name, value) in params {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            inputs.push_str(&format!(
                "<input type=\"hidden\" name=\"{}\" value=\"{}\">",
                escape_html(name),
                escape_html(value)
            ));
        }
    }
    let origin = url::Url::parse(redirect_uri)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "null".into());
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Continue</title></head>\
         <body><form method=\"post\" action=\"{}\">{inputs}\
         <noscript><button type=\"submit\">Continue</button></noscript></form>\
         <script nonce=\"{nonce}\">document.forms[0].submit()</script></body></html>",
        escape_html(redirect_uri)
    );
    html_response(
        html,
        StatusCode::OK,
        &[
            (
                "content-security-policy",
                &format!(
                    "default-src 'none'; script-src 'nonce-{nonce}'; style-src 'none'; form-action {origin}; base-uri 'none'; frame-ancestors 'none'"
                ),
            ),
            ("cache-control", "no-store"),
        ],
    )
}

/// JSON response helper (`c.json`).
pub fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    (status, axum::Json(value)).into_response()
}

/// HTML response with extra headers (`c.html`).
pub fn html_with_headers(html: String, status: StatusCode, headers: &[(&str, &str)]) -> Response {
    html_response(html, status, headers)
}

/// `WWW-Authenticate: Bearer realm="orbitid", error="invalid_token"` without a
/// description.
pub fn bearer_challenge(response: &mut Response) {
    if let Ok(value) = HeaderValue::from_str("Bearer realm=\"orbitid\", error=\"invalid_token\"") {
        response
            .headers_mut()
            .insert(axum::http::header::WWW_AUTHENTICATE, value);
    }
}

/// A 404 for routes that are disabled by settings (`c.notFound()`).
pub fn route_not_found() -> Response {
    let body = json!({
        "errors": [{ "code": error_codes::RESOURCE_NOT_FOUND, "message": "Route not found" }]
    });
    (StatusCode::NOT_FOUND, axum::Json(body)).into_response()
}

/// `401 authentication_invalid` with the Frontend API message.
pub fn authentication_invalid() -> OrbitError {
    OrbitError::unauthorized(
        error_codes::AUTHENTICATION_INVALID,
        "Authentication invalid. Please sign in again.",
    )
}
