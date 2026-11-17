//! HTTP plumbing shared by every layer: JSON extraction with OrbitID error
//! shapes, client IP resolution, cookies, security headers/CSRF/CORS, upload
//! caps, rate limiting, auth middleware and small helpers.

pub mod async_util;
pub mod auth_method;
pub mod client_ip;
pub mod cookies;
pub mod email_format;
pub mod html;
pub mod json;
pub mod middleware;
pub mod rate_limit;
pub mod replay;
pub mod reserved_claims;
pub mod security;

pub use client_ip::{client_ip, now, peer_addr, request_is_secure};
pub use cookies::{append_cookie, clear_cookie, get_cookie, set_cookie, CookieOptions, SameSite};
pub use json::{
    assert_json_depth, pagination_query, read_body_capped, strip_prototype_keys, OrbitJson,
    PaginationQuery, MAX_JSON_BYTES, MAX_JSON_DEPTH, MAX_UPLOAD_BYTES,
};
pub use middleware::{
    check_secret_key, error_logging, query_has_credential, request_logging, require_secret_key,
    OperatorSessionChecker,
};
pub use rate_limit::{assert_not_blocked, hit, rate_limit};
pub use security::{
    cors, csp_nonce, csrf_protection, dashboard_connect_sources, dashboard_csp, is_upload_path,
    log_safe, request_origin_allowed, security_headers, upload_size_limit,
};
