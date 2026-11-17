//! Response hardening, CSRF, CORS and upload caps, ported from
//! the retired TypeScript server and `createApp` in `app.ts`.

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::crypto::random_token;
use crate::error::{error_codes, OrbitError};
use crate::http::cookies::get_cookie;
use crate::http::json::MAX_UPLOAD_BYTES;
use crate::keys::cookies::CLIENT;
use crate::state::AppState;

const HSTS: &str = "max-age=31536000; includeSubDomains";
const PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

/// Extra origins the dashboard may call (`connect-src`).
pub fn dashboard_connect_sources() -> Vec<String> {
    std::env::var("ORBITID_DASHBOARD_CONNECT_SRC")
        .unwrap_or_default()
        .split([' ', ',', '\t', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| {
            if *value == "'self'" {
                return true;
            }
            match url::Url::parse(value) {
                Ok(url) => {
                    matches!(url.scheme(), "http" | "https")
                        && url.host().is_some()
                        && (url.path().is_empty() || url.path() == "/")
                        && url.query().is_none()
                        && url.fragment().is_none()
                }
                Err(_) => false,
            }
        })
        .map(str::to_string)
        .collect()
}

/// Content-Security-Policy for dashboard HTML (inline scripts only via nonce).
pub fn dashboard_csp(nonce: &str) -> String {
    let connect = std::iter::once("'self'".to_string())
        .chain(dashboard_connect_sources())
        .collect::<Vec<_>>()
        .join(" ");
    [
        "default-src 'self'".to_string(),
        format!("script-src 'self' 'nonce-{nonce}'"),
        "style-src 'self' 'unsafe-inline'".to_string(),
        "img-src 'self' data: https:".to_string(),
        "font-src 'self' data:".to_string(),
        format!("connect-src {connect}"),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'self'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

/// A fresh CSP nonce for one HTML response.
pub fn csp_nonce() -> String {
    random_token(18)
}

fn set_if_absent(headers: &mut HeaderMap, name: header::HeaderName, value: &'static str) {
    if !headers.contains_key(&name) {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

/// Baseline response headers for every response.
pub async fn security_headers(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    set_if_absent(
        headers,
        header::HeaderName::from_static("x-content-type-options"),
        "nosniff",
    );
    set_if_absent(
        headers,
        header::HeaderName::from_static("referrer-policy"),
        "no-referrer",
    );
    set_if_absent(
        headers,
        header::HeaderName::from_static("x-frame-options"),
        "DENY",
    );
    set_if_absent(
        headers,
        header::HeaderName::from_static("permissions-policy"),
        PERMISSIONS_POLICY,
    );
    if state.env.base_url.starts_with("https://") {
        set_if_absent(
            headers,
            header::HeaderName::from_static("strict-transport-security"),
            HSTS,
        );
    }
    let is_html = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/html"));
    if is_html && !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            ),
        );
    }
    let cacheable =
        path == "/oauth/jwks" || path == "/oauth/device.js" || path == "/oauth/device.css";
    if (path.starts_with("/v1/") || (path.starts_with("/oauth/") && !cacheable))
        && !headers.contains_key(header::CACHE_CONTROL)
    {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

fn origin_of(value: &str) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    Some(url.origin().ascii_serialization())
}

fn is_local_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if !(url.path().is_empty() || url.path() == "/") || url.query().is_some() {
        return false;
    }
    matches!(
        url.host_str().unwrap_or(""),
        "localhost" | "127.0.0.1" | "[::1]" | "::1"
    )
}

/// Origins a browser request may legitimately come from.
pub fn request_origin_allowed(state: &AppState, origin: &str) -> bool {
    let settings = state.settings.get();
    let app = &settings.application;
    let mut allowed = std::collections::HashSet::new();
    for value in &app.allowed_origins {
        if let Some(normalized) = origin_of(value) {
            allowed.insert(normalized);
        }
    }
    if let Some(home) = origin_of(&app.home_url) {
        allowed.insert(home);
    }
    if let Some(base) = origin_of(&state.env.base_url) {
        allowed.insert(base);
    }
    if app.development_mode && is_local_origin(origin) {
        return true;
    }
    allowed.contains(origin)
}

/// CORS: the Frontend API is called with credentials, so only configured origins.
///
/// `Vary: Origin` is appended to every response that passes through this layer,
/// including requests without an `Origin` header: Hono's `cors` does that
/// unconditionally for a function `origin` (and for every preflight when the
/// origin is not `*`), so a shared cache can never reuse one origin's response
/// for another.
pub async fn cors(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let allowed = origin.as_deref().is_some_and(|origin| {
        let settings = state.settings.get();
        let app = &settings.application;
        app.allowed_origins.iter().any(|value| value == origin)
            || (app.development_mode && is_local_origin(origin))
    });

    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        append_vary_origin(response.headers_mut());
        if let (true, Some(origin)) = (allowed, origin.as_deref()) {
            add_cors_headers(response.headers_mut(), origin);
        }
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                "Content-Type, Authorization, X-OrbitID-Client, X-Requested-With",
            ),
        );
        headers.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        return response;
    }

    let mut response = next.run(request).await;
    append_vary_origin(response.headers_mut());
    if let (true, Some(origin)) = (allowed, origin.as_deref()) {
        add_cors_headers(response.headers_mut(), origin);
    }
    response
}

fn append_vary_origin(headers: &mut HeaderMap) {
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
}

fn add_cors_headers(headers: &mut HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
}

fn is_state_changing(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

/// CSRF guard for the cookie-authenticated Frontend API.
pub async fn csrf_protection(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, OrbitError> {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    if !is_state_changing(&method)
        || (!path.starts_with("/v1/client") && path != "/oauth/consent")
        || get_cookie(request.headers(), CLIENT).is_none()
    {
        return Ok(next.run(request).await);
    }

    let headers = request.headers();
    let fetch_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin.is_some_and(|value| value.trim().eq_ignore_ascii_case("null")) {
        return Err(blocked(None));
    }
    let candidate = match origin {
        Some(origin) => origin_of(origin),
        None => headers
            .get(header::REFERER)
            .and_then(|value| value.to_str().ok())
            .and_then(origin_of),
    };
    if let Some(candidate) = &candidate {
        if request_origin_allowed(&state, candidate) {
            return Ok(next.run(request).await);
        }
    }
    if candidate.is_none() && fetch_site != "cross-site" {
        return Ok(next.run(request).await);
    }
    Err(blocked(candidate))
}

fn blocked(origin: Option<String>) -> OrbitError {
    OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        "Cross-site request blocked. Start the request from this application's origin.",
    )
    .with_meta(json!({ "origin": origin }))
}

/// Console/log-safe value: control characters are escaped.
pub fn log_safe(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control() || matches!(character, '\u{2028}' | '\u{2029}') {
            out.push_str(&format!("\\x{:02x}", character as u32));
        } else {
            out.push(character);
        }
    }
    out
}

/// Whether a path is an image upload route (5 MiB cap, and never replayed by
/// the request-level retry layer because its body streams).
pub fn is_upload_path(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "profile_image" || segment == "logo")
}

fn describe_cap(cap: usize) -> String {
    if cap >= 1024 * 1024 {
        format!("{} MB", cap / 1024 / 1024)
    } else {
        format!("{} KB", cap / 1024)
    }
}

/// Request body cap, enforced before any route parses a body. Image uploads get
/// 5 MB, everything else 1 MB; a declared `Content-Length` over the cap is
/// refused up front and `DefaultBodyLimit` caps streamed bodies.
pub async fn upload_size_limit(
    State(_state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(request).await;
    }
    let cap = if is_upload_path(request.uri().path()) {
        MAX_UPLOAD_BYTES
    } else {
        MAX_UPLOAD_BYTES.min(1024 * 1024)
    };
    if let Some(declared) = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if declared > cap {
            return OrbitError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                error_codes::REQUEST_BODY_INVALID,
                format!("Request body must be smaller than {}", describe_cap(cap)),
            )
            .into_response();
        }
    }
    request.extensions_mut().insert(DefaultBodyLimit::max(cap));
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_origins() {
        assert!(is_local_origin("http://localhost:5173"));
        assert!(is_local_origin("https://127.0.0.1"));
        assert!(is_local_origin("http://[::1]:4000"));
        assert!(!is_local_origin("https://evil.example"));
        assert!(!is_local_origin("http://localhost.evil.example"));
    }

    #[test]
    fn log_safe_escapes_control_characters() {
        assert_eq!(log_safe("a\nb\r\tc"), "a\\x0ab\\x0d\\x09c");
        assert_eq!(log_safe("plain"), "plain");
    }

    #[test]
    fn csp_contains_the_nonce() {
        let csp = dashboard_csp("abc");
        assert!(csp.contains("script-src 'self' 'nonce-abc'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(csp.contains("connect-src 'self'"));
    }
}
