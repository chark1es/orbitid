//! The JSON extractor's wire behaviour: content types, caps, depth and the
//! 422/400 error shapes callers rely on.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use serde::Deserialize;
use tower::ServiceExt;

use orbitid_core::http::json::{OrbitJson, MAX_JSON_BYTES};

#[derive(Debug, Deserialize)]
struct Payload {
    a: String,
}

async fn echo(OrbitJson(payload): OrbitJson<Payload>) -> String {
    payload.a
}

fn app() -> Router {
    Router::new().route("/", post(echo))
}

async fn send(
    body: Body,
    content_type: &str,
    content_length: Option<usize>,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/")
        .header(header::CONTENT_TYPE, content_type);
    if let Some(length) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, length);
    }
    let response = app().oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

#[tokio::test]
async fn valid_json_is_extracted() {
    let (status, _) = send(Body::from(r#"{"a":"ok"}"#), "application/json", None).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn malformed_json_is_request_body_invalid() {
    let (status, body) = send(Body::from("{oops"), "application/json", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errors"][0]["code"], "request_body_invalid");
}

#[tokio::test]
async fn missing_and_invalid_fields_are_422() {
    let (status, body) = send(Body::from("{}"), "application/json", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["errors"][0]["code"], "form_param_missing");
    assert_eq!(body["errors"][0]["meta"]["param_name"], "a");

    let (status, body) = send(Body::from(r#"{"a":1}"#), "application/json", None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["errors"][0]["code"], "form_param_format_invalid");
    assert_eq!(body["errors"][0]["meta"]["param_name"], "a");
}

#[tokio::test]
async fn bodies_over_the_cap_are_413() {
    let big = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_JSON_BYTES));
    let (status, body) = send(Body::from(big), "application/json", None).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["errors"][0]["code"], "request_body_invalid");
}

#[tokio::test]
async fn deeply_nested_documents_are_refused() {
    let mut nested = serde_json::json!("x");
    for _ in 0..60 {
        nested = serde_json::json!({ "n": nested });
    }
    let (status, body) = send(
        Body::from(serde_json::to_vec(&nested).unwrap()),
        "application/json",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errors"][0]["code"], "request_body_invalid");
}

#[tokio::test]
async fn wrong_content_type_is_415() {
    let (status, body) = send(Body::from("a=1"), "text/plain", None).await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(body["errors"][0]["code"], "request_body_invalid");
}

#[tokio::test]
async fn form_urlencoded_is_accepted() {
    let (status, _) = send(
        Body::from("a=hello"),
        "application/x-www-form-urlencoded",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
