//! The OAuth applications the signed-in user may use
//! (`GET /v1/client/me/oauth_applications`), for the account page.
//!
//! The list is computed with the same access rule the OAuth issuers enforce
//! (`orbitid_identity::app_access`): instance-wide applications, applications
//! owned by an organization the user belongs to, and applications an operator
//! granted the user. A `GET` has no body, so the handler authenticates first
//! by construction; the pending-session gate in [`super::authenticate`] applies.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::Result;
use orbitid_core::state::AppState;
use orbitid_identity::app_access::applications_for_user;
use serde_json::json;

use crate::reply::json_reply;

use super::{authenticate, HttpMeta};

pub async fn list_oauth_applications(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let applications = applications_for_user(&state.pool, &me.user.id).await?;
    Ok(json_reply(json!({ "response": applications }), cookies))
}
