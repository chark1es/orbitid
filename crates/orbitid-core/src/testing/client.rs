#[cfg(test)]
use super::db::database_url;
use crate::error::ApiErrorItem;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::Router;
use bytes::Bytes;
use http_body_util::BodyExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tower::ServiceExt;

#[derive(Debug, Clone)]
pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json<T: DeserializeOwned>(&self) -> T {
        match serde_json::from_slice(&self.body) {
            Ok(value) => value,
            Err(error) => panic!(
                "response {} is not JSON ({error}): {}",
                self.status,
                self.text()
            ),
        }
    }

    pub fn value(&self) -> Value {
        self.json()
    }

    pub fn error_codes(&self) -> Vec<String> {
        errors_of(&self.value())
            .into_iter()
            .map(|item| item.code)
            .collect()
    }
}

/// Runtime guard for the API error wire format.
pub fn errors_of(body: &Value) -> Vec<ApiErrorItem> {
    body.get("errors")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// In-process client that persists cookies set by the router.
#[derive(Clone)]
pub struct TestClient {
    router: Router,
    jar: Arc<Mutex<BTreeMap<String, String>>>,
}

impl TestClient {
    pub fn new(router: Router) -> Self {
        Self {
            router,
            jar: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    pub fn with_cookie(router: Router, cookie: &str) -> Self {
        let client = Self::new(router);
        if let Ok(mut jar) = client.jar.lock() {
            for part in cookie.split(';') {
                if let Some((name, value)) = part.trim().split_once('=') {
                    jar.insert(name.to_string(), value.to_string());
                }
            }
        }
        client
    }

    pub fn cookie_header(&self) -> Option<String> {
        let jar = self.jar.lock().ok()?;
        if jar.is_empty() {
            return None;
        }
        Some(
            jar.iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        let mut builder = Request::builder()
            .method(
                Method::from_bytes(method.to_ascii_uppercase().as_bytes()).unwrap_or(Method::GET),
            )
            .uri(path);
        let mut map = HeaderMap::new();
        for (name, value) in headers {
            if let (Ok(name), Ok(value)) = (
                name.parse::<header::HeaderName>(),
                HeaderValue::from_str(value),
            ) {
                map.insert(name, value);
            }
        }
        if !map.contains_key(header::COOKIE) {
            if let Some(cookie) = self.cookie_header() {
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    map.insert(header::COOKIE, value);
                }
            }
        }
        let bytes = match body {
            Some(value) => {
                if !map.contains_key(header::CONTENT_TYPE) {
                    map.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/json"),
                    );
                }
                serde_json::to_vec(&value).unwrap_or_default()
            }
            None => Vec::new(),
        };
        for (name, value) in &map {
            builder = builder.header(name, value);
        }
        let request = builder
            .body(Body::from(bytes))
            .expect("test request is well-formed");
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("router is infallible");
        let status = response.status();
        let headers = response.headers().clone();
        for line in headers.get_all(header::SET_COOKIE) {
            if let Ok(line) = line.to_str() {
                self.store_cookie(line);
            }
        }
        let body = response
            .into_body()
            .collect()
            .await
            .expect("response body can be read")
            .to_bytes();
        TestResponse {
            status,
            headers,
            body,
        }
    }

    fn store_cookie(&self, line: &str) {
        let mut parts = line.split(';');
        let Some(pair) = parts.next() else {
            return;
        };
        let Some((name, value)) = pair.split_once('=') else {
            return;
        };
        let expired = value.is_empty()
            || parts.clone().any(|attribute| {
                attribute
                    .trim()
                    .to_ascii_lowercase()
                    .starts_with("max-age=0")
            });
        if let Ok(mut jar) = self.jar.lock() {
            if expired {
                jar.remove(name);
            } else {
                jar.insert(name.to_string(), value.to_string());
            }
        }
    }

    pub async fn get(&self, path: &str, headers: &[(&str, &str)]) -> TestResponse {
        self.request("GET", path, None, headers).await
    }

    pub async fn post(
        &self,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        self.request("POST", path, body, headers).await
    }

    pub async fn patch(
        &self,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        self.request("PATCH", path, body, headers).await
    }

    pub async fn delete(
        &self,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        self.request("DELETE", path, body, headers).await
    }

    /// Request and parse JSON, panicking on a non-JSON response like the TS helper.
    pub async fn json<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> T {
        self.request(method, path, body, headers).await.json()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_guard_parses_the_wire_format() {
        let body = serde_json::json!({
            "errors": [{ "code": "secret_key_invalid", "message": "Invalid secret key" }],
            "trace_id": "abc"
        });
        let errors = errors_of(&body);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].code, "secret_key_invalid");
        assert!(errors_of(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn database_urls_are_derived() {
        assert_eq!(
            database_url("postgres://orbit:orbit@localhost:5432/postgres", "t_abc"),
            "postgres://orbit:orbit@localhost:5432/t_abc"
        );
    }
}
