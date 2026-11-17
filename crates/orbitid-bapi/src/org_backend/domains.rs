//! Organization domain routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::rate_limit::hit;
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OrganizationDomainRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_domains::{email_domain, find_domain, normalize_domain, normalize_email};
use orbitid_identity::org_serializers::serialize_organization_domain;
use orbitid_identity::org_shared::{page, sort_rows, ListParams};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde::Deserialize;
use serde_json::json;

use super::shared::{deleted, list_response, require_organization};
use crate::shared::{deserialize_bool, json_response, to_value, QueryPairs};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/organizations/{id}/domains", get(list).post(create))
        .route(
            "/v1/organizations/{id}/domains/{did}",
            get(read).patch(update).delete(remove),
        )
        .route(
            "/v1/organizations/{id}/domains/{did}/prepare_affiliation_verification",
            axum::routing::post(prepare_affiliation),
        )
        .route(
            "/v1/organizations/{id}/domains/{did}/attempt_affiliation_verification",
            axum::routing::post(attempt_affiliation),
        )
}

async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let list = query.list()?;
    let rows: Vec<OrganizationDomainRow> =
        sqlx::query_as("SELECT * FROM organization_domains WHERE organization_id = $1")
            .bind(&org.id)
            .fetch_all(&state.pool)
            .await?;
    let mut serialized = Vec::with_capacity(rows.len());
    for row in &rows {
        serialized.push(serialize_organization_domain(&state, row).await?);
    }
    sort_rows(
        &mut serialized,
        list.order_by.as_deref().or(Some("-created_at")),
        |domain, field| match field {
            "created_at" => Some(json!(domain.created_at)),
            "updated_at" => Some(json!(domain.updated_at)),
            "name" => Some(json!(domain.name)),
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

#[derive(Debug, Deserialize)]
struct CreateBody {
    name: String,
    enrollment_mode: Option<String>,
}

fn validate_mode(mode: Option<&str>) -> Result<String> {
    let mode = mode.unwrap_or("manual_invitation");
    if !orbitid_identity::org_domains::is_enrollment_mode(mode) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "enrollment_mode must be manual_invitation, automatic_invitation or automatic_suggestion",
        )
        .with_meta(json!({ "param_name": "enrollment_mode" })));
    }
    Ok(mode.to_string())
}

async fn create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let name = normalize_domain(&body.name)?;
    let mode = validate_mode(body.enrollment_mode.as_deref())?;
    let row = {
        let mut tx = state.pool.begin().await?;
        // Serialize duplicate-domain creates per organization: there is no
        // unique index on (organization_id, name), so the check and insert
        // must hold the organization row (rank 8) before touching domains.
        orbitid_identity::locks::lock_organization_on(&mut tx, &org.id).await?;
        if orbitid_identity::lookups_bapi::find_domain_by_name_on(&mut tx, &org.id, &name)
            .await?
            .is_some()
        {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                format!("{name} is already a domain of this organization"),
            ));
        }
        let id = new_id(id_prefix::DOMAIN);
        sqlx::query(
            "INSERT INTO organization_domains (id, organization_id, name, enrollment_mode, \
             verified, created_at, updated_at) VALUES ($1,$2,$3,$4,false,$5,$5)",
        )
        .bind(&id)
        .bind(&org.id)
        .bind(&name)
        .bind(&mode)
        .bind(now())
        .execute(&mut *tx)
        .await?;
        let row = orbitid_identity::lookups_bapi::find_domain_on(&mut tx, &org.id, &id)
            .await?
            .ok_or_else(|| OrbitError::internal("Created domain is missing"))?;
        orbitid_identity::orgs::emit_domain_event_on(&mut tx, "organizationDomain.created", &row)
            .await?;
        tx.commit().await?;
        row
    };
    Ok(json_response(to_value(
        serialize_organization_domain(&state, &row).await?,
    )?))
}

async fn read(
    State(state): State<AppState>,
    Path((id, did)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let row = find_domain(&state, &org.id, &did).await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization domain not found",
        ));
    };
    Ok(json_response(to_value(
        serialize_organization_domain(&state, &row).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    enrollment_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool")]
    delete_pending: bool,
}

async fn update(
    State(state): State<AppState>,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let mode = match body.enrollment_mode.as_deref() {
        Some(mode) => Some(validate_mode(Some(mode))?),
        None => None,
    };
    let updated = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::lookups_bapi::find_domain_on(&mut tx, &org.id, &did)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "Organization domain not found",
                )
            })?;
        // Rank 8 before the domain update and its invitation deletes (rank 9).
        // Automatic enrollment is not part of this transaction: it runs in
        // short per-chunk transactions after the commit (users → organization
        // each time), so this one never holds a user key-share.
        orbitid_identity::locks::lock_organization_on(&mut tx, &org.id).await?;
        // Re-read the domain under its own lock (rank 9) so an omitted mode
        // keeps the value another transaction just wrote instead of the copy
        // read before the organization lock.
        let row = sqlx::query_as::<_, OrganizationDomainRow>(
            "SELECT * FROM organization_domains \
             WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        )
        .bind(&row.id)
        .bind(&org.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Organization domain not found",
            )
        })?;
        let target = mode.unwrap_or_else(|| row.enrollment_mode.clone());
        let updated = orbitid_identity::org_domains::set_domain_enrollment_mode_on(
            &mut tx,
            &state,
            &row,
            &target,
            body.delete_pending,
        )
        .await?;
        orbitid_identity::orgs::emit_domain_event_on(
            &mut tx,
            "organizationDomain.updated",
            &updated,
        )
        .await?;
        tx.commit().await?;
        updated
    };
    orbitid_identity::orgs::kick_domain_enrollment(&state, &updated).await;
    Ok(json_response(to_value(
        serialize_organization_domain(&state, &updated).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct PrepareBody {
    affiliation_email_address: String,
}

async fn prepare_affiliation(
    State(state): State<AppState>,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<PrepareBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let domain = find_domain(&state, &org.id, &did).await?;
    let Some(domain) = domain else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Organization domain not found",
        ));
    };
    if body.affiliation_email_address.trim().chars().count() < 3 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "affiliation_email_address must be at least 3 characters",
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
    // Per-recipient throttle: resending stays possible after the window.
    hit(
        &state,
        &format!("org_domain_affiliation:{email}"),
        5,
        60_000,
    )
    .await?;
    let settings = state.settings.get();
    let (updated, code) = {
        let mut tx = state.pool.begin().await?;
        let current = orbitid_identity::lookups_bapi::find_domain_on(&mut tx, &org.id, &domain.id)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "Organization domain not found",
                )
            })?;
        let (updated, code) = orbitid_identity::org_domains::prepare_domain_affiliation_on(
            &mut tx, &state, &current, &email,
        )
        .await?;
        tx.commit().await?;
        (updated, code)
    };
    let mut vars = serde_json::Map::new();
    vars.insert("code".into(), json!(code));
    vars.insert("domain".into(), json!(domain.name));
    vars.insert("organization_name".into(), json!(org.name));
    vars.insert(
        "expires_in_minutes".into(),
        json!((settings.email.code_lifetime_seconds + 59) / 60),
    );
    send_email(
        &state,
        SendEmailInput {
            to: email,
            template: EmailTemplate::DomainVerificationCode,
            vars,
        },
    )
    .await;
    Ok(json_response(to_value(
        serialize_organization_domain(&state, &updated).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct AttemptBody {
    code: String,
}

async fn attempt_affiliation(
    State(state): State<AppState>,
    Path((id, did)): Path<(String, String)>,
    OrbitJson(body): OrbitJson<AttemptBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let updated = {
        let mut tx = state.pool.begin().await?;
        let domain = orbitid_identity::lookups_bapi::find_domain_on(&mut tx, &org.id, &did)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "Organization domain not found",
                )
            })?;
        let latest: Option<(i64, i64)> = sqlx::query_as(
            "SELECT attempts, max_attempts FROM verifications WHERE owner_id = $1 \
             AND purpose = 'org_domain' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(&domain.id)
        .fetch_optional(&mut *tx)
        .await?;
        if latest
            .map(|(attempts, max)| attempts >= max)
            .unwrap_or(false)
        {
            tx.commit().await?;
            return Err(OrbitError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                error_codes::TOO_MANY_ATTEMPTS,
                "Too many attempts. Request a new code.",
            ));
        }
        let attempt = {
            // Lock rank 6 (the affiliation verification) → 8 (the organization)
            // before the code check. Automatic enrollment runs after the commit.
            orbitid_identity::org_domains::lock_latest_domain_verification_on(&mut tx, &domain.id)
                .await?;
            orbitid_identity::locks::lock_organization_on(&mut tx, &org.id).await?;
            orbitid_identity::org_domains::attempt_domain_affiliation_on(
                &mut tx,
                &state,
                &domain,
                body.code.trim(),
            )
            .await?
        };
        let updated = match attempt {
            orbitid_identity::org_domains::DomainAttempt::Verified(updated) => updated,
            // A wrong code is an application refusal, not a database failure:
            // the attempt counter it incremented must still commit, otherwise
            // brute-force protection resets on every request.
            orbitid_identity::org_domains::DomainAttempt::Refused(refusal) => {
                return Err(
                    orbitid_identity::verifications::commit_code_refusal(tx, refusal).await?,
                );
            }
        };
        orbitid_identity::orgs::emit_domain_event_on(
            &mut tx,
            "organizationDomain.updated",
            &updated,
        )
        .await?;
        tx.commit().await?;
        updated
    };
    orbitid_identity::orgs::kick_domain_enrollment(&state, &updated).await;
    Ok(json_response(to_value(
        serialize_organization_domain(&state, &updated).await?,
    )?))
}

async fn remove(
    State(state): State<AppState>,
    Path((id, did)): Path<(String, String)>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let row = {
        let mut tx = state.pool.begin().await?;
        let row = orbitid_identity::lookups_bapi::find_domain_on(&mut tx, &org.id, &did)
            .await?
            .ok_or_else(|| {
                OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "Organization domain not found",
                )
            })?;
        let payload = to_value(
            orbitid_identity::org_serializers::serialize_organization_domain_on(&mut tx, &row)
                .await?,
        )?;
        sqlx::query("DELETE FROM organization_domains WHERE id = $1")
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "organizationDomain.deleted", payload)
            .await?;
        tx.commit().await?;
        row
    };
    Ok(json_response(deleted("organization_domain", &row.id)))
}
