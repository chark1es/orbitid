//! Small HTTP helpers the OIDC surface needs on top of `orbitid_core::http`:
//! URL building, redirects, HTML responses, HTML escaping and form decoding.
//!
//! Ported from `modules/oidc/shared.ts` (`urlWith`, `authorizeResponse`) and
//! `lib/html.ts`.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use url::Url;

/// Appends every non-null, non-empty parameter, exactly like `urlWith`.
pub fn url_with(base: &str, params: &[(&str, Option<&str>)]) -> String {
    let Ok(mut url) = Url::parse(base) else {
        return base.to_string();
    };
    for (key, value) in params {
        if let Some(value) = value {
            if !value.is_empty() {
                url.query_pairs_mut().append_pair(key, value);
            }
        }
    }
    url.to_string()
}

/// A 302 redirect (`c.redirect`).
pub fn redirect(location: &str) -> Response {
    match HeaderValue::from_str(location) {
        Ok(value) => {
            let mut response = StatusCode::FOUND.into_response();
            response.headers_mut().insert(header::LOCATION, value);
            response
        }
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

/// `c.html(html, status, headers)`.
pub fn html_response(html: String, status: StatusCode, headers: &[(&str, &str)]) -> Response {
    let mut response = (status, html).into_response();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            name.parse::<header::HeaderName>(),
            HeaderValue::from_str(value),
        ) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

/// Empty body with a status (`c.body(null, 200)`).
pub fn empty_response(status: StatusCode) -> Response {
    status.into_response()
}

/// HTML escaping, ported from `lib/html.ts` (identical output to the TS helper).
pub fn escape_html(value: &str) -> String {
    orbitid_core::http::html::escape_html(value)
}

/// `decodeURIComponent`, returning the input unchanged when it is malformed.
pub fn form_decode(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}

/// Parses a query string into first-wins pairs (`c.req.query()`).
pub fn query_map(query: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Some(query) = query {
        // Hono's `query()` lets the last duplicate win.
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            map.insert(key.into_owned(), value.into_owned());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_with_skips_empty_values() {
        assert_eq!(
            url_with(
                "http://x/cb",
                &[("code", Some("abc")), ("state", None), ("e", Some(""))]
            ),
            "http://x/cb?code=abc"
        );
    }

    #[test]
    fn form_decode_keeps_plus_and_handles_percent() {
        assert_eq!(form_decode("a%20b"), "a b");
        assert_eq!(form_decode("a+b"), "a+b");
        assert_eq!(form_decode("%zz"), "%zz");
    }

    #[test]
    fn query_map_last_wins() {
        let map = query_map(Some("a=1&a=2&b=x"));
        assert_eq!(map.get("a").map(String::as_str), Some("2"));
        assert_eq!(map.get("b").map(String::as_str), Some("x"));
    }
}
