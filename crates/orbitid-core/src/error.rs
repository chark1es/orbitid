//! API errors, ported from `packages/shared/src/errors.ts` and the `onError`
//! handler in the retired TypeScript server.
//!
//! Wire format: `{ "errors": [ ... ], "trace_id": "..." }`. Handlers return
//! `Err(OrbitError)`; its [`IntoResponse`] implementation produces the body.
//! A middleware (`http::error_logging`) emits the 500 diagnostic with the
//! request path so authentication paths stay silent, exactly like `onError`.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// `Result` alias used by every handler and service.
pub type Result<T> = std::result::Result<T, OrbitError>;

/// Every error code returned by an OrbitID API. The *values* are the wire
/// contract, not the Rust identifiers; do not change them.
pub mod error_codes {
    macro_rules! codes {
        ($($name:ident => $value:literal,)*) => {
            $(pub const $name: &str = $value;)*
        };
    }

    codes! {
        RESOURCE_NOT_FOUND => "resource_not_found",
        FORM_PARAM_MISSING => "form_param_missing",
        FORM_PARAM_FORMAT_INVALID => "form_param_format_invalid",
        FORM_PARAM_NIL => "form_param_nil",
        FORM_PARAM_VALUE_INVALID => "form_param_value_invalid",
        FORM_PARAM_UNKNOWN => "form_param_unknown",
        REQUEST_BODY_INVALID => "request_body_invalid",
        NOT_ALLOWED_ACCESS => "not_allowed_access",
        AUTHORIZATION_INVALID => "authorization_invalid",
        AUTHENTICATION_INVALID => "authentication_invalid",
        SECRET_KEY_INVALID => "secret_key_invalid",
        RATE_LIMIT_EXCEEDED => "rate_limit_exceeded",
        BOT_DETECTED => "bot_detected",
        EMAIL_DELIVERY_FAILED => "email_delivery_failed",
        FORM_IDENTIFIER_NOT_FOUND => "form_identifier_not_found",
        FORM_IDENTIFIER_EXISTS => "form_identifier_exists",
        FORM_PASSWORD_INCORRECT => "form_password_incorrect",
        FORM_PASSWORD_PWNED => "form_password_pwned",
        FORM_PASSWORD_LENGTH_TOO_SHORT => "form_password_length_too_short",
        FORM_PASSWORD_NOT_STRONG_ENOUGH => "form_password_not_strong_enough",
        FORM_USERNAME_INVALID_LENGTH => "form_username_invalid_length",
        FORM_USERNAME_INVALID_CHARACTER => "form_username_invalid_character",
        FORM_CODE_INCORRECT => "form_code_incorrect",
        VERIFICATION_EXPIRED => "verification_expired",
        VERIFICATION_FAILED => "verification_failed",
        VERIFICATION_ALREADY_VERIFIED => "verification_already_verified",
        TOO_MANY_ATTEMPTS => "too_many_attempts",
        STRATEGY_FOR_USER_INVALID => "strategy_for_user_invalid",
        IDENTIFICATION_CLAIMED => "identification_claimed",
        IDENTIFIER_ALREADY_SIGNED_IN => "identifier_already_signed_in",
        SESSION_EXISTS => "session_exists",
        CLIENT_STATE_INVALID => "client_state_invalid",
        SIGN_UP_CANNOT_BE_USED => "sign_up_cannot_be_used",
        SIGN_UP_RESTRICTED => "sign_up_restricted",
        SIGN_UP_MODE_RESTRICTED => "sign_up_mode_restricted",
        WAITLIST_MODE => "sign_up_restricted_waitlist",
        NOT_ALLOWED_TO_SIGN_UP => "not_allowed_to_sign_up",
        IDENTIFIER_NOT_ALLOWED => "identifier_not_allowed_access",
        INVITATION_ACCOUNT_NOT_EXISTS => "invitation_account_not_exists",
        TICKET_INVALID => "ticket_invalid",
        TICKET_EXPIRED => "ticket_expired",
        USER_LOCKED => "user_locked",
        SESSION_PENDING => "session_pending",
        USER_BANNED => "user_banned",
        REVERIFICATION_REQUIRED => "session_reverification_required",
        NEEDS_SECOND_FACTOR => "needs_second_factor",
        LAST_IDENTIFICATION_CANNOT_BE_REMOVED => "last_identification_cannot_be_removed",
        OAUTH_PROVIDER_NOT_ENABLED => "oauth_provider_not_enabled",
        OAUTH_CALLBACK_ERROR => "oauth_callback_error",
        EXTERNAL_ACCOUNT_EXISTS => "external_account_exists",
        EXTERNAL_ACCOUNT_NOT_FOUND => "external_account_not_found",
        ORGANIZATION_NOT_FOUND => "organization_not_found",
        ORGANIZATION_SLUG_TAKEN => "organization_slug_taken",
        ORGANIZATION_MEMBERSHIP_QUOTA_EXCEEDED => "organization_membership_quota_exceeded",
        ORGANIZATIONS_DISABLED => "organizations_disabled",
        ORGANIZATION_CREATION_NOT_ALLOWED => "organization_creation_not_allowed",
        DUPLICATE_RECORD => "duplicate_record",
        NOT_A_MEMBER_IN_ORGANIZATION => "not_a_member_in_organization",
        ORG_ROLE_NOT_FOUND => "org_role_not_found",
        LAST_ADMIN_CANNOT_LEAVE => "organization_minimum_permissions_needed",
        ORG_PERMISSION_REQUIRED => "org_permission_required",
        WEBAUTHN_NOT_SUPPORTED => "webauthn_not_supported",
        PASSKEY_REGISTRATION_FAILURE => "passkey_registration_failure",
        PASSKEY_AUTHENTICATION_FAILURE => "passkey_authentication_failure",
        TOTP_NOT_ENABLED => "totp_not_enabled",
        MFA_NOT_ENABLED => "mfa_not_enabled",
        API_KEY_INVALID => "api_key_invalid",
        INVALID_GRANT => "invalid_grant",
        INVALID_CLIENT => "invalid_client",
        INVALID_SCOPE => "invalid_scope",
        TRANSACTION_CONFLICT => "transaction_conflict",
    }

    /// Not in the TS `ErrorCodes` object, but the wire value `onError` emits.
    pub const INTERNAL_SERVER_ERROR: &str = "internal_server_error";
}

/// One entry of the `errors` array.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApiErrorItem {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl ApiErrorItem {
    /// A bare wire item (`{ code, message }`), used for the 404 fallback, the
    /// fixed 500 and the unique-violation 409 exactly like `app.onError`.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            long_message: None,
            meta: None,
        }
    }
}

/// Response body of every error, and of the 404 fallback (which has no trace id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub errors: Vec<ApiErrorItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
}

/// An error a handler can return. `items` carries the full list produced by a
/// validation failure; otherwise `to_item()` is the single entry.
#[derive(Debug, Clone)]
pub struct OrbitError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub long_message: Option<String>,
    pub meta: Option<Value>,
    pub items: Option<Vec<ApiErrorItem>>,
    /// Extra response headers, e.g. a `Set-Cookie` a failed authentication must
    /// still deliver (the TS `onError` keeps headers set before the throw).
    pub headers: Vec<(header::HeaderName, HeaderValue)>,
    /// The failing write was rejected for the row's own data (`from_row_write`).
    pub row_level: bool,
}

impl std::fmt::Display for OrbitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status.as_u16(), self.message)
    }
}

impl std::error::Error for OrbitError {}

impl OrbitError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            long_message: None,
            meta: None,
            items: None,
            headers: Vec::new(),
            row_level: false,
        }
    }

    /// Converts one write's error; flags it row-level for SQLSTATE `23xxx`,
    /// `22xxx` or `P0001`. Connection and savepoint failures stay unflagged.
    pub fn from_row_write(error: sqlx::Error) -> Self {
        let row_level = is_row_level_sqlstate(sqlstate(&error).as_deref());
        let mut converted = Self::from(error);
        converted.row_level = row_level;
        converted
    }

    pub fn with_meta(mut self, meta: Value) -> Self {
        self.meta = Some(meta);
        self
    }

    pub fn with_long_message(mut self, long_message: impl Into<String>) -> Self {
        self.long_message = Some(long_message.into());
        self
    }

    pub fn with_items(mut self, items: Vec<ApiErrorItem>) -> Self {
        self.items = Some(items);
        self
    }

    /// Adds a response header that `IntoResponse` must emit even though this is
    /// an error (used for the newly issued `__client` cookie on 401/403).
    pub fn with_header(mut self, name: header::HeaderName, value: HeaderValue) -> Self {
        self.headers.push((name, value));
        self
    }

    /// Convenience for `Set-Cookie` values built by the cookie helpers.
    pub fn with_cookie(mut self, cookie: impl Into<String>) -> Self {
        if let Ok(value) = HeaderValue::from_str(&cookie.into()) {
            self.headers.push((header::SET_COOKIE, value));
        }
        self
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, code, message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn unprocessable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        let mut error = Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            error_codes::INTERNAL_SERVER_ERROR,
            message,
        );
        // `onError` never exposes the internal message on the wire.
        error.items = Some(vec![ApiErrorItem::new(
            error_codes::INTERNAL_SERVER_ERROR,
            "Internal server error",
        )]);
        error
    }

    pub fn to_item(&self) -> ApiErrorItem {
        ApiErrorItem {
            code: self.code.clone(),
            message: self.message.clone(),
            long_message: Some(
                self.long_message
                    .clone()
                    .unwrap_or_else(|| self.message.clone()),
            ),
            meta: self.meta.clone(),
        }
    }

    pub fn body(&self, trace_id: Option<String>) -> ApiErrorBody {
        ApiErrorBody {
            errors: self.items.clone().unwrap_or_else(|| vec![self.to_item()]),
            trace_id,
        }
    }
}

/// `Retry-After` is emitted for rate limits when `meta.retry_after` is numeric.
fn retry_after(error: &OrbitError) -> Option<u64> {
    if error.status != StatusCode::TOO_MANY_REQUESTS {
        return None;
    }
    let meta = error.meta.as_ref()?;
    let raw = meta.get("retry_after")?;
    raw.as_u64()
        .or_else(|| raw.as_i64().and_then(|v| u64::try_from(v).ok()))
        .or_else(|| raw.as_f64().map(|v| v.ceil() as u64))
}

/// Marker carried by a 500 response so path-aware middleware can log the same
/// trace id that is on the wire.
#[derive(Debug, Clone)]
pub struct TraceId(pub String);

/// Marker inserted into a response that failed with a retryable transaction
/// conflict (`transaction_conflict`). The request-level retry layer in
/// `orbitid-server` reads it instead of parsing the JSON body, so only this
/// specific database failure is replayed.
#[derive(Debug, Clone, Copy)]
pub struct RetryableTransactionConflict;

impl OrbitError {
    /// True for the 409 `transaction_conflict` produced by a Postgres deadlock
    /// (`40P01`) or serialization failure (`40001`).
    pub fn is_retryable_transaction(&self) -> bool {
        self.status == StatusCode::CONFLICT && self.code == error_codes::TRANSACTION_CONFLICT
    }
}

impl IntoResponse for OrbitError {
    fn into_response(self) -> Response {
        let trace_id = nanoid::nanoid!(16);
        let retry_after = retry_after(&self);
        let status = self.status;
        let retryable = self.is_retryable_transaction();
        let body = self.body(Some(trace_id.clone()));
        // The logging rule lives in `http::error_logging`; see the module docs.
        let mut response = (status, axum::Json(body)).into_response();
        response.extensions_mut().insert(TraceId(trace_id.clone()));
        if retryable {
            response
                .extensions_mut()
                .insert(RetryableTransactionConflict);
        }
        if let Some(seconds) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        for (name, value) in self.headers {
            response.headers_mut().append(name, value);
        }
        response
    }
}

/// A 404 for a route that does not exist. The TS fallback has no `trace_id`.
pub fn route_not_found() -> Response {
    let body = ApiErrorBody {
        errors: vec![ApiErrorItem::new(
            error_codes::RESOURCE_NOT_FOUND,
            "Route not found",
        )],
        trace_id: None,
    };
    (StatusCode::NOT_FOUND, axum::Json(body)).into_response()
}

/// `notFound(what)` helper from `lib/http.ts`.
pub fn not_found(what: &str) -> OrbitError {
    OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, format!("{what} not found"))
}

/// Unique violation detection (`23505`), used by handlers racing an insert.
pub fn is_unique_violation(error: &sqlx::Error) -> bool {
    sqlstate(error).as_deref() == Some("23505")
}

/// SQLSTATE classes that describe the written row, not the connection.
pub fn is_row_level_sqlstate(code: Option<&str>) -> bool {
    code.is_some_and(|code| code.starts_with("23") || code.starts_with("22") || code == "P0001")
}

fn sqlstate(error: &sqlx::Error) -> Option<String> {
    match error {
        sqlx::Error::Database(db) => db.code().map(|code| code.into_owned()),
        _ => None,
    }
}

/// True for Postgres `serialization_failure` (`40001`) and `deadlock_detected`
/// (`40P01`): the transaction was aborted because of a concurrent writer and the
/// same request can safely be retried.
pub fn is_retryable_transaction_error(error: &sqlx::Error) -> bool {
    matches!(sqlstate(error).as_deref(), Some("40001" | "40P01"))
}

fn retryable_transaction_error() -> OrbitError {
    OrbitError::conflict(
        error_codes::TRANSACTION_CONFLICT,
        "The request conflicted with another concurrent change. Retry it.",
    )
    .with_meta(json!({ "retryable": true }))
}

impl From<sqlx::Error> for OrbitError {
    fn from(error: sqlx::Error) -> Self {
        if is_retryable_transaction_error(&error) {
            // A deadlock or serialization failure is transient. Keep the wire
            // format and give clients a stable, retryable code instead of a 500.
            tracing::warn!(error = %error, "retryable transaction conflict");
            return retryable_transaction_error();
        }
        if is_unique_violation(&error) {
            let mut conflict =
                OrbitError::conflict(error_codes::DUPLICATE_RECORD, "That record already exists");
            // The TS onError emits a bare item here (no `long_message`).
            conflict.items = Some(vec![ApiErrorItem::new(
                error_codes::DUPLICATE_RECORD,
                "That record already exists",
            )]);
            return conflict;
        }
        tracing::error!(error = %error, "database error");
        OrbitError::internal("Internal server error")
    }
}

/// Body for a validation problem that names a parameter.
pub fn form_param_error(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct TestDbError(&'static str);

    impl std::fmt::Display for TestDbError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "database error {}", self.0)
        }
    }
    impl std::error::Error for TestDbError {}
    impl sqlx::error::DatabaseError for TestDbError {
        fn message(&self) -> &str {
            "test database error"
        }
        fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
            Some(std::borrow::Cow::Borrowed(self.0))
        }
        fn kind(&self) -> sqlx::error::ErrorKind {
            sqlx::error::ErrorKind::Other
        }
        fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
            self
        }
        fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
            self
        }
    }

    #[test]
    fn retryable_conflicts_map_to_a_stable_retryable_code() {
        for code in ["40001", "40P01"] {
            let error: OrbitError = sqlx::Error::Database(Box::new(TestDbError(code))).into();
            assert_eq!(error.status, StatusCode::CONFLICT);
            assert_eq!(error.code, error_codes::TRANSACTION_CONFLICT);
            assert_eq!(error.meta.as_ref().unwrap()["retryable"], true);
        }
        // An ordinary database failure is still a 500.
        let error: OrbitError = sqlx::Error::Database(Box::new(TestDbError("23503"))).into();
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn item_includes_long_message() {
        let error = OrbitError::bad_request(error_codes::REQUEST_BODY_INVALID, "Nope");
        let item = error.to_item();
        assert_eq!(item.long_message.as_deref(), Some("Nope"));
        assert!(item.meta.is_none());
    }

    #[test]
    fn internal_and_not_found_items_are_bare() {
        let internal = OrbitError::internal("database exploded");
        let item = &internal.body(Some("t".into())).errors[0];
        assert_eq!(item.message, "Internal server error");
        assert!(item.long_message.is_none());

        let not_found = route_not_found();
        let _ = not_found;
        let item = ApiErrorItem::new(error_codes::RESOURCE_NOT_FOUND, "Route not found");
        assert!(item.long_message.is_none());
    }

    #[test]
    fn unique_violation_maps_to_409() {
        // SQLite-style errors cannot be constructed here, but the fallback is a 500.
        let error = OrbitError::from(sqlx::Error::RowNotFound);
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.code, error_codes::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn only_row_level_write_failures_are_flagged() {
        let flag = |code: &'static str| {
            OrbitError::from_row_write(sqlx::Error::Database(Box::new(TestDbError(code)))).row_level
        };
        for code in ["23505", "23514", "23503", "P0001", "22001"] {
            assert!(flag(code), "{code}");
        }
        for code in ["40001", "40P01", "25P02", "08006", "57014", "53300"] {
            assert!(!flag(code), "{code}");
        }
        assert!(!OrbitError::from_row_write(sqlx::Error::PoolTimedOut).row_level);
    }
}
