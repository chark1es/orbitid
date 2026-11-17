//! Organization logo routes (`PUT`/`DELETE /v1/organizations/:id/logo`).

use axum::extract::{Path, Request, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::OrganizationRow;
use orbitid_core::state::AppState;
use orbitid_identity::serializers::serialize_organization;

use super::assets::{read_logo_payload, store_logo_on};
use super::shared::require_organization;
use crate::shared::{json_response, to_value};

pub(super) async fn update_logo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: Request,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
    let (data, mime) = read_logo_payload(&state, request).await?;
    let updated = {
        let mut tx = state.pool.begin().await?;
        // Read the row under the lock so the upload row this call replaces is
        // the current pointer, not a value read before the transaction.
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
        let file = store_logo_on(&mut tx, &current.id, &data, &mime).await?;
        let image_url = format!(
            "{}/v1/client/organization_logos/{}",
            state.env.base_url, file
        );
        sqlx::query(
            "UPDATE organizations SET image_url = $1, has_image = true, updated_at = $2 WHERE id = $3",
        )
        .bind(&image_url)
        .bind(now())
        .bind(&current.id)
        .execute(&mut *tx)
        .await?;
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
        orbitid_identity::uploads::delete_upload_by_url_on(
            &mut tx,
            orbitid_identity::uploads::LOGO_BUCKET,
            orbitid_identity::uploads::LOGO_MARKER,
            current.image_url.as_deref(),
        )
        .await?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(
        serialize_organization(&state, &updated, true, true).await?,
    )?))
}

pub(super) async fn remove_logo(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let org = require_organization(&state, &id).await?;
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
        sqlx::query(
            "UPDATE organizations SET image_url = NULL, has_image = false, updated_at = $1 \
             WHERE id = $2",
        )
        .bind(now())
        .bind(&current.id)
        .execute(&mut *tx)
        .await?;
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
        orbitid_identity::uploads::delete_upload_by_url_on(
            &mut tx,
            orbitid_identity::uploads::LOGO_BUCKET,
            orbitid_identity::uploads::LOGO_MARKER,
            current.image_url.as_deref(),
        )
        .await?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(
        serialize_organization(&state, &updated, true, true).await?,
    )?))
}
