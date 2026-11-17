//! Organization invitation routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::OrganizationInvitationRow;
use orbitid_core::resources::{InvitationStatus, Metadata};
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::normalize_email;
use orbitid_identity::org_serializers::{
    effective_invitation_status, serialize_organization_invitation,
};
use orbitid_identity::org_shared::{invitation_url, page, sort_rows, ListParams};
use orbitid_identity::orgs::{create_organization_invitation, CreateInvitationInput};
use serde::Deserialize;
use serde_json::json;

use super::shared::{find_invitation, list_response, notify_invitation, require_organization};
use crate::shared::{
    deserialize_opt_bool, deserialize_opt_int, json_response, to_value, validate_metadata,
    QueryPairs,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/organizations/{id}/invitations", get(list).post(create))
        .route(
            "/v1/organizations/{id}/invitations/bulk",
            axum::routing::post(bulk),
        )
        .route("/v1/organizations/{id}/invitations/{inv_id}", get(read))
        .route(
            "/v1/organizations/{id}/invitations/{inv_id}/revoke",
            axum::routing::post(revoke),
        )
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let list = query.list()?;
    let status = query.raw("status").map(str::to_string);
    let rows: Vec<OrganizationInvitationRow> =
        sqlx::query_as("SELECT * FROM organization_invitations WHERE organization_id = $1")
            .bind(&org.id)
            .fetch_all(&state.pool)
            .await?;
    let mut serialized = Vec::with_capacity(rows.len());
    for row in &rows {
        serialized.push(serialize_organization_invitation(&state, row, true, None).await?);
    }
    if let Some(status) = &status {
        serialized.retain(|invitation| status_name(invitation.status) == status);
    }
    if let Some(search) = query.raw("query").filter(|q| !q.is_empty()) {
        serialized.retain(|invitation| invitation.email_address.contains(search));
    }
    sort_rows(
        &mut serialized,
        list.order_by.as_deref().or(Some("-created_at")),
        |invitation, field| match field {
            "created_at" => Some(json!(invitation.created_at)),
            "updated_at" => Some(json!(invitation.updated_at)),
            "email_address" => Some(json!(invitation.email_address)),
            _ => None,
        },
    );
    let (items, total) = page(
        &serialized,
        ListParams {
            limit: list.limit,
            offset: list.offset,
            paginated: true,
        },
    );
    Ok(json_response(list_response(to_value(items)?, total)))
}

fn status_name(status: InvitationStatus) -> &'static str {
    match status {
        InvitationStatus::Pending => "pending",
        InvitationStatus::Accepted => "accepted",
        InvitationStatus::Revoked => "revoked",
        InvitationStatus::Expired => "expired",
    }
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    email_address: String,
    role: Option<String>,
    inviter_user_id: Option<String>,
    redirect_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    notify: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_in_days: Option<i64>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    let email = validate_email(&body.email_address)?;
    let expires_at = resolve_expiry(body.expires_at, body.expires_in_days)?;
    let (invitation, ticket) = create_organization_invitation(
        &state,
        &org,
        &CreateInvitationInput {
            email,
            role_key: body.role.clone(),
            inviter_user_id: body.inviter_user_id.clone(),
            redirect_url: body.redirect_url.clone(),
            public_metadata: body.public_metadata.clone(),
            private_metadata: body.private_metadata.clone(),
            expires_at,
        },
    )
    .await?;
    let notify = body.notify == Some(true);
    if notify {
        notify_invitation(
            &state,
            &org,
            &invitation.email,
            &ticket,
            &invitation.role_key,
        )
        .await;
    }
    let url = if notify {
        None
    } else {
        Some(invitation_url(&state, &ticket))
    };
    Ok(json_response(to_value(
        serialize_organization_invitation(&state, &invitation, true, url.as_deref()).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct BulkBody {
    email_addresses: Vec<String>,
    role: Option<String>,
    inviter_user_id: Option<String>,
    redirect_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    notify: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_in_days: Option<i64>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn bulk(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<BulkBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    if body.email_addresses.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_addresses must contain at least one address",
        )
        .with_meta(json!({ "param_name": "email_addresses" })));
    }
    let expires_at = resolve_expiry(body.expires_at, body.expires_in_days)?;
    let notify = body.notify == Some(true);
    let created = {
        let mut tx = state.pool.begin().await?;
        let mut created = Vec::new();
        for raw in &body.email_addresses {
            let email = validate_email(raw)?;
            let input = CreateInvitationInput {
                email,
                role_key: body.role.clone(),
                inviter_user_id: body.inviter_user_id.clone(),
                redirect_url: body.redirect_url.clone(),
                public_metadata: body.public_metadata.clone(),
                private_metadata: body.private_metadata.clone(),
                expires_at,
            };
            match orbitid_identity::orgs::create_organization_invitation_on(
                &mut tx, &state, &org, &input,
            )
            .await
            {
                Ok(creation) => created.push(creation),
                Err(error) if error.code == error_codes::DUPLICATE_RECORD => continue,
                Err(error) => return Err(error),
            }
        }
        tx.commit().await?;
        created
    };
    let mut out = Vec::with_capacity(created.len());
    for (invitation, ticket) in created {
        if notify {
            notify_invitation(
                &state,
                &org,
                &invitation.email,
                &ticket,
                &invitation.role_key,
            )
            .await;
        }
        let url = if notify {
            None
        } else {
            Some(invitation_url(&state, &ticket))
        };
        out.push(to_value(
            serialize_organization_invitation(&state, &invitation, true, url.as_deref()).await?,
        )?);
    }
    Ok(json_response(serde_json::Value::Array(out)))
}

async fn read(
    State(state): State<AppState>,
    Path((id, inv_id)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let invitation = find_invitation(&state, &org.id, &inv_id).await?;
    Ok(json_response(to_value(
        serialize_organization_invitation(&state, &invitation, true, None).await?,
    )?))
}

async fn revoke(
    State(state): State<AppState>,
    Path((id, inv_id)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let revoked = {
        let mut tx = state.pool.begin().await?;
        // Rank 8 → 9: lock the organization before its invitation rows; the
        // organization deletion cascade takes them in that order.
        sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
            .bind(&org.id)
            .execute(&mut *tx)
            .await?;
        let invitation = sqlx::query_as::<_, OrganizationInvitationRow>(
            "SELECT * FROM organization_invitations \
             WHERE organization_id = $1 AND id = $2 FOR UPDATE",
        )
        .bind(&org.id)
        .bind(&inv_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Organization invitation not found",
            )
        })?;
        let status = status_name(effective_invitation_status(&invitation));
        if status != "pending" {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                format!("Invitation is {status}"),
            ));
        }
        let revoked =
            orbitid_identity::orgs::revoke_organization_invitation_on(&mut tx, &invitation).await?;
        tx.commit().await?;
        revoked
    };
    let value = to_value(serialize_organization_invitation(&state, &revoked, true, None).await?)?;
    Ok(json_response(value))
}

fn validate_email(value: &str) -> Result<String> {
    if value.trim().chars().count() < 3 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_address must be at least 3 characters",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    normalize_email(value)
}

fn resolve_expiry(expires_at: Option<i64>, expires_in_days: Option<i64>) -> Result<Option<i64>> {
    if let Some(days) = expires_in_days {
        if !(1..=365).contains(&days) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "expires_in_days must be between 1 and 365",
            )
            .with_meta(json!({ "param_name": "expires_in_days" })));
        }
    }
    Ok(expires_at.or_else(|| expires_in_days.map(|days| now() + days * 86_400_000)))
}
