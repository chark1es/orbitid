//! Response helpers. The global error middleware is `orbitid-server`'s; here we
//! only build successful JSON responses and attach `Set-Cookie` lines that
//! services return (client-token creation/renewal).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use orbitid_core::http::append_cookie;
use serde_json::Value;

/// A JSON response with `Set-Cookie` lines from client-cookie helpers.
pub fn json_reply_with_status(status: StatusCode, value: Value, cookies: Vec<String>) -> Response {
    let mut response = (status, axum::Json(value)).into_response();
    for cookie in cookies {
        append_cookie(response.headers_mut(), cookie);
    }
    response
}

/// `200 OK` JSON with `Set-Cookie` lines.
pub fn json_reply(value: Value, cookies: Vec<String>) -> Response {
    json_reply_with_status(StatusCode::OK, value, cookies)
}
