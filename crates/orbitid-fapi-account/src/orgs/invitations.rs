//! Organization invitation routes (`modules/org-client/invitations.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::OrganizationInvitationRow;
use orbitid_core::resources::OrganizationInvitationJson;
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::normalize_email;
use orbitid_identity::org_serializers::{
    serialize_organization_invitation, serialize_organization_invitations,
};
use orbitid_identity::org_shared::{invitation_url, page, sort_rows};
use orbitid_identity::orgs::{create_organization_invitation_on, CreateInvitationInput};
use orbitid_identity::rbac::{assert_organization_role, MEMBERSHIPS_MANAGE, MEMBERSHIPS_READ};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::reply::json_reply;
use crate::util::validate_redirect_url;

use super::serializers::{dedupe_recipients, find_invitation};
use super::{list_params, org_access_for, query_map};

#[derive(Debug, Default, Deserialize)]
pub struct InvitationCreateBody {
    #[serde(default)]
    pub email_address: Option<String>,
    #[serde(default)]
    pub email_addresses: Option<Vec<String>>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub redirect_url: Option<String>,
    /// `z.coerce.number().int().min(1).max(365).optional()`
    #[serde(default)]
    pub expires_in_days: Option<Value>,
}

fn expires_in_days(value: &Option<Value>) -> Result<Option<i64>> {
    let Some(value) = value else { return Ok(None) };
    let parsed = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(parsed) = parsed else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "expires_in_days: expected a number",
        )
        .with_meta(json!({ "param_name": "expires_in_days" })));
    };
    let days = parsed.trunc() as i64;
    if parsed.fract() != 0.0 || !(1..=365).contains(&days) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "expires_in_days: must be an integer between 1 and 365",
        )
        .with_meta(json!({ "param_name": "expires_in_days" })));
    }
    Ok(Some(days))
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_READ)).await?;
    let params = list_params(&uri);
    let status = query_map(&uri).get("status").cloned();
    let rows = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE organization_id = $1",
    )
    .bind(&found.access.org.id)
    .fetch_all(&state.pool)
    .await?;
    let mut serialized = serialize_organization_invitations(&state, &rows).await?;
    if let Some(status) = status {
        serialized.retain(|row| status_value(row.status) == status);
    }
    if let Some(query) = &params.query {
        serialized.retain(|row| row.email_address.contains(query));
    }
    let order = params.order_by.as_deref().unwrap_or("-created_at");
    sort_rows(&mut serialized, Some(order), invitation_column);
    if params.page.paginated {
        let (items, total) = page(&serialized, params.page);
        return Ok(json_reply(
            json!({ "data": items, "total_count": total }),
            Vec::new(),
        ));
    }
    Ok(json_reply(json!({ "response": serialized }), Vec::new()))
}

fn invitation_column(row: &OrganizationInvitationJson, field: &str) -> Option<Value> {
    match field {
        "created_at" => Some(json!(row.created_at)),
        "updated_at" => Some(json!(row.updated_at)),
        "email_address" => Some(json!(row.email_address)),
        _ => None,
    }
}

fn status_value(status: orbitid_core::resources::InvitationStatus) -> String {
    match status {
        orbitid_core::resources::InvitationStatus::Pending => "pending",
        orbitid_core::resources::InvitationStatus::Accepted => "accepted",
        orbitid_core::resources::InvitationStatus::Revoked => "revoked",
        orbitid_core::resources::InvitationStatus::Expired => "expired",
    }
    .to_string()
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<InvitationCreateBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    let org = found.access.org.clone();
    let bulk = body.email_addresses.is_some();
    let raw_emails: Vec<String> = match (&body.email_addresses, &body.email_address) {
        (Some(emails), _) => emails.clone(),
        (None, Some(email)) => vec![email.clone()],
        (None, None) => Vec::new(),
    };
    if let Some(emails) = &body.email_addresses {
        for email in emails {
            if email.len() < 3 {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_FORMAT_INVALID,
                    "email_addresses: each entry must be at least 3 characters",
                )
                .with_meta(json!({ "param_name": "email_addresses" })));
            }
        }
    }
    let mut emails = Vec::with_capacity(raw_emails.len());
    for raw in &raw_emails {
        emails.push(normalize_email(raw)?);
    }
    if emails.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "email_address or email_addresses is required",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    if let Some(role) = &body.role {
        assert_organization_role(&state, role, "role").await?;
    }
    let days = expires_in_days(&body.expires_in_days)?;
    let recipients = dedupe_recipients(&state, &org, &emails).await?;
    if !bulk && recipients.is_empty() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!(
                "{} is already a member or has already been invited",
                emails[0]
            ),
        ));
    }
    let inviter = {
        let name = [
            found.caller.user.first_name.as_deref(),
            found.caller.user.last_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        if name.is_empty() {
            found
                .caller
                .user
                .username
                .clone()
                .unwrap_or_else(|| found.caller.user.id.clone())
        } else {
            name
        }
    };
    let redirect_url = validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?;
    // Every invitation in a bulk request and its `organizationInvitation.created`
    // event commit in one transaction: a quota/duplicate failure cannot leave a
    // half-created batch. Delivery is post-commit best-effort.
    let mut tx = state.pool.begin().await?;
    let mut issued = Vec::new();
    for email in recipients {
        let (invitation, ticket) = create_organization_invitation_on(
            &mut tx,
            &state,
            &org,
            &CreateInvitationInput {
                email: email.clone(),
                role_key: body.role.clone(),
                inviter_user_id: Some(found.caller.user_id.clone()),
                redirect_url: redirect_url.clone(),
                public_metadata: None,
                private_metadata: None,
                expires_at: days.map(|days| now() + days * 24 * 60 * 60 * 1000),
            },
        )
        .await?;
        issued.push((email, invitation, ticket));
    }
    tx.commit().await?;
    let mut created = Vec::new();
    for (email, invitation, ticket) in issued {
        send_email(
            &state,
            SendEmailInput::new(email.clone(), EmailTemplate::OrganizationInvitation)
                .with_var("organization_name", org.name.clone())
                .with_var("organization_slug", org.slug.clone().unwrap_or_default())
                .with_var("inviter_name", inviter.clone())
                .with_var("email_address", email)
                .with_var("role", invitation.role_key.clone())
                .with_var("invitation_url", invitation_url(&state, &ticket))
                .with_var("expires_in_days", days.unwrap_or(30)),
        )
        .await;
        created.push(serialize_organization_invitation(&state, &invitation, false, None).await?);
    }
    if bulk {
        Ok(json_reply(json!({ "response": created }), Vec::new()))
    } else {
        let first = created.into_iter().next();
        Ok(json_reply(json!({ "response": first }), Vec::new()))
    }
}

pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, inv_id)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(MEMBERSHIPS_MANAGE)).await?;
    let Some(invitation) = find_invitation(&state, &found.access.org.id, &inv_id).await? else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization invitation not found",
        ));
    };
    if invitation.status != "pending" {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Invitation is {}", invitation.status),
        ));
    }
    // Organization lock (rank 8), status flip and event row, committed together.
    let mut tx = state.pool.begin().await?;
    let revoked =
        orbitid_identity::orgs::revoke_organization_invitation_on(&mut tx, &invitation).await?;
    if revoked.status != "revoked" {
        tx.rollback().await?;
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("Invitation is {}", revoked.status),
        ));
    }
    tx.commit().await?;
    let client_payload = serialize_organization_invitation(&state, &revoked, false, None).await?;
    Ok(json_reply(
        json!({ "response": client_payload }),
        Vec::new(),
    ))
}
