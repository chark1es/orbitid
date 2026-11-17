//! Cookie helpers. Attribute order and casing match `hono/cookie`, so the
//! `Set-Cookie` lines on the wire stay identical.

use axum::http::{header, HeaderMap, HeaderValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    Lax,
    Strict,
    None,
}

impl SameSite {
    fn as_str(self) -> &'static str {
        match self {
            SameSite::Lax => "Lax",
            SameSite::Strict => "Strict",
            SameSite::None => "None",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CookieOptions {
    pub path: String,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: SameSite,
    pub max_age: Option<i64>,
    pub domain: Option<String>,
}

impl CookieOptions {
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            http_only: true,
            secure: false,
            same_site: SameSite::Lax,
            max_age: None,
            domain: None,
        }
    }
}

/// Reads a cookie value from the request. Returns raw (undecoded) values, like
/// the opaque tokens this server issues.
pub fn get_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((key, value)) = part.split_once('=') {
            if key == name {
                return Some(value);
            }
        }
    }
    None
}

/// Builds a `Set-Cookie` header value. Attribute order matches Hono's
/// `serialize` (Max-Age, Domain, Path, HttpOnly, Secure, SameSite), so the
/// wire bytes are identical to the TypeScript server.
pub fn set_cookie(name: &str, value: &str, options: &CookieOptions) -> String {
    let mut out = format!("{name}={value}");
    if let Some(max_age) = options.max_age {
        out.push_str(&format!("; Max-Age={max_age}"));
    }
    if let Some(domain) = &options.domain {
        out.push_str(&format!("; Domain={domain}"));
    }
    if !options.path.is_empty() {
        out.push_str(&format!("; Path={}", options.path));
    }
    if options.http_only {
        out.push_str("; HttpOnly");
    }
    if options.secure {
        out.push_str("; Secure");
    }
    out.push_str(&format!("; SameSite={}", options.same_site.as_str()));
    out
}

/// A `Set-Cookie` that removes the cookie, matching Hono's
/// `deleteCookie(c, name, { path })`: empty value, `Max-Age=0`, then `Path`,
/// and no other attributes. `_secure` is accepted so existing callers keep the
/// request-security decision in one place.
pub fn clear_cookie(name: &str, path: &str, _secure: bool) -> String {
    format!("{name}=; Max-Age=0; Path={path}")
}

pub fn append_cookie(headers: &mut HeaderMap, value: String) {
    if let Ok(header) = HeaderValue::from_str(&value) {
        headers.append(header::SET_COOKIE, header);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; __client=abc=def; empty="),
        );
        assert_eq!(get_cookie(&headers, "a"), Some("1"));
        assert_eq!(get_cookie(&headers, "__client"), Some("abc=def"));
        assert_eq!(get_cookie(&headers, "empty"), Some(""));
        assert_eq!(get_cookie(&headers, "missing"), None);
    }

    #[test]
    fn formats_attributes() {
        let options = CookieOptions {
            path: "/".into(),
            http_only: true,
            secure: false,
            same_site: SameSite::Lax,
            max_age: Some(60),
            domain: None,
        };
        assert_eq!(
            set_cookie("__client", "v", &options),
            "__client=v; Max-Age=60; Path=/; HttpOnly; SameSite=Lax"
        );
        assert_eq!(
            clear_cookie("__client", "/", false),
            "__client=; Max-Age=0; Path=/"
        );
    }
}
