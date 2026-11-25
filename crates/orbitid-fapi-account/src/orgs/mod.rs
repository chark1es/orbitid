//! Organization Frontend API (`/v1/client/organizations/*` and the signed-in
//! user's own memberships/invitations/suggestions), ported from
//! `modules/org-client.ts` and `modules/org-client/*`.

use std::collections::HashMap;

use axum::http::Uri;
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use orbitid_core::error::Result;
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow};
use orbitid_core::state::AppState;
use orbitid_identity::caller::{resolve_caller, try_resolve_caller, Caller};
use orbitid_identity::org_shared::{org_access, ListParams, OrgAccess};
use serde_json::{json, Value};

pub mod billing;
pub mod current_user;
pub mod domains;
pub mod invitations;
pub mod memberships;
pub mod organizations;
pub mod public;
pub mod requests;
pub mod serializers;

pub use serializers::*;

/// Routes under `/v1/client` owned by the organization surface.
pub fn router() -> Router<AppState> {
    Router::new()
        // public
        .route(
            "/v1/client/organization_invitations/accept",
            get(public::accept_invitation_link),
        )
        // current user
        .route(
            "/v1/client/me/organization_memberships",
            get(current_user::list_memberships).post(current_user::join_organization),
        )
        .route(
            "/v1/client/me/organization_memberships/{org_id}",
            delete(current_user::leave_organization),
        )
        .route(
            "/v1/client/me/organization_invitations",
            get(current_user::list_invitations),
        )
        .route(
            "/v1/client/me/organization_invitations/{id}/accept",
            post(current_user::accept_invitation),
        )
        .route(
            "/v1/client/me/organization_suggestions",
            get(current_user::list_suggestions),
        )
        .route(
            "/v1/client/me/organization_suggestions/{id}/accept",
            post(current_user::accept_suggestion),
        )
        // organizations
        .route("/v1/client/organizations", post(organizations::create))
        .route(
            "/v1/client/organizations/{id}",
            get(organizations::get)
                .patch(organizations::update)
                .delete(organizations::delete),
        )
        .route(
            "/v1/client/organizations/{id}/logo",
            put(organizations::upload_logo).delete(organizations::delete_logo),
        )
        // memberships
        .route(
            "/v1/client/organizations/{id}/memberships",
            get(memberships::list),
        )
        .route(
            "/v1/client/organizations/{id}/memberships/{user_id}",
            patch(memberships::update).delete(memberships::delete),
        )
        // invitations
        .route(
            "/v1/client/organizations/{id}/invitations",
            get(invitations::list).post(invitations::create),
        )
        .route(
            "/v1/client/organizations/{id}/invitations/{inv_id}/revoke",
            post(invitations::revoke),
        )
        // domains
        .route(
            "/v1/client/organizations/{id}/domains",
            get(domains::list).post(domains::create),
        )
        .route(
            "/v1/client/organizations/{id}/domains/{did}",
            get(domains::get).delete(domains::delete),
        )
        .route(
            "/v1/client/organizations/{id}/domains/{did}/prepare_affiliation_verification",
            post(domains::prepare_affiliation_verification),
        )
        .route(
            "/v1/client/organizations/{id}/domains/{did}/attempt_affiliation_verification",
            post(domains::attempt_affiliation_verification),
        )
        .route(
            "/v1/client/organizations/{id}/domains/{did}/update_enrollment_mode",
            post(domains::update_enrollment_mode),
        )
        // membership requests
        .route(
            "/v1/client/organizations/{id}/membership_requests",
            get(requests::list).post(requests::create),
        )
        .route(
            "/v1/client/organizations/{id}/membership_requests/{rid}/accept",
            post(requests::accept),
        )
        .route(
            "/v1/client/organizations/{id}/membership_requests/{rid}/reject",
            post(requests::reject),
        )
        // roles
        .route("/v1/client/organizations/{id}/roles", get(requests::roles))
        // billing (operator-configured external portal)
        .route("/v1/client/organizations/{id}/billing", get(billing::get))
}

// ───────────── shared helpers (`modules/org-client/shared.ts`, `orgs/shared.ts`) ─────────────

/// Query parameters as a map (last value wins, like `Object.fromEntries`).
pub fn query_map(uri: &Uri) -> HashMap<String, String> {
    uri.query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect()
        })
        .unwrap_or_default()
}

/// `listParams`: paging plus `query`/`order_by`.
pub struct OrgListParams {
    pub page: ListParams,
    pub query: Option<String>,
    pub order_by: Option<String>,
}

pub fn list_params(uri: &Uri) -> OrgListParams {
    let map = query_map(uri);
    let query = map
        .get("query")
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    OrgListParams {
        page: ListParams::from_query(&map),
        query,
        order_by: map.get("order_by").cloned(),
    }
}

/// `fapiList(c, rows)`: `{ response: rows }`, or `{ data, total_count }` when
/// `?paginated=true`.
pub fn fapi_list(uri: &Uri, rows: Vec<Value>) -> Value {
    if query_map(uri).get("paginated").map(String::as_str) == Some("true") {
        let total = rows.len() as i64;
        json!({ "data": rows, "total_count": total })
    } else {
        json!({ "response": rows })
    }
}

/// The caller plus the org/membership/permissions guard.
pub struct OrgCaller {
    pub caller: Caller,
    pub access: OrgAccess,
}

/// Frontend API guard: organizations enabled, signed in, member of `id`, and
/// optionally holding `permission`.
pub async fn org_access_for(
    state: &AppState,
    uri: &Uri,
    headers: &axum::http::HeaderMap,
    id: &str,
    permission: Option<&str>,
) -> Result<OrgCaller> {
    let caller = resolve_caller(state, headers, hinted_session(uri).as_deref()).await?;
    let access = org_access(state, id, &caller.user_id, permission).await?;
    Ok(OrgCaller { caller, access })
}

/// `?_session_id`, mirroring `tryResolveCaller`'s query hint.
pub fn hinted_session(uri: &Uri) -> Option<String> {
    query_map(uri).get("_session_id").cloned()
}

/// Resolves the caller for routes that do not take an organization id.
pub async fn caller_for(
    state: &AppState,
    uri: &Uri,
    headers: &axum::http::HeaderMap,
) -> Result<Caller> {
    resolve_caller(state, headers, hinted_session(uri).as_deref()).await
}

/// Optional caller (the invitation-acceptance link works signed out).
pub async fn optional_caller(
    state: &AppState,
    uri: &Uri,
    headers: &axum::http::HeaderMap,
) -> Result<Option<Caller>> {
    try_resolve_caller(state, headers, hinted_session(uri).as_deref()).await
}

/// `requireMembership(ctx, org, userId)`.
pub async fn require_membership(
    state: &AppState,
    org: &OrganizationRow,
    user_id: &str,
) -> Result<OrganizationMembershipRow> {
    orbitid_identity::org_shared::require_membership(state, org, user_id, "").await
}
