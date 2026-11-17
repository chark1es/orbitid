//! Small HTTP helpers shared by the auth routes: safe redirect validation,
//! query appending, and the response builder that carries `Set-Cookie` lines.
//!
//! Ported from `modules/auth/redirects.ts` and the cookie plumbing the Hono
//! handlers relied on.

use std::collections::HashMap;

use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

/// A safe dev-only origin (`localhost`, `127.0.0.1`).
pub fn is_dev_localhost(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.username().is_empty()
        && url.password().is_none()
}

/// `new URL(value).origin`, or `None` for an unparseable value.
pub fn safe_origin(value: &str) -> Option<String> {
    url::Url::parse(value)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

fn home_url(state: &AppState) -> String {
    let settings = state.settings.get();
    if settings.application.home_url.is_empty() {
        state.env.base_url.clone()
    } else {
        settings.application.home_url.clone()
    }
}

/// Validates a post-auth redirect (`form_param_format_invalid`, 422), returning
/// the normalized absolute URL.
pub fn validate_redirect_url(
    state: &AppState,
    value: Option<&str>,
    param: &str,
) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let raw = value.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let base = home_url(state);
    let url = match url::Url::parse(raw).or_else(|_| url::Url::parse(&base)?.join(raw)) {
        Ok(url) => url,
        Err(_) => {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                format!("{param} is not a valid URL"),
            )
            .with_meta(serde_json::json!({ "param_name": param })))
        }
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
    let mut allowed: Vec<String> = Vec::new();
    for origin in app
        .allowed_origins
        .iter()
        .chain(app.allowed_redirect_origins.iter())
    {
        if let Some(origin) = safe_origin(origin) {
            allowed.push(origin);
        }
    }
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

/// `withQuery`: appends/replaces query parameters on an absolute URL.
pub fn with_query(input: &str, params: &[(&str, Option<&str>)]) -> String {
    let Ok(mut url) = url::Url::parse(input) else {
        return input.to_string();
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    for (key, value) in params {
        if let Some(value) = value {
            // `searchParams.set` replaces; `Url::query_pairs_mut` appends.
            pairs.retain(|(existing, _)| existing != key);
            pairs.push(((*key).to_string(), (*value).to_string()));
        }
    }
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in pairs {
            serializer.append_pair(&key, &value);
        }
        url.set_query(Some(&serializer.finish()));
    }
    url.to_string()
}

/// Normalized query map (last value wins, like Hono's `c.req.query()`).
pub fn query_map(query: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(query) = query {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            out.insert(key.into_owned(), value.into_owned());
        }
    }
    out
}

/// Keeps exactly one `Set-Cookie` per (name, path, domain), the last one.
/// Sign-in and sign-up flows can legitimately mint a bootstrap client cookie
/// and then rotate it while completing the attempt; sending both made the
/// browser store whichever header came last and left the first client row
/// unused. Cookies with the same name but a different path or domain are
/// distinct and must both survive.
fn cookie_scope(cookie: &str) -> (String, String, Option<String>) {
    let mut parts = cookie.split(';');
    let name = parts
        .next()
        .unwrap_or(cookie)
        .split('=')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut path = "/".to_string();
    let mut domain = None;
    for attribute in parts {
        let Some((key, value)) = attribute.trim().split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "path" => path = value.trim().to_string(),
            "domain" => domain = Some(value.trim().to_ascii_lowercase()),
            _ => {}
        }
    }
    (name, path, domain)
}

fn dedupe_cookies(cookies: Vec<String>) -> Vec<String> {
    let mut order: HashMap<(String, String, Option<String>), usize> = HashMap::new();
    let mut out: Vec<String> = Vec::new();
    for cookie in cookies {
        let key = cookie_scope(&cookie);
        match order.get(&key) {
            Some(index) => out[*index] = cookie,
            None => {
                order.insert(key, out.len());
                out.push(cookie);
            }
        }
    }
    out
}

impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        self.finish()
    }
}

/// A JSON or redirect response with `Set-Cookie` and extra headers.
pub struct Reply {
    status: StatusCode,
    body: Option<serde_json::Value>,
    text: Option<(String, String)>,
    cookies: Vec<String>,
    headers: Vec<(String, String)>,
}

impl Reply {
    pub fn json(value: serde_json::Value) -> Self {
        Self {
            status: StatusCode::OK,
            body: Some(value),
            text: None,
            cookies: Vec::new(),
            headers: Vec::new(),
        }
    }

    /// A non-JSON document (SAML metadata).
    pub fn text(body: impl Into<String>, content_type: impl Into<String>) -> Self {
        Self {
            status: StatusCode::OK,
            body: None,
            text: Some((body.into(), content_type.into())),
            cookies: Vec::new(),
            headers: Vec::new(),
        }
    }

    /// 302 with `Location`, exactly like Hono's `c.redirect(url, 302)`.
    pub fn redirect(location: String) -> Self {
        Self {
            status: StatusCode::FOUND,
            body: None,
            text: None,
            cookies: Vec::new(),
            headers: vec![(header::LOCATION.as_str().to_string(), location)],
        }
    }

    pub fn status(mut self, status: StatusCode) -> Self {
        self.status = status;
        self
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub fn cookie(mut self, cookie: Option<String>) -> Self {
        if let Some(cookie) = cookie {
            self.cookies.push(cookie);
        }
        self
    }

    pub fn cookies(mut self, cookies: Vec<String>) -> Self {
        self.cookies.extend(cookies);
        self
    }

    pub fn finish(self) -> Response {
        let mut response = match (self.body, self.text) {
            (Some(body), _) => (self.status, axum::Json(body)).into_response(),
            (None, Some((body, content_type))) => {
                let mut response = (self.status, body).into_response();
                if let Ok(value) = HeaderValue::from_str(&content_type) {
                    response.headers_mut().insert(header::CONTENT_TYPE, value);
                }
                response
            }
            (None, None) => self.status.into_response(),
        };
        let headers = response.headers_mut();
        for cookie in dedupe_cookies(self.cookies) {
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                headers.append(header::SET_COOKIE, value);
            }
        }
        for (name, value) in self.headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(&value),
            ) {
                headers.append(name, value);
            }
        }
        response
    }
}

/// The browser-binding cookie for an OAuth/SSO flow (`__orbit_oauth`).
pub fn oauth_browser_cookie(state: &AppState, headers: &HeaderMap, nonce: &str) -> String {
    use orbitid_core::http::cookies::{set_cookie, CookieOptions, SameSite};
    let secure = state.env.base_url.starts_with("https://")
        || orbitid_core::http::request_is_secure(
            headers,
            &state.env.base_url,
            state.env.trust_proxy,
        );
    set_cookie(
        orbitid_federation::BROWSER_COOKIE,
        nonce,
        &CookieOptions {
            path: orbitid_federation::BROWSER_COOKIE_PATH.into(),
            http_only: true,
            secure,
            same_site: if secure {
                SameSite::None
            } else {
                SameSite::Lax
            },
            max_age: Some(orbitid_federation::BROWSER_COOKIE_TTL_SECONDS),
            domain: None,
        },
    )
}

/// `deleteCookie(c, "__orbit_oauth", { path: "/v1" })`: the binding cookie is
/// single-use, so a completed (or refused) callback removes it.
pub fn clear_oauth_browser_cookie() -> String {
    orbitid_core::http::cookies::clear_cookie(
        orbitid_federation::BROWSER_COOKIE,
        orbitid_federation::BROWSER_COOKIE_PATH,
        false,
    )
}

/// Best-effort header string.
pub fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// `clientIp(c)` with the instance's trust-proxy configuration.
pub fn client_ip(state: &AppState, headers: &HeaderMap) -> String {
    orbitid_core::http::client_ip(headers, None, state.env.trust_proxy)
}

/// Rate-limit hit (`429` with `Retry-After` through `OrbitError`).
pub async fn hit(state: &AppState, key: &str, max: i64, window_ms: i64) -> Result<()> {
    orbitid_core::http::rate_limit::hit(state, key, max, window_ms).await
}

/// Trims and bounds a request field the way the zod `shortText` schemas did.
pub fn bounded(value: Option<String>, max: usize, param: &str) -> Result<Option<String>> {
    match value {
        Some(value) if value.chars().count() > max => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must contain at most {max} character(s)"),
        )
        .with_meta(serde_json::json!({ "param_name": param }))),
        other => Ok(other),
    }
}

/// `nullish` text: `json!(null)` becomes `None`, strings are bounded.
pub fn nullable_bounded(
    value: Option<serde_json::Value>,
    max: usize,
    param: &str,
) -> Result<Option<Option<String>>> {
    let Some(value) = value else { return Ok(None) };
    match value {
        serde_json::Value::Null => Ok(Some(None)),
        serde_json::Value::String(text) => {
            let bounded = bounded(Some(text), max, param)?;
            Ok(Some(bounded))
        }
        _ => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must be a string"),
        )
        .with_meta(serde_json::json!({ "param_name": param }))),
    }
}

#[cfg(test)]
mod tests {
    use super::dedupe_cookies;

    #[test]
    fn only_the_last_cookie_for_a_scope_is_kept() {
        let cookies = vec![
            "__client=first; Path=/".to_string(),
            "__orbit_oauth=n; Path=/v1".to_string(),
            "__client=second; Path=/".to_string(),
            // Same name, different path/domain: a distinct cookie, not a
            // replacement.
            "__client=scoped; Path=/v1".to_string(),
            "__client=other-domain; Path=/; Domain=example.com".to_string(),
        ];
        assert_eq!(
            dedupe_cookies(cookies),
            vec![
                "__client=second; Path=/".to_string(),
                "__orbit_oauth=n; Path=/v1".to_string(),
                "__client=scoped; Path=/v1".to_string(),
                "__client=other-domain; Path=/; Domain=example.com".to_string(),
            ]
        );
    }
}
