//! Organization domain and affiliation routes (`modules/org-client/domains.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OrganizationDomainRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::{
    attempt_domain_affiliation_on, email_domain, find_domain, is_enrollment_mode, normalize_domain,
    normalize_email, prepare_domain_affiliation_on, set_domain_enrollment_mode_on, DomainAttempt,
};
use orbitid_identity::org_serializers::{
    serialize_organization_domain, serialize_organization_domain_on,
};
use orbitid_identity::org_shared::require_domains_enabled;
use orbitid_identity::orgs::{emit_domain_event_on, kick_domain_enrollment};
use orbitid_identity::rbac::{DOMAINS_MANAGE, DOMAINS_READ};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde::Deserialize;
use serde_json::json;

use crate::reply::json_reply;

use super::org_access_for;

#[derive(Debug, Deserialize)]
pub struct DomainCreateBody {
    pub name: String,
    #[serde(default)]
    pub enrollment_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AffiliationEmailBody {
    pub affiliation_email_address: String,
}

#[derive(Debug, Deserialize)]
pub struct AffiliationCodeBody {
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct EnrollmentModeBody {
    pub enrollment_mode: String,
    #[serde(default)]
    pub delete_pending: Option<bool>,
}

async fn require_domain(
    state: &AppState,
    org_id: &str,
    did: &str,
) -> Result<OrganizationDomainRow> {
    find_domain(state, org_id, did).await?.ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization domain not found",
        )
    })
}

pub async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_READ)).await?;
    require_domains_enabled(&state)?;
    let rows = sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE organization_id = $1",
    )
    .bind(&found.access.org.id)
    .fetch_all(&state.pool)
    .await?;
    let mut serialized = Vec::with_capacity(rows.len());
    for row in &rows {
        serialized.push(
            serde_json::to_value(serialize_organization_domain(&state, row).await?)
                .unwrap_or_default(),
        );
    }
    Ok(json_reply(super::fapi_list(&uri, serialized), Vec::new()))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<DomainCreateBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_MANAGE)).await?;
    require_domains_enabled(&state)?;
    if body.name.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "name: must be at least 1 character",
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    if let Some(mode) = &body.enrollment_mode {
        if !is_enrollment_mode(mode) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "enrollment_mode: unknown value",
            )
            .with_meta(json!({ "param_name": "enrollment_mode" })));
        }
    }
    let name = normalize_domain(&body.name)?;
    let enrollment_mode = body
        .enrollment_mode
        .clone()
        .unwrap_or_else(|| "manual_invitation".to_string());
    let now_ms = now();
    let id = new_id(id_prefix::DOMAIN);
    // No unique index guards (organization, name); lock the organization row so
    // the duplicate check and the insert cannot race.
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(&found.access.org.id)
        .execute(&mut *tx)
        .await?;
    let duplicate: Option<String> = sqlx::query_scalar(
        "SELECT id FROM organization_domains WHERE organization_id = $1 AND name = $2",
    )
    .bind(&found.access.org.id)
    .bind(&name)
    .fetch_optional(&mut *tx)
    .await?;
    if duplicate.is_some() {
        return Err(OrbitError::conflict(
            error_codes::DUPLICATE_RECORD,
            format!("{name} is already a domain of this organization"),
        ));
    }
    let row = sqlx::query_as::<_, OrganizationDomainRow>(
        "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, verified, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,false,$5,$5) RETURNING *",
    )
    .bind(&id)
    .bind(&found.access.org.id)
    .bind(&name)
    .bind(&enrollment_mode)
    .bind(now_ms)
    .fetch_one(&mut *tx)
    .await?;
    emit_domain_event_on(&mut tx, "organizationDomain.created", &row).await?;
    tx.commit().await?;
    let payload = serialize_organization_domain(&state, &row).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, did)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_READ)).await?;
    require_domains_enabled(&state)?;
    let row = require_domain(&state, &found.access.org.id, &did).await?;
    let payload = serialize_organization_domain(&state, &row).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, did)): Path<(String, String)>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_MANAGE)).await?;
    require_domains_enabled(&state)?;
    let row = require_domain(&state, &found.access.org.id, &did).await?;
    let mut tx = state.pool.begin().await?;
    let payload = serde_json::to_value(serialize_organization_domain_on(&mut tx, &row).await?)
        .unwrap_or_default();
    sqlx::query("DELETE FROM organization_domains WHERE id = $1")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organizationDomain.deleted", payload)
        .await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": { "object": "organization_domain", "id": row.id, "deleted": true } }),
        Vec::new(),
    ))
}

pub async fn prepare_affiliation_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<AffiliationEmailBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_MANAGE)).await?;
    require_domains_enabled(&state)?;
    let domain = require_domain(&state, &found.access.org.id, &did).await?;
    if body.affiliation_email_address.len() < 3 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "affiliation_email_address: must be at least 3 characters",
        )
        .with_meta(json!({ "param_name": "affiliation_email_address" })));
    }
    let email = normalize_email(&body.affiliation_email_address)?;
    if email_domain(&email) != domain.name {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("Affiliation email address must belong to {}", domain.name),
        )
        .with_meta(json!({ "param_name": "affiliation_email_address" })));
    }
    let settings = state.settings.get();
    // Issuing the code and recording the affiliation address commit together.
    let mut tx = state.pool.begin().await?;
    let (updated, code) = prepare_domain_affiliation_on(&mut tx, &state, &domain, &email).await?;
    tx.commit().await?;
    // Delivery is post-commit best-effort.
    send_email(
        &state,
        SendEmailInput::new(email, EmailTemplate::DomainVerificationCode)
            .with_var("code", code)
            .with_var("domain", domain.name.clone())
            .with_var("organization_name", found.access.org.name.clone())
            .with_var(
                "expires_in_minutes",
                ((settings.email.code_lifetime_seconds as f64) / 60.0).round() as i64,
            ),
    )
    .await;
    let payload = serialize_organization_domain(&state, &updated).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn attempt_affiliation_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<AffiliationCodeBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_MANAGE)).await?;
    require_domains_enabled(&state)?;
    let domain = require_domain(&state, &found.access.org.id, &did).await?;
    if body.code.trim().is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "code: must be at least 1 character",
        )
        .with_meta(json!({ "param_name": "code" })));
    }
    // The attempt counter, the verified code and the domain flag commit
    // together; automatic enrollment joins the same transaction.
    let mut tx = state.pool.begin().await?;
    // Rank 6 (affiliation verification) → 8 (organization) before the code
    // check. Automatic enrollment runs after the commit, in per-chunk
    // transactions (users → organization each time).
    orbitid_identity::org_domains::lock_latest_domain_verification_on(&mut tx, &domain.id).await?;
    orbitid_identity::locks::lock_organization_on(&mut tx, &found.access.org.id).await?;
    let updated = match attempt_domain_affiliation_on(&mut tx, &state, &domain, body.code.trim())
        .await?
    {
        DomainAttempt::Verified(updated) => updated,
        // A wrong/expired guess counts an attempt that must survive.
        DomainAttempt::Refused(refusal) => {
            return Err(orbitid_identity::verifications::commit_code_refusal(tx, refusal).await?);
        }
    };
    emit_domain_event_on(&mut tx, "organizationDomain.updated", &updated).await?;
    tx.commit().await?;
    kick_domain_enrollment(&state, &updated).await;
    let payload = serialize_organization_domain(&state, &updated).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn update_enrollment_mode(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<EnrollmentModeBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(DOMAINS_MANAGE)).await?;
    require_domains_enabled(&state)?;
    let domain = require_domain(&state, &found.access.org.id, &did).await?;
    if !is_enrollment_mode(&body.enrollment_mode) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "enrollment_mode: unknown value",
        )
        .with_meta(json!({ "param_name": "enrollment_mode" })));
    }
    // The mode flip, pending-invitation revocations (with their events),
    // automatic enrollment and the domain event commit together.
    let mut tx = state.pool.begin().await?;
    // Rank 8 (organization) before the mode flip and its invitation deletes
    // (rank 9); automatic enrollment runs after the commit.
    orbitid_identity::locks::lock_organization_on(&mut tx, &found.access.org.id).await?;
    let updated = set_domain_enrollment_mode_on(
        &mut tx,
        &state,
        &domain,
        &body.enrollment_mode,
        body.delete_pending == Some(true),
    )
    .await?;
    emit_domain_event_on(&mut tx, "organizationDomain.updated", &updated).await?;
    tx.commit().await?;
    kick_domain_enrollment(&state, &updated).await;
    let payload = serialize_organization_domain(&state, &updated).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}
