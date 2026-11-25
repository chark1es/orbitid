//! Organization CRUD, logo and metadata routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OrganizationRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::orgs::creator_role_key;
use orbitid_identity::serializers::{serialize_organization, serialize_organizations};
use serde::Deserialize;
use serde_json::json;

use super::shared::{deleted, merge_metadata, require_organization, resolve_slug};
use crate::shared::{
    deserialize_opt_bool, fetch_all, fetch_count, json_response, order_clause, paginated, to_value,
    validate_metadata, Bind, QueryPairs,
};

const ORG_ORDER_COLUMNS: &[(&str, &str)] = &[
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
    ("name", "name"),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/organizations", get(list).post(create))
        .route(
            "/v1/organizations/{id}",
            get(read).patch(update).delete(remove),
        )
        .route(
            "/v1/organizations/{id}/metadata",
            axum::routing::patch(update_metadata),
        )
        .route(
            "/v1/organizations/{id}/logo",
            axum::routing::put(super::organization_logo::update_logo)
                .delete(super::organization_logo::remove_logo),
        )
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut filter = crate::shared::Where::new();
    let mut ids = query.values("organization_ids");
    ids.extend(query.values("organization_ids[]"));
    if !ids.is_empty() {
        filter.one_of_text("id", &ids);
    }
    if let Some(search) = query.raw("query").map(str::trim).filter(|q| !q.is_empty()) {
        let slot = filter.bind_text(orbitid_core::db::helpers::contains_pattern(search));
        filter.clauses.push(format!(
            "(lower(id) LIKE {slot} ESCAPE '\\' OR lower(name) LIKE {slot} ESCAPE '\\' \
             OR lower(coalesce(slug, '')) LIKE {slot} ESCAPE '\\')"
        ));
    }
    let order = order_clause(list.order_by.as_deref(), ORG_ORDER_COLUMNS, "-created_at");
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM organizations{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<OrganizationRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM organizations{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let counts = query.raw("include_members_count") != Some("false");
    let data = serialize_organizations(&state, &rows, true, counts).await?;
    Ok(json_response(paginated(to_value(data)?, total)))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    name: String,
    slug: Option<String>,
    created_by: Option<String>,
    #[serde(default, deserialize_with = "crate::shared::deserialize_opt_int")]
    max_allowed_memberships: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    admin_delete_enabled: Option<bool>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    /// External billing portal (absolute https URL); `null` or omitted for none.
    #[serde(
        default,
        deserialize_with = "crate::shared::deserialize_opt_nullable_string"
    )]
    billing_portal_url: Option<Option<String>>,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let name = validate_name(&body.name)?;
    let slug = validate_slug(body.slug.as_deref())?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    if let Some(created_by) = &body.created_by {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
            .bind(created_by)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(
                OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found")
                    .with_meta(json!({ "param_name": "created_by" })),
            );
        }
    }
    if let Some(max) = body.max_allowed_memberships {
        if max < 1 {
            return Err(invalid_param(
                "max_allowed_memberships",
                "max_allowed_memberships must be at least 1",
            ));
        }
    }
    let billing_portal_url = orbitid_identity::billing::validate_billing_portal_url(
        &state,
        body.billing_portal_url
            .as_ref()
            .and_then(|url| url.as_deref()),
        "billing_portal_url",
    )
    .await?;
    let settings = state.settings.get();
    let now_ms = now();
    let id = new_id(id_prefix::ORG);
    let slug = resolve_slug(&state, slug.as_deref(), &name, None).await?;
    let creator_role = match &body.created_by {
        Some(_) => Some(creator_role_key(&state).await?),
        None => None,
    };
    let mut tx = state.pool.begin().await?;
    // The organization's `created_by` and the creator membership both reference
    // the user (rank 3): take the key-share lock before inserting the
    // organization, then the new organization row (rank 8) before its
    // membership.
    if let Some(created_by) = &body.created_by {
        orbitid_identity::locks::key_share_user_on(&mut tx, created_by).await?;
    }
    let row: OrganizationRow = sqlx::query_as(
        "INSERT INTO organizations (id, name, slug, max_allowed_memberships, \
         admin_delete_enabled, public_metadata, private_metadata, created_by, created_at, \
         updated_at, billing_portal_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) RETURNING *",
    )
    .bind(&id)
    .bind(&name)
    .bind(&slug)
    .bind(
        body.max_allowed_memberships
            .unwrap_or(settings.organizations.max_allowed_memberships),
    )
    .bind(
        body.admin_delete_enabled
            .unwrap_or(settings.organizations.admin_delete_enabled),
    )
    .bind(sqlx::types::Json(
        body.public_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        body.private_metadata.clone().unwrap_or_default(),
    ))
    .bind(&body.created_by)
    .bind(now_ms)
    .bind(&billing_portal_url)
    .fetch_one(&mut *tx)
    .await?;
    // The creator's membership and both event rows commit with the organization:
    // a failure can never leave an organization without its creator (or an
    // event announcing a half-created organization).
    if let (Some(created_by), Some(role_key)) = (&body.created_by, &creator_role) {
        let lock = orbitid_identity::locks::lock_membership_write_on(
            &mut tx,
            std::slice::from_ref(created_by),
            std::slice::from_ref(&row.id),
        )
        .await?;
        orbitid_identity::orgs::add_membership_on(
            &mut tx, &state, &lock, &row.id, created_by, role_key, None, None,
        )
        .await?;
    }
    let payload = to_value(
        &orbitid_identity::serializers::serialize_organization_on(&mut tx, &row, true, true)
            .await?,
    )?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.created", payload.clone())
        .await?;
    tx.commit().await?;
    Ok(json_response(payload))
}

fn validate_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 256 {
        return Err(invalid_param("name", "name must be 1-256 characters"));
    }
    Ok(name.to_string())
}

fn validate_slug(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let slug = value.trim();
    if slug.is_empty() || slug.chars().count() > 50 {
        return Err(invalid_param("slug", "slug must be 1-50 characters"));
    }
    Ok(Some(slug.to_string()))
}

fn invalid_param(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    Ok(json_response(to_value(
        serialize_organization(&state, &org, true, true).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    name: Option<String>,
    slug: Option<String>,
    #[serde(default, deserialize_with = "crate::shared::deserialize_opt_int")]
    max_allowed_memberships: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    admin_delete_enabled: Option<bool>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    /// `null` or `""` clears the billing portal; omitted leaves it unchanged.
    #[serde(
        default,
        deserialize_with = "crate::shared::deserialize_opt_nullable_string"
    )]
    billing_portal_url: Option<Option<String>>,
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let name = match &body.name {
        Some(name) => Some(validate_name(name)?),
        None => None,
    };
    let slug = validate_slug(body.slug.as_deref())?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    if let Some(max) = body.max_allowed_memberships {
        if max < 1 {
            return Err(invalid_param(
                "max_allowed_memberships",
                "max_allowed_memberships must be at least 1",
            ));
        }
    }
    let billing_portal_url = match &body.billing_portal_url {
        Some(url) => Some(
            orbitid_identity::billing::validate_billing_portal_url(
                &state,
                url.as_deref(),
                "billing_portal_url",
            )
            .await?,
        ),
        None => None,
    };
    let resolved_slug = match slug {
        Some(requested) => Some(
            resolve_slug(
                &state,
                Some(&requested),
                name.as_deref().unwrap_or(&org.name),
                Some(&org.id),
            )
            .await?,
        ),
        None => None,
    };
    let updated = {
        let mut tx = state.pool.begin().await?;
        let current = sqlx::query_as::<_, OrganizationRow>(
            "SELECT * FROM organizations WHERE id = $1 FOR UPDATE",
        )
        .bind(&org.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
        // Merge metadata from the row read under the lock, never from the
        // pre-transaction copy: two concurrent PATCHes must keep both keys.
        let public = body
            .public_metadata
            .as_ref()
            .map(|patch| merge_metadata(Some(&current.public_metadata.0), Some(patch)))
            .unwrap_or_else(|| current.public_metadata.0.clone());
        let private = body
            .private_metadata
            .as_ref()
            .map(|patch| merge_metadata(Some(&current.private_metadata.0), Some(patch)))
            .unwrap_or_else(|| current.private_metadata.0.clone());
        let next_slug = resolved_slug.as_deref().or(current.slug.as_deref());
        let result = sqlx::query(
            "UPDATE organizations SET name = $1, slug = $2, max_allowed_memberships = $3, \
             admin_delete_enabled = $4, public_metadata = $5, private_metadata = $6, updated_at = $7, \
             billing_portal_url = $9 WHERE id = $8",
        )
        .bind(name.as_deref().unwrap_or(&current.name))
        .bind(next_slug)
        .bind(
            body.max_allowed_memberships
                .unwrap_or(current.max_allowed_memberships),
        )
        .bind(
            body.admin_delete_enabled
                .unwrap_or(current.admin_delete_enabled),
        )
        .bind(sqlx::types::Json(public))
        .bind(sqlx::types::Json(private))
        .bind(now())
        .bind(&current.id)
        .bind(
            billing_portal_url
                .clone()
                .unwrap_or_else(|| current.billing_portal_url.clone()),
        )
        .execute(&mut *tx)
        .await;
        if let Err(error) = result {
            return Err(orbitid_identity::org_shared::map_slug_violation(
                error,
                next_slug.unwrap_or_default(),
            ));
        }
        let updated =
            sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
        let payload = to_value(
            &orbitid_identity::serializers::serialize_organization_on(
                &mut tx, &updated, true, true,
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.updated", payload).await?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(
        serialize_organization(&state, &updated, true, true).await?,
    )?))
}

#[derive(Debug, Deserialize)]
struct MetadataBody {
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
}

async fn update_metadata(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<MetadataBody>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    for metadata in [&body.public_metadata, &body.private_metadata]
        .into_iter()
        .flatten()
    {
        validate_metadata(metadata)?;
    }
    let updated = {
        let mut tx = state.pool.begin().await?;
        let current = sqlx::query_as::<_, OrganizationRow>(
            "SELECT * FROM organizations WHERE id = $1 FOR UPDATE",
        )
        .bind(&org.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::ORGANIZATION_NOT_FOUND,
                "Organization not found",
            )
        })?;
        let public = merge_metadata(
            Some(&current.public_metadata.0),
            body.public_metadata.as_ref(),
        );
        let private = merge_metadata(
            Some(&current.private_metadata.0),
            body.private_metadata.as_ref(),
        );
        sqlx::query(
            "UPDATE organizations SET public_metadata = $1, private_metadata = $2, updated_at = $3 \
             WHERE id = $4",
        )
        .bind(sqlx::types::Json(public))
        .bind(sqlx::types::Json(private))
        .bind(now())
        .bind(&org.id)
        .execute(&mut *tx)
        .await?;
        let updated =
            sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
                .bind(&org.id)
                .fetch_one(&mut *tx)
                .await?;
        let payload = to_value(
            &orbitid_identity::serializers::serialize_organization_on(
                &mut tx, &updated, true, true,
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.updated", payload).await?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(
        serialize_organization(&state, &updated, true, true).await?,
    )?))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    // Same helper as the Frontend API: one transaction per attempt, retried on
    // a retryable `transaction_conflict` (a member joined meanwhile).
    let deleted_org = orbitid_identity::orgs::delete_organization(&state, &id).await?;
    let Some(deleted_org) = deleted_org else {
        return Err(OrbitError::not_found(
            error_codes::ORGANIZATION_NOT_FOUND,
            "Organization not found",
        ));
    };
    // The member grant revocation and the logo upload rows are part of
    // `delete_organization_on`'s transaction.
    Ok(json_response(deleted(
        "organization",
        &deleted_org.organization.id,
    )))
}
