//! Signed-in user routes (`/v1/client/me/*`), ported from `modules/me.ts` and
//! `modules/me/*`. Profile/avatar/password live in [`profile`], identifiers in
//! [`identifiers`], external accounts in [`external`], MFA in [`mfa`], passkeys
//! in [`passkeys`] and sessions/trusted devices in [`sessions`].

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method};
use axum::routing::{delete, get, patch, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{ClientRow, SessionRow, UserRow};
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::{get_or_create_client, require_active_user};

pub mod applications;
pub mod external;
pub mod identifiers;
pub mod mfa;
pub mod passkeys;
pub mod profile;
pub mod profile_image;
pub mod sessions;
pub mod shared;
pub mod types;

/// Method + absolute path, so the pending-session guard can whitelist exactly
/// the routes enrolling a factor needs (like `me/helpers.ts`). The request's
/// extensions are carried along so a pre-body auth guard can hand the resolved
/// identity to the handler without repeating the database work.
#[derive(Debug, Clone)]
pub struct HttpMeta {
    pub method: Method,
    pub path: String,
    pub extensions: axum::http::Extensions,
}

impl<S> FromRequestParts<S> for HttpMeta
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        Ok(Self {
            method: parts.method.clone(),
            path: parts.uri.path().to_string(),
            extensions: parts.extensions.clone(),
        })
    }
}

/// The signed-in user for a `/v1/client/me/*` request.
#[derive(Clone)]
pub struct MeAuth {
    pub client: ClientRow,
    pub session: SessionRow,
    pub user: UserRow,
}

/// Identity resolved by the pre-body guard, reused by the handler.
#[derive(Clone)]
pub struct CachedMeAuth {
    pub auth: MeAuth,
    pub cookies: Vec<String>,
}

/// Routes served under `/v1/client/me`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/client/me",
            get(profile::get_profile)
                .patch(profile::update_profile)
                .delete(profile::delete_account),
        )
        .route(
            "/v1/client/me/profile_image",
            post(profile_image::upload_profile_image).delete(profile_image::delete_profile_image),
        )
        .route(
            "/v1/client/me/change_password",
            post(profile::change_password),
        )
        .route(
            "/v1/client/me/remove_password",
            post(profile::remove_password),
        )
        .route(
            "/v1/client/me/email_addresses",
            get(identifiers::list_email_addresses).post(identifiers::create_email_address),
        )
        .route(
            "/v1/client/me/email_addresses/{id}",
            get(identifiers::get_email_address).delete(identifiers::delete_email_address),
        )
        .route(
            "/v1/client/me/email_addresses/{id}/prepare_verification",
            post(identifiers::prepare_email_verification),
        )
        .route(
            "/v1/client/me/email_addresses/{id}/attempt_verification",
            post(identifiers::attempt_email_verification),
        )
        .route(
            "/v1/client/me/phone_numbers",
            get(identifiers::list_phone_numbers).post(identifiers::create_phone_number),
        )
        .route(
            "/v1/client/me/phone_numbers/{id}",
            get(identifiers::get_phone_number)
                .patch(identifiers::update_phone_number)
                .delete(identifiers::delete_phone_number),
        )
        .route(
            "/v1/client/me/phone_numbers/{id}/prepare_verification",
            post(identifiers::prepare_phone_verification),
        )
        .route(
            "/v1/client/me/phone_numbers/{id}/attempt_verification",
            post(identifiers::attempt_phone_verification),
        )
        .route(
            "/v1/client/me/external_accounts",
            get(external::list_external_accounts).post(external::create_external_account),
        )
        .route(
            "/v1/client/me/external_accounts/{id}",
            delete(external::delete_external_account),
        )
        .route(
            "/v1/client/me/external_accounts/{id}/access_token",
            get(external::external_account_access_token),
        )
        .route(
            "/v1/client/me/totp",
            get(mfa::get_totp)
                .post(mfa::start_totp)
                .delete(mfa::disable_totp_route),
        )
        .route(
            "/v1/client/me/totp/attempt_verification",
            post(mfa::attempt_totp_verification),
        )
        .route(
            "/v1/client/me/backup_codes",
            post(mfa::regenerate_backup_codes),
        )
        .route(
            "/v1/client/me/passkeys",
            get(passkeys::list_passkeys).post(passkeys::begin_registration),
        )
        .route(
            "/v1/client/me/passkeys/{id}",
            patch(passkeys::rename_passkey).delete(passkeys::delete_passkey),
        )
        .route(
            "/v1/client/me/passkeys/{id}/attempt_verification",
            post(passkeys::attempt_registration),
        )
        .route(
            "/v1/client/me/sessions/active",
            get(sessions::active_sessions),
        )
        .route(
            "/v1/client/me/sessions/{id}/revoke",
            post(sessions::revoke_session),
        )
        .route(
            "/v1/client/me/trusted_devices",
            get(sessions::list_trusted_devices),
        )
        .route(
            "/v1/client/me/oauth_applications",
            get(applications::list_oauth_applications),
        )
        .route(
            "/v1/client/me/trusted_devices/{id}",
            delete(sessions::delete_trusted_device),
        )
}

fn method_name(method: &Method) -> &'static str {
    if method == Method::GET {
        "GET"
    } else if method == Method::POST {
        "POST"
    } else if method == Method::PATCH {
        "PATCH"
    } else if method == Method::PUT {
        "PUT"
    } else if method == Method::DELETE {
        "DELETE"
    } else {
        "OTHER"
    }
}

fn replace_me_prefix(path: &str) -> String {
    let suffix = path.strip_prefix("/v1/client/me").unwrap_or(path);
    let trimmed = suffix.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Routes a pending session (required MFA, no factor enrolled yet) may use.
/// Everything else answers 403 `session_pending`.
pub fn pending_allowed(method: &Method, suffix: &str) -> bool {
    let method = method_name(method);
    if (method == "GET" || method == "POST") && suffix == "/" {
        // `GET /` only, but `POST /` does not exist; keep it strict.
        return method == "GET";
    }
    match suffix {
        "/totp" => matches!(method, "GET" | "POST"),
        "/totp/attempt_verification" => method == "POST",
        "/phone_numbers" => matches!(method, "GET" | "POST"),
        _ => is_phone_number_path(method, suffix),
    }
}

fn is_phone_number_path(method: &str, suffix: &str) -> bool {
    let Some(rest) = suffix.strip_prefix("/phone_numbers/") else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    match segments.as_slice() {
        [_id] => matches!(method, "GET" | "PATCH"),
        [_id, "prepare_verification"] | [_id, "attempt_verification"] => method == "POST",
        _ => false,
    }
}

/// `createMeHelpers.auth`: the request's client, its active session and user,
/// with the pending-session gate. The returned cookie lines must be attached to
/// the response (client creation/renewal).
pub async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    meta: &HttpMeta,
) -> Result<(MeAuth, Vec<String>)> {
    // The pre-body guard already resolved this request; reuse it instead of
    // issuing a second client/session lookup (and a second `__client` row when
    // the guard was the call that created the client).
    if let Some(cached) = meta.extensions.get::<CachedMeAuth>() {
        return Ok((cached.auth.clone(), cached.cookies.clone()));
    }
    let (client, cookie) =
        get_or_create_client(state, headers, method_name(&meta.method), &meta.path).await?;
    let cookies: Vec<String> = cookie.into_iter().collect();
    let (session, user) = match require_active_user(state, &client).await {
        Ok(value) => value,
        Err(error) => return Err(with_cookies(error, &cookies)),
    };
    if session.status == "pending" {
        let suffix = replace_me_prefix(&meta.path);
        if !pending_allowed(&meta.method, &suffix) {
            return Err(with_cookies(
                OrbitError::forbidden(
                    error_codes::SESSION_PENDING,
                    "Finish setting up two-factor authentication before doing anything else",
                ),
                &cookies,
            ));
        }
    }
    Ok((
        MeAuth {
            client,
            session,
            user,
        },
        cookies,
    ))
}

fn with_cookies(mut error: OrbitError, cookies: &[String]) -> OrbitError {
    for cookie in cookies {
        error = error.with_cookie(cookie.as_str());
    }
    error
}

/// Runs the same authentication a `/v1/client/me` handler would, before the
/// request body is parsed. The server calls this from its pre-body guard; the
/// result is cached in the request extensions for the handler.
pub async fn resolve_me_auth(
    state: &AppState,
    headers: &HeaderMap,
    method: Method,
    path: &str,
) -> Result<CachedMeAuth> {
    let meta = HttpMeta {
        method,
        path: path.to_string(),
        extensions: axum::http::Extensions::new(),
    };
    let (auth, cookies) = authenticate(state, headers, &meta).await?;
    Ok(CachedMeAuth { auth, cookies })
}
