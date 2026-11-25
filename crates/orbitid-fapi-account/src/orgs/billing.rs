//! An organization's billing settings for its billing managers
//! (`GET /v1/client/organizations/{id}/billing`).
//!
//! OrbitID stores no plans or invoices: this returns the operator-configured
//! external billing portal. Members need `org:sys_billing:manage`; a non-member
//! gets the usual organization 404 and a member without the permission 403
//! `org_permission_required`. `GET` has no body, so nothing is parsed before
//! the check.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use orbitid_core::error::Result;
use orbitid_core::resources::OrganizationBillingJson;
use orbitid_core::state::AppState;
use orbitid_identity::rbac::BILLING_MANAGE;
use serde_json::json;

use crate::reply::json_reply;

use super::org_access_for;

pub async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(BILLING_MANAGE)).await?;
    let org = found.access.org;
    let billing = OrganizationBillingJson {
        object: "organization_billing".into(),
        organization_id: org.id,
        portal_url: org.billing_portal_url,
    };
    Ok(json_reply(json!({ "response": billing }), Vec::new()))
}
