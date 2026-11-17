//! Public organization invitation-acceptance link
//! (`modules/org-client/public.ts`). Logo files are served by `crate::images`.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use orbitid_core::crypto::sha256;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::OrganizationInvitationRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::user_verified_emails;
use orbitid_identity::orgs::accept_invitation;

use crate::util::validate_redirect_url;

use super::{optional_caller, query_map};

fn redirect(target: &str) -> Result<Response> {
    let location = HeaderValue::from_str(target).map_err(|_| {
        OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "redirect_url is not a valid URL",
        )
    })?;
    Ok((StatusCode::FOUND, [(header::LOCATION, location)]).into_response())
}

pub async fn accept_invitation_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    let query = query_map(&uri);
    let Some(ticket) = query.get("ticket").cloned() else {
        return Err(
            OrbitError::bad_request(error_codes::FORM_PARAM_MISSING, "ticket is missing")
                .with_meta(serde_json::json!({ "param_name": "ticket" })),
        );
    };
    let invitation = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE token_hash = $1",
    )
    .bind(sha256(&ticket))
    .fetch_optional(&state.pool)
    .await?;
    let Some(invitation) = invitation else {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "Organization invitation ticket is invalid",
        ));
    };
    if invitation.status == "revoked" {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "Organization invitation has been revoked",
        ));
    }
    if invitation.status == "pending" {
        if invitation.expires_at.map(|at| at <= now()).unwrap_or(false) {
            return Err(OrbitError::unprocessable(
                error_codes::TICKET_EXPIRED,
                "Organization invitation has expired",
            ));
        }
        if let Some(caller) = optional_caller(&state, &uri, &headers).await? {
            if user_verified_emails(&state, &caller.user_id)
                .await?
                .contains(&invitation.email.to_lowercase())
            {
                accept_invitation(&state, &invitation, &caller.user_id).await?;
            }
        }
    }
    let requested = query
        .get("redirect_url")
        .cloned()
        .filter(|value| !value.is_empty())
        .or_else(|| invitation.redirect_url.clone());
    let requested = validate_redirect_url(&state, requested.as_deref(), "redirect_url")?;
    let settings = state.settings.get();
    let target = requested.unwrap_or_else(|| {
        if settings.application.home_url.is_empty() {
            state.env.base_url.clone()
        } else {
            settings.application.home_url.clone()
        }
    });
    redirect(&target)
}
