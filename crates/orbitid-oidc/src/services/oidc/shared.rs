//! Constants and the OAuth error type shared by every OIDC service and route,
//! ported from `services/oidc/shared.ts` and the `handle()` wrapper in
//! `modules/oidc/shared.ts`.
//!
//! Storage notes (same as the TypeScript server):
//!  - codes/access/refresh tokens are random opaque strings; only sha256 hashes
//!    are stored in `oauth_grants`. The one exception is the successor refresh
//!    token sealed (AES-GCM with `ORBITID_ENCRYPTION_KEY`) on a consumed row for
//!    the retry grace window.
//!  - `family_id` ties the access and refresh tokens of one authorization
//!    together (refresh rotation and reuse detection); `session_id` keeps `sid`
//!    and the org claims tied to the authorizing session; `nonce` is the OIDC
//!    nonce of an authorization code.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};

/// Scopes every application supports conceptually; the application's `scopes`
/// field is the enforced allowlist.
pub const BASE_OIDC_SCOPES: [&str; 7] = [
    "openid",
    "profile",
    "email",
    "phone",
    "groups",
    "organizations",
    "offline_access",
];

/// Human-readable description of a scope (consent screens, device page).
pub fn scope_description(scope: &str) -> String {
    let description = match scope {
        "openid" => "Authenticate you and read your OrbitID user id",
        "profile" => "Read your name, username and profile picture",
        "email" => "Read your email address and whether it is verified",
        "phone" => "Read your phone number and whether it is verified",
        "groups" => {
            "Read the groups and roles used for access control (see the application's groups setting)"
        }
        "organizations" => "Read the organizations you belong to and your role in them",
        "offline_access" => "Stay signed in after you leave (refresh token)",
        other => return format!("Access to {other}"),
    };
    description.to_string()
}

/// What the `groups` claim contains, per application.
pub const GROUPS_CLAIM_MODES: [&str; 4] = ["none", "organizations", "roles", "all"];

/// RFC 8628 grant type.
pub const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub const ACCESS_TOKEN_TTL_SECONDS: i64 = 60 * 60;
pub const REFRESH_TOKEN_TTL_SECONDS: i64 = 60 * 60 * 24 * 30;
pub const AUTHORIZATION_CODE_TTL_SECONDS: i64 = 10 * 60;
pub const ID_TOKEN_TTL_SECONDS: i64 = 60 * 60;

/// Bounds for the per-application lifetimes exposed in the dashboard.
pub const LIFETIME_BOUNDS_ACCESS: (i64, i64) = (60, 24 * 60 * 60);
pub const LIFETIME_BOUNDS_REFRESH: (i64, i64) = (60, 365 * 24 * 60 * 60);
pub const LIFETIME_BOUNDS_ID: (i64, i64) = (60, 24 * 60 * 60);

/// How long a just-rotated refresh token stays usable for a retry of a lost response.
pub const REFRESH_REUSE_GRACE_SECONDS: i64 = 30;

/// RFC 6749 error surfaced on OAuth endpoints (`{ error, error_description }`,
/// never the OrbitID error envelope).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthError {
    pub status: StatusCode,
    pub error: String,
    pub description: String,
}

impl OAuthError {
    pub fn new(
        status: StatusCode,
        error: impl Into<String>,
        description: impl Into<String>,
    ) -> Self {
        Self {
            status,
            error: error.into(),
            description: description.into(),
        }
    }

    pub fn bad_request(error: impl Into<String>, description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, error, description)
    }

    pub fn unauthorized(error: impl Into<String>, description: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, error, description)
    }

    pub fn invalid_grant(description: impl Into<String>) -> Self {
        Self::bad_request(error_codes::INVALID_GRANT, description)
    }

    pub fn invalid_client(description: impl Into<String>) -> Self {
        Self::unauthorized(error_codes::INVALID_CLIENT, description)
    }

    pub fn invalid_request(description: impl Into<String>) -> Self {
        Self::bad_request("invalid_request", description)
    }
}

fn escape_quotes(value: &str) -> String {
    value.replace('"', "'")
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            axum::Json(json!({
                "error": self.error,
                "error_description": self.description,
            })),
        )
            .into_response();
        let challenge = match (self.status, self.error.as_str()) {
            (StatusCode::UNAUTHORIZED, "invalid_client") => Some(format!(
                "Basic realm=\"orbitid\", error=\"invalid_client\", error_description=\"{}\"",
                escape_quotes(&self.description)
            )),
            (StatusCode::UNAUTHORIZED, "invalid_token") => Some(format!(
                "Bearer realm=\"orbitid\", error=\"invalid_token\", error_description=\"{}\"",
                escape_quotes(&self.description)
            )),
            _ => None,
        };
        if let Some(challenge) = challenge {
            if let Ok(value) = HeaderValue::from_str(&challenge) {
                response
                    .headers_mut()
                    .insert(header::WWW_AUTHENTICATE, value);
            }
        }
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}

/// Everything a route handler can fail with: an OAuth error body, or an
/// OrbitID error envelope (exactly like `handle()` rethrowing non-OAuth errors).
#[derive(Debug)]
pub enum HandlerError {
    OAuth(OAuthError),
    Orbit(OrbitError),
}

impl From<OAuthError> for HandlerError {
    fn from(error: OAuthError) -> Self {
        Self::OAuth(error)
    }
}

impl From<OrbitError> for HandlerError {
    fn from(error: OrbitError) -> Self {
        Self::Orbit(error)
    }
}

impl From<sqlx::Error> for HandlerError {
    fn from(error: sqlx::Error) -> Self {
        Self::Orbit(OrbitError::from(error))
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        match self {
            Self::OAuth(error) => error.into_response(),
            Self::Orbit(error) => error.into_response(),
        }
    }
}

/// `Result` alias for route handlers.
pub type HandlerResult<T> = std::result::Result<T, HandlerError>;

/// Splits a scope string on spaces, commas and other whitespace, dropping empty entries.
pub fn parse_scopes(raw: &str) -> Vec<String> {
    raw.split([' ', ',', '\t', '\n', '\r'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parsing_dedupes_only_through_callers() {
        assert_eq!(
            parse_scopes("openid  profile,email\n"),
            vec!["openid", "profile", "email"]
        );
        assert!(parse_scopes("").is_empty());
    }

    #[test]
    fn whole_scope_list_is_described() {
        for scope in BASE_OIDC_SCOPES {
            assert!(!scope_description(scope).is_empty());
        }
        assert_eq!(scope_description("custom"), "Access to custom");
    }

    #[test]
    fn invalid_client_sets_www_authenticate() {
        let response = OAuthError::invalid_client("Client authentication failed").into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let header = response
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(header.starts_with("Basic realm=\"orbitid\""));
        assert_eq!(
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .and_then(|value| value.to_str().ok()),
            Some("no-store")
        );
    }
}
