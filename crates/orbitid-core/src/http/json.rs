//! JSON/form body extraction with OrbitID's error shapes, ported from
//! the retired TypeScript server.
//!
//! `OrbitJson<T>` accepts `application/json` and
//! `application/x-www-form-urlencoded`, rejects bodies over 1 MB, refuses
//! documents nested deeper than 32 levels, strips prototype-polluting keys and
//! turns deserialization failures into 422 `form_param_*` errors.

use axum::body::to_bytes;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::{header, request::Parts, HeaderMap};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::error::{error_codes, OrbitError};

/// JSON bodies are capped at 1 MB and multipart/form uploads at 5 MB.
pub const MAX_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
/// Deeper documents are refused: they only exist to exhaust the stack.
pub const MAX_JSON_DEPTH: usize = 32;

const PROTOTYPE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn describe_bytes(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", (bytes as f64 / 1024.0 / 1024.0).round() as i64)
    } else {
        format!("{} KB", (bytes as f64 / 1024.0).round() as i64)
    }
}

fn too_large(max_bytes: usize) -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::PAYLOAD_TOO_LARGE,
        error_codes::REQUEST_BODY_INVALID,
        format!(
            "Request body must be smaller than {}",
            describe_bytes(max_bytes)
        ),
    )
}

/// Reads a body with a hard byte cap; reading stops as soon as the cap is crossed.
pub async fn read_body_capped(
    body: axum::body::Body,
    max_bytes: usize,
) -> Result<Vec<u8>, OrbitError> {
    match to_bytes(body, max_bytes).await {
        Ok(bytes) => Ok(bytes.to_vec()),
        Err(_) => Err(too_large(max_bytes)),
    }
}

/// Removes `__proto__` / `constructor` / `prototype` keys at every level.
pub fn strip_prototype_keys(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(strip_prototype_keys).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if PROTOTYPE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                out.insert(key, strip_prototype_keys(item));
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Throws `request_body_invalid` when the document nests deeper than `max`.
pub fn assert_json_depth(value: &Value, max: usize) -> Result<(), OrbitError> {
    let mut stack = vec![(value, 0usize)];
    while let Some((current, depth)) = stack.pop() {
        match current {
            Value::Array(items) => {
                if depth >= max {
                    return Err(OrbitError::bad_request(
                        error_codes::REQUEST_BODY_INVALID,
                        "Request body is nested too deeply",
                    ));
                }
                for item in items {
                    stack.push((item, depth + 1));
                }
            }
            Value::Object(map) => {
                if depth >= max {
                    return Err(OrbitError::bad_request(
                        error_codes::REQUEST_BODY_INVALID,
                        "Request body is nested too deeply",
                    ));
                }
                for item in map.values() {
                    stack.push((item, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn deserialize_typed<T: DeserializeOwned>(raw: Value) -> Result<T, OrbitError> {
    let raw = if raw.is_null() {
        Value::Object(Map::new())
    } else {
        raw
    };
    match serde_path_to_error::deserialize::<_, T>(raw) {
        Ok(value) => Ok(value),
        Err(error) => {
            let path = error.path().to_string();
            let inner = error.inner().to_string();
            let (code, param, message) = if let Some(field) = inner
                .strip_prefix("missing field `")
                .and_then(|rest| rest.split('`').next())
            {
                let param = if path.is_empty() || path == "." {
                    field.to_string()
                } else {
                    format!("{path}.{field}")
                };
                (
                    error_codes::FORM_PARAM_MISSING,
                    param.clone(),
                    format!("{param} is missing"),
                )
            } else {
                let param = if path.is_empty() || path == "." {
                    "body".to_string()
                } else {
                    path
                };
                (
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    param.clone(),
                    format!("{param}: {inner}"),
                )
            };
            Err(OrbitError::unprocessable(code, message)
                .with_meta(serde_json::json!({ "param_name": param })))
        }
    }
}

/// A JSON (or form-urlencoded) body, already validated and prototype-stripped.
#[derive(Debug, Clone)]
pub struct OrbitJson<T>(pub T);

impl<T> OrbitJson<T> {
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T, S> FromRequest<S> for OrbitJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = OrbitError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        let (parts, body) = request.into_parts();
        let raw = parse_request_body(&parts.headers, body, MAX_JSON_BYTES).await?;
        let value = strip_prototype_keys(raw);
        assert_json_depth(&value, MAX_JSON_DEPTH)?;
        deserialize_typed(value).map(OrbitJson)
    }
}

/// Parses a body the way `parseBody` does. Public so routes with a custom schema
/// can share exactly the same behaviour.
pub async fn parse_request_body(
    headers: &HeaderMap,
    body: axum::body::Body,
    max_bytes: usize,
) -> Result<Value, OrbitError> {
    if let Some(declared) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
    {
        if declared > max_bytes {
            return Err(too_large(max_bytes));
        }
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = read_body_capped(body, max_bytes).await?;

    if content_type.contains("application/json") {
        let text = String::from_utf8_lossy(&bytes);
        if text.trim().is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        return serde_json::from_str(text.trim()).map_err(|_| {
            OrbitError::bad_request(
                error_codes::REQUEST_BODY_INVALID,
                "Request body is not valid",
            )
        });
    }
    if content_type.contains("application/x-www-form-urlencoded") {
        let mut map = Map::new();
        for (key, value) in url::form_urlencoded::parse(&bytes) {
            map.insert(key.into_owned(), Value::String(value.into_owned()));
        }
        return Ok(Value::Object(map));
    }
    if content_type.contains("form") {
        // Multipart parsing belongs to the upload routes (a later wave); this
        // extractor refuses it rather than silently treating it as JSON.
        return Err(OrbitError::new(
            axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
            error_codes::REQUEST_BODY_INVALID,
            "Content-Type must be application/json or application/x-www-form-urlencoded",
        ));
    }
    if bytes.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    Err(OrbitError::new(
        axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
        error_codes::REQUEST_BODY_INVALID,
        "Content-Type must be application/json or application/x-www-form-urlencoded",
    ))
}

/// Validated list pagination (`limit` 1..=500, `offset` >= 0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaginationQuery {
    pub limit: i64,
    pub offset: i64,
    pub order_by: Option<String>,
}

pub fn pagination_query(query: Option<&str>) -> Result<PaginationQuery, OrbitError> {
    let mut limit = None;
    let mut offset = None;
    let mut order_by = None;
    if let Some(query) = query {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            match key.as_ref() {
                "limit" => limit = Some(value.into_owned()),
                "offset" => offset = Some(value.into_owned()),
                "order_by" => order_by = Some(value.into_owned()),
                _ => {}
            }
        }
    }
    let parse = |raw: Option<String>, name: &str, default: i64| match raw {
        None => Ok(default),
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                format!("{name}: expected an integer"),
            )
            .with_meta(serde_json::json!({ "param_name": name }))
        }),
    };
    let limit = parse(limit, "limit", 10)?;
    let offset = parse(offset, "offset", 0)?;
    if !(1..=500).contains(&limit) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "limit must be between 1 and 500",
        )
        .with_meta(serde_json::json!({ "param_name": "limit" })));
    }
    if offset < 0 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "offset must be 0 or greater",
        )
        .with_meta(serde_json::json!({ "param_name": "offset" })));
    }
    Ok(PaginationQuery {
        limit,
        offset,
        order_by,
    })
}

impl<S> FromRequestParts<S> for PaginationQuery
where
    S: Send + Sync,
{
    type Rejection = OrbitError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        pagination_query(parts.uri.query())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_body(value: &str) -> axum::body::Body {
        axum::body::Body::from(value.to_string())
    }

    fn headers(content_type: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn empty_json_becomes_an_empty_object() {
        let value = parse_request_body(&headers("application/json"), json_body(""), MAX_JSON_BYTES)
            .await
            .unwrap();
        assert_eq!(value, Value::Object(Map::new()));
    }

    #[tokio::test]
    async fn malformed_json_is_a_400() {
        let error = parse_request_body(
            &headers("application/json"),
            json_body("{oops"),
            MAX_JSON_BYTES,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(error.code, error_codes::REQUEST_BODY_INVALID);
    }

    #[tokio::test]
    async fn declared_content_length_over_the_cap_is_refused_before_reading() {
        let mut headers = headers("application/json");
        headers.insert(
            header::CONTENT_LENGTH,
            (MAX_JSON_BYTES + 1).to_string().parse().unwrap(),
        );
        let error = parse_request_body(&headers, json_body("{}"), MAX_JSON_BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn deep_documents_are_refused() {
        let mut nested = Value::String("x".into());
        for _ in 0..60 {
            nested = serde_json::json!({ "n": nested });
        }
        let error = assert_json_depth(&nested, MAX_JSON_DEPTH).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(error.code, error_codes::REQUEST_BODY_INVALID);
    }

    #[test]
    fn prototype_keys_are_stripped_at_every_level() {
        let value: Value =
            serde_json::from_str(r#"{"a":1,"__proto__":{"x":1},"b":{"constructor":{"y":2}}}"#)
                .unwrap();
        let clean = strip_prototype_keys(value);
        assert_eq!(clean["a"], 1);
        assert!(clean.get("__proto__").is_none());
        assert!(clean["b"].get("constructor").is_none());
    }

    #[tokio::test]
    async fn urlencoded_bodies_parse() {
        let value = parse_request_body(
            &headers("application/x-www-form-urlencoded"),
            json_body("a=1&b=two"),
            MAX_JSON_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(value["a"], "1");
        assert_eq!(value["b"], "two");
    }

    #[tokio::test]
    async fn wrong_content_type_is_415() {
        let error = parse_request_body(&headers("text/plain"), json_body("a=1"), MAX_JSON_BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn pagination_validates() {
        let page = pagination_query(Some("limit=25&offset=5")).unwrap();
        assert_eq!((page.limit, page.offset), (25, 5));
        assert!(pagination_query(Some("limit=100000")).is_err());
        assert!(pagination_query(Some("offset=-1")).is_err());
        assert!(pagination_query(Some("limit=abc")).is_err());
    }
}
