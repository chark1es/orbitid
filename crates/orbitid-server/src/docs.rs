//! `GET /docs`, `/docs/assets/*` and `GET /v1/openapi.json`, ported from
//! the retired TypeScript server.
//!
//! The docs UI is a static ES-module viewer; the files and the specification are
//! embedded at compile time so a deployed binary needs no asset or source tree.
//! The committed `docs/openapi.json` remains the single source of truth, with its
//! `servers[0].url` rewritten to this instance's base URL at request time.

use std::sync::OnceLock;

use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use orbitid_core::error::route_not_found;
use orbitid_core::AppState;

const PAGE_HTML: &str = include_str!("../assets/docs/page.html");
const OPENAPI_JSON: &str = include_str!("../../../docs/openapi.json");

/// Every asset the page can request, with the TypeScript server's MIME types.
const ASSETS: [(&str, &str, &str); 8] = [
    (
        "viewer.css",
        include_str!("../assets/docs/viewer.css"),
        "text/css; charset=utf-8",
    ),
    (
        "viewer.js",
        include_str!("../assets/docs/viewer.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/curl.js",
        include_str!("../assets/docs/viewer/curl.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/dom.js",
        include_str!("../assets/docs/viewer/dom.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/operation.js",
        include_str!("../assets/docs/viewer/operation.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/page.js",
        include_str!("../assets/docs/viewer/page.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/schema.js",
        include_str!("../assets/docs/viewer/schema.js"),
        "text/javascript; charset=utf-8",
    ),
    (
        "viewer/state.js",
        include_str!("../assets/docs/viewer/state.js"),
        "text/javascript; charset=utf-8",
    ),
];

const DOCS_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn docs_headers(response: &mut Response, content_type: &'static str) {
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(DOCS_CSP),
    );
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
}

pub async fn docs_index() -> Response {
    let mut response = Html(PAGE_HTML).into_response();
    docs_headers(&mut response, "text/html; charset=utf-8");
    response
}

pub async fn docs_asset(Path(path): Path<String>) -> Response {
    match ASSETS.iter().find(|(name, _, _)| *name == path) {
        Some((_, body, content_type)) => {
            let mut response = (StatusCode::OK, *body).into_response();
            docs_headers(&mut response, content_type);
            response
        }
        None => route_not_found().into_response(),
    }
}

fn spec_document(state: &AppState) -> Option<serde_json::Value> {
    static TEMPLATE: OnceLock<Option<serde_json::Value>> = OnceLock::new();
    let template = TEMPLATE.get_or_init(|| serde_json::from_str(OPENAPI_JSON).ok());
    let mut document = template.clone()?;
    if let Some(servers) = document
        .get_mut("servers")
        .and_then(|value| value.as_array_mut())
    {
        if let Some(first) = servers.first_mut() {
            first["url"] = serde_json::Value::String(state.env.base_url.clone());
        }
    }
    Some(document)
}

pub async fn openapi_json(axum::extract::State(state): axum::extract::State<AppState>) -> Response {
    match spec_document(&state) {
        Some(value) => {
            let mut response = Json(value).into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=300"),
            );
            headers.insert(
                header::HeaderName::from_static("x-content-type-options"),
                HeaderValue::from_static("nosniff"),
            );
            response
        }
        None => route_not_found().into_response(),
    }
}
