//! Organization CRUD and logo routes (`modules/org-client/organizations.ts`).

use axum::extract::{Path, Request, State};
use axum::http::HeaderMap;
use axum::http::Uri;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OrganizationRow;
use orbitid_core::state::AppState;
use orbitid_identity::org_shared::{require_organizations_enabled, resolve_slug};
use orbitid_identity::orgs::{assert_can_create_organization, creator_role_key};
use orbitid_identity::rbac::{PROFILE_DELETE, PROFILE_MANAGE};
use orbitid_identity::serializers::{serialize_organization, serialize_organization_on};
use orbitid_platform::images::assert_image_bytes;
use serde::Deserialize;
use serde_json::json;

use crate::reply::json_reply;
use crate::uploads;
use crate::util::deleted_object;

use super::org_access_for;

#[derive(Debug, Default, Deserialize)]
pub struct OrganizationBody {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
}

fn required_name(value: Option<&str>) -> Result<String> {
    let Some(value) = value else {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "name is required")
                .with_meta(json!({ "param_name": "name" })),
        );
    };
    let name = value.trim().to_string();
    if name.is_empty() || name.chars().count() > 256 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "name: must be 1-256 characters",
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    Ok(name)
}

fn optional_slug(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    let slug = value.trim();
    if slug.is_empty() || slug.chars().count() > 50 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "slug: must be 1-50 characters",
        )
        .with_meta(json!({ "param_name": "slug" })));
    }
    Ok(Some(slug.to_string()))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    OrbitJson(body): OrbitJson<OrganizationBody>,
) -> Result<Response> {
    require_organizations_enabled(&state)?;
    let caller = super::caller_for(&state, &uri, &headers).await?;
    assert_can_create_organization(&state, &caller.user).await?;
    let name = required_name(body.name.as_deref())?;
    let requested_slug = optional_slug(body.slug.as_deref())?;
    let settings = state.settings.get();
    let now_ms = now();
    let id = new_id(id_prefix::ORG);
    let slug = resolve_slug(
        &state,
        if settings.organizations.slug_enabled {
            requested_slug.as_deref()
        } else {
            None
        },
        &name,
        None,
    )
    .await?;
    let role_key = creator_role_key(&state).await?;
    let mut tx = state.pool.begin().await?;
    // The organization's `created_by` and the creator membership both reference
    // the user (rank 3): lock it before the organization insert, then the new
    // organization row (rank 8) before its membership.
    orbitid_identity::locks::key_share_user_on(&mut tx, &caller.user_id).await?;
    sqlx::query(
        "INSERT INTO organizations (id, name, slug, has_image, max_allowed_memberships, \
         admin_delete_enabled, public_metadata, private_metadata, created_by, created_at, \
         updated_at) VALUES ($1,$2,$3,false,$4,$5,'{}','{}',$6,$7,$7)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&slug)
    .bind(settings.organizations.max_allowed_memberships)
    .bind(settings.organizations.admin_delete_enabled)
    .bind(&caller.user_id)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;
    let org = sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let lock = orbitid_identity::locks::lock_membership_write_on(
        &mut tx,
        std::slice::from_ref(&caller.user_id),
        std::slice::from_ref(&org.id),
    )
    .await?;
    orbitid_identity::orgs::add_membership_on(
        &mut tx,
        &state,
        &lock,
        &org.id,
        &caller.user_id,
        &role_key,
        None,
        None,
    )
    .await?;
    let payload = serialize_organization_on(&mut tx, &org, true, true).await?;
    let payload = serde_json::to_value(payload).unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.created", payload.clone())
        .await?;
    tx.commit().await?;
    let response = serialize_organization(&state, &org, false, true).await?;
    Ok(json_reply(json!({ "response": response }), Vec::new()))
}

pub async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, None).await?;
    let payload = serialize_organization(&state, &found.access.org, false, true).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<OrganizationBody>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(PROFILE_MANAGE)).await?;
    let org = found.access.org;
    let name = match body.name.as_deref() {
        Some(value) => Some(required_name(Some(value))?),
        None => None,
    };
    let requested_slug = optional_slug(body.slug.as_deref())?;
    let settings = state.settings.get();
    let resolved_slug = match &requested_slug {
        Some(requested) if settings.organizations.slug_enabled => {
            let fallback = name.as_deref().unwrap_or(&org.name);
            Some(resolve_slug(&state, Some(requested), fallback, Some(&org.id)).await?)
        }
        _ => None,
    };
    let mut tx = state.pool.begin().await?;
    // Use the row read under the lock for every field the request does not
    // replace: a concurrent PATCH that changed the name or slug must not be
    // clobbered by the pre-transaction copy.
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
    let next_name = name.unwrap_or_else(|| current.name.clone());
    let next_slug = resolved_slug.or_else(|| current.slug.clone());
    let result = sqlx::query_as::<_, OrganizationRow>(
        "UPDATE organizations SET name = $1, slug = $2, updated_at = $3 WHERE id = $4 \
         RETURNING *",
    )
    .bind(&next_name)
    .bind(&next_slug)
    .bind(now())
    .bind(&current.id)
    .fetch_one(&mut *tx)
    .await;
    let updated = match result {
        Ok(updated) => updated,
        Err(error) => {
            return Err(orbitid_identity::org_shared::map_slug_violation(
                error,
                next_slug.as_deref().unwrap_or_default(),
            ))
        }
    };
    let payload =
        serde_json::to_value(serialize_organization_on(&mut tx, &updated, true, true).await?)
            .unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.updated", payload).await?;
    tx.commit().await?;
    let payload = serialize_organization(&state, &updated, false, true).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(PROFILE_DELETE)).await?;
    let org = found.access.org;
    if !org.admin_delete_enabled {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Deleting this organization is disabled for admins",
        ));
    }
    // The deletion, every membership, the affected members' grant revocations,
    // the logo upload rows and its event commit in one transaction.
    orbitid_identity::orgs::delete_organization(&state, &org.id).await?;
    Ok(json_reply(
        json!({ "response": deleted_object("organization", &org.id) }),
        Vec::new(),
    ))
}

pub async fn upload_logo(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(PROFILE_MANAGE)).await?;
    let org = found.access.org;
    let content_type = crate::util::header(&headers, "content-type").unwrap_or_default();
    let bytes = axum::body::to_bytes(request.into_body(), uploads::MAX_IMAGE_BYTES + 64 * 1024)
        .await
        .map_err(|_| {
            OrbitError::new(
                axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "Logo must be smaller than 5MB",
            )
        })?;
    let bytes = if content_type
        .to_ascii_lowercase()
        .contains("multipart/form-data")
    {
        uploads::logo_from_multipart(&content_type, &headers, &bytes)?.bytes
    } else {
        let value = orbitid_core::http::json::parse_request_body(
            &headers,
            axum::body::Body::from(bytes),
            orbitid_core::http::MAX_JSON_BYTES,
        )
        .await?;
        uploads::logo_from_json_value(&value)?.bytes
    };
    let kind = assert_image_bytes(&bytes, "file")?;
    // The upload row, the organization pointer, the replaced file's deletion
    // and `organization.updated` commit together.
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
    let file = uploads::random_image_name(&current.id, kind);
    let image_url = format!(
        "{}/v1/client/organization_logos/{}",
        state.env.base_url, file
    );
    uploads::store_upload_on(
        &mut tx,
        uploads::LOGO_BUCKET,
        &current.id,
        &file,
        kind.content_type(),
        &bytes,
    )
    .await?;
    let updated = sqlx::query_as::<_, OrganizationRow>(
        "UPDATE organizations SET image_url = $1, has_image = true, updated_at = $2 \
         WHERE id = $3 RETURNING *",
    )
    .bind(&image_url)
    .bind(now())
    .bind(&current.id)
    .fetch_one(&mut *tx)
    .await?;
    let payload =
        serde_json::to_value(serialize_organization_on(&mut tx, &updated, true, true).await?)
            .unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.updated", payload).await?;
    orbitid_identity::uploads::delete_upload_by_url_on(
        &mut tx,
        uploads::LOGO_BUCKET,
        uploads::LOGO_MARKER,
        current.image_url.as_deref(),
    )
    .await?;
    tx.commit().await?;
    let payload = serialize_organization(&state, &updated, false, true).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}

pub async fn delete_logo(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> Result<Response> {
    let found = org_access_for(&state, &uri, &headers, &id, Some(PROFILE_MANAGE)).await?;
    let org = found.access.org;
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
    let updated = sqlx::query_as::<_, OrganizationRow>(
        "UPDATE organizations SET image_url = NULL, has_image = false, updated_at = $1 \
         WHERE id = $2 RETURNING *",
    )
    .bind(now())
    .bind(&current.id)
    .fetch_one(&mut *tx)
    .await?;
    let payload =
        serde_json::to_value(serialize_organization_on(&mut tx, &updated, true, true).await?)
            .unwrap_or_default();
    orbitid_platform::webhooks::emit_event_on(&mut tx, "organization.updated", payload).await?;
    orbitid_identity::uploads::delete_upload_by_url_on(
        &mut tx,
        uploads::LOGO_BUCKET,
        uploads::LOGO_MARKER,
        current.image_url.as_deref(),
    )
    .await?;
    tx.commit().await?;
    let payload = serialize_organization(&state, &updated, false, true).await?;
    Ok(json_reply(json!({ "response": payload }), Vec::new()))
}
