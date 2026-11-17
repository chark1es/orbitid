//! Pre-body authentication guard.
//!
//! The TypeScript handlers authenticate before they call `parseBody`, so an
//! unauthenticated request with a malformed body gets a 401 (and, where the TS
//! path creates a browser client first, the new `__client` cookie), never a 422.
//! axum runs body extractors as part of the handler, so the only place that can
//! guarantee the same order is a middleware in front of routing.
//!
//! The guard resolves the identity once and leaves it in the request
//! extensions: `/v1/client/me` handlers pick it up through `HttpMeta`, and the
//! session routes receive the freshly issued client cookie as a request cookie
//! so the handler does not create a second client row.

use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, Uri};
use axum::middleware::Next;
use axum::response::Response;
use orbitid_core::error::Result;
use orbitid_core::AppState;
use orbitid_fapi_account::CachedMeAuth;
use orbitid_identity::rbac::{DOMAINS_MANAGE, MEMBERSHIPS_MANAGE, PROFILE_MANAGE};

/// The organization authorization a body-taking route performs before it
/// reads the body, exactly like the TypeScript handlers.
#[derive(Clone, Copy)]
enum OrgRequirement {
    Permission(&'static str),
    ApiKeys,
}

enum Guarded {
    None,
    /// A new `__client` cookie line the handler must also see.
    ClientCookie(String),
    /// Identity already resolved for a `/v1/client/me` handler.
    Me(Box<CachedMeAuth>),
}

/// Applies the authentication the TypeScript handler would have performed
/// before reading the body. Routes that authenticate only through the Backend
/// API middleware (`require_secret_key`) are not touched here.
pub async fn pre_body_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response> {
    let method = request.method().clone();
    if !matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Ok(next.run(request).await);
    }
    let uri = request.uri().clone();
    let headers = request.headers().clone();

    match guard(&state, &headers, &method, &uri).await? {
        Guarded::None => {}
        Guarded::ClientCookie(cookie) => append_client_cookie(request.headers_mut(), &cookie),
        Guarded::Me(cached) => {
            request.extensions_mut().insert(*cached);
        }
    }
    Ok(next.run(request).await)
}

async fn guard(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
    uri: &Uri,
) -> Result<Guarded> {
    let path = uri.path();

    // The device endpoints check whether the feature is enabled before they
    // authenticate or parse a body (the TypeScript handlers return 404 first).
    if matches!(path, "/oauth/device" | "/v1/client/oauth/device/approve") {
        if !state
            .settings
            .get()
            .oidc_provider
            .device_authorization_enabled
        {
            return Err(orbitid_core::error::OrbitError::not_found(
                orbitid_core::error::error_codes::RESOURCE_NOT_FOUND,
                "Route not found",
            ));
        }
        orbitid_identity::machine_auth::require_user_caller(state, headers).await?;
        return Ok(Guarded::None);
    }

    // Organization and API-key surfaces authenticate through the caller
    // resolver (session JWT, client cookie or client token).
    if path.starts_with("/v1/client/me/api_keys")
        || path == "/oauth/consent"
        || path == "/oauth/device"
    {
        orbitid_identity::machine_auth::require_user_caller(state, headers).await?;
        return Ok(Guarded::None);
    }

    // Body-taking organization routes check organization access before parsing
    // the body, as the TypeScript handlers do: an authenticated non-member gets
    // 403/404, never a body-validation 422.
    if let Some((org_id, requirement)) = org_requirement(method, path) {
        match requirement {
            OrgRequirement::Permission(permission) => {
                let caller = orbitid_identity::caller::resolve_caller(
                    state,
                    headers,
                    orbitid_fapi_account::orgs::hinted_session(uri).as_deref(),
                )
                .await?;
                orbitid_identity::org_shared::org_access(
                    state,
                    org_id,
                    &caller.user_id,
                    Some(permission),
                )
                .await?;
            }
            OrgRequirement::ApiKeys => {
                let caller =
                    orbitid_identity::machine_auth::require_user_caller(state, headers).await?;
                // The handler resolves the organization before the permission, so a
                // missing organization stays a 404 before body validation.
                orbitid_identity::org_shared::require_organization(state, org_id).await?;
                orbitid_oidc::services::api_keys::assert_org_api_keys_permission(
                    state,
                    caller.user_id.as_deref().unwrap_or_default(),
                    org_id,
                )
                .await?;
            }
        }
        return Ok(Guarded::None);
    }
    if path.starts_with("/v1/client/organizations")
        || path.starts_with("/v1/client/me/organization_")
    {
        orbitid_identity::machine_auth::require_caller(state, headers).await?;
        return Ok(Guarded::None);
    }

    // The signed-in user's own routes use the browser client + active session.
    if path == "/v1/client/me" || path.starts_with("/v1/client/me/") {
        if path == "/v1/client/me/change_password" || path == "/v1/client/me/remove_password" {
            orbitid_fapi_account::util::require_reverification(state, headers, "first_factor", 10)
                .await?;
        }
        let cached =
            orbitid_fapi_account::resolve_me_auth(state, headers, method.clone(), path).await?;
        return Ok(Guarded::Me(Box::new(cached)));
    }

    if path.starts_with("/v1/client/sessions/") {
        if let Some(cookie) = orbitid_fapi_auth::guard_session_auth(state, headers, path).await? {
            return Ok(Guarded::ClientCookie(cookie));
        }
    }
    Ok(Guarded::None)
}

/// The organization authorization a body-taking route checks before its body
/// extractor runs. Returns the organization id and what to authorize.
fn org_requirement<'a>(method: &Method, path: &'a str) -> Option<(&'a str, OrgRequirement)> {
    let rest = path.strip_prefix("/v1/client/organizations/")?;
    let mut parts = rest.split('/');
    let org_id = parts.next()?;
    if org_id.is_empty() {
        return None;
    }
    let tail: Vec<&str> = parts.collect();
    let requirement = match (method.as_str(), tail.as_slice()) {
        ("PATCH", []) => OrgRequirement::Permission(PROFILE_MANAGE),
        ("PUT", ["logo"]) => OrgRequirement::Permission(PROFILE_MANAGE),
        ("PATCH", ["memberships", _]) => OrgRequirement::Permission(MEMBERSHIPS_MANAGE),
        ("POST", ["invitations"]) => OrgRequirement::Permission(MEMBERSHIPS_MANAGE),
        ("POST", ["domains"]) => OrgRequirement::Permission(DOMAINS_MANAGE),
        (
            "POST",
            ["domains", _, "prepare_affiliation_verification"
            | "attempt_affiliation_verification"
            | "update_enrollment_mode"],
        ) => OrgRequirement::Permission(DOMAINS_MANAGE),
        ("POST", ["api_keys"]) => OrgRequirement::ApiKeys,
        ("PATCH", ["api_keys", _]) => OrgRequirement::ApiKeys,
        ("POST", ["api_keys", _, "revoke"]) => OrgRequirement::ApiKeys,
        _ => return None,
    };
    Some((org_id, requirement))
}

fn append_client_cookie(headers: &mut HeaderMap, set_cookie: &str) {
    let Some(start) = set_cookie.find("__client=") else {
        return;
    };
    let rest = &set_cookie[start + "__client=".len()..];
    let token = rest.split(';').next().unwrap_or("").trim();
    if token.is_empty() {
        return;
    }
    if let Ok(value) = header::HeaderValue::from_str(&format!("__client={token}")) {
        headers.append(header::COOKIE, value);
    }
}
