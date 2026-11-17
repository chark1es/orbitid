use orbitid_core::crypto::sha256;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;

use crate::services::oidc::shared::{
    LIFETIME_BOUNDS_ACCESS, LIFETIME_BOUNDS_ID, LIFETIME_BOUNDS_REFRESH,
};

use super::*;

#[derive(Debug, Clone, Default)]
pub struct UpdateApplicationInput {
    pub name: Option<String>,
    pub redirect_uris: Option<Vec<String>>,
    pub post_logout_redirect_uris: Option<Vec<String>>,
    pub scopes: Option<String>,
    pub consent_screen_enabled: Option<bool>,
    pub pkce_required: Option<bool>,
    pub access_token_lifetime_seconds: Option<i64>,
    pub refresh_token_lifetime_seconds: Option<i64>,
    pub id_token_lifetime_seconds: Option<i64>,
    pub groups_claim: Option<String>,
}

pub async fn update_application(
    state: &AppState,
    row: &ApplicationRow,
    patch: UpdateApplicationInput,
) -> Result<ApplicationRow> {
    let now = orbitid_core::http::now();
    let name = patch.name.unwrap_or_else(|| row.name.clone());
    let redirect_uris = patch
        .redirect_uris
        .map(sqlx::types::Json)
        .unwrap_or_else(|| row.redirect_uris.clone());
    let post_logout = patch
        .post_logout_redirect_uris
        .map(sqlx::types::Json)
        .unwrap_or_else(|| row.post_logout_redirect_uris.clone());
    let scopes = patch.scopes.unwrap_or_else(|| row.scopes.clone());
    let consent = patch
        .consent_screen_enabled
        .unwrap_or(row.consent_screen_enabled);
    let pkce = match patch.pkce_required {
        Some(value) => {
            if row.is_public {
                true
            } else {
                value
            }
        }
        None => row.pkce_required,
    };
    let access = patch
        .access_token_lifetime_seconds
        .map(|value| clamp_lifetime(value, LIFETIME_BOUNDS_ACCESS))
        .unwrap_or(row.access_token_lifetime_seconds);
    let refresh = patch
        .refresh_token_lifetime_seconds
        .map(|value| clamp_lifetime(value, LIFETIME_BOUNDS_REFRESH))
        .unwrap_or(row.refresh_token_lifetime_seconds);
    let id = patch
        .id_token_lifetime_seconds
        .map(|value| clamp_lifetime(value, LIFETIME_BOUNDS_ID))
        .unwrap_or(row.id_token_lifetime_seconds);
    let groups = match patch.groups_claim {
        Some(mode) if valid_groups_claim(&mode) => mode,
        _ => row.groups_claim.clone(),
    };
    sqlx::query(
        "UPDATE oauth_applications SET name = $2, redirect_uris = $3, post_logout_redirect_uris = $4, \
         scopes = $5, consent_screen_enabled = $6, pkce_required = $7, \
         access_token_lifetime_seconds = $8, refresh_token_lifetime_seconds = $9, \
         id_token_lifetime_seconds = $10, groups_claim = $11, updated_at = $12 WHERE id = $1",
    )
    .bind(&row.id)
    .bind(&name)
    .bind(&redirect_uris)
    .bind(&post_logout)
    .bind(&scopes)
    .bind(consent)
    .bind(pkce)
    .bind(access)
    .bind(refresh)
    .bind(id)
    .bind(&groups)
    .bind(now)
    .execute(&state.pool)
    .await?;
    require_application(state, &row.id).await
}

/// Lifetimes this application issues.
pub fn application_lifetimes(app: &ApplicationRow) -> (i64, i64, i64) {
    (
        clamp_lifetime(app.access_token_lifetime_seconds, LIFETIME_BOUNDS_ACCESS),
        clamp_lifetime(app.refresh_token_lifetime_seconds, LIFETIME_BOUNDS_REFRESH),
        clamp_lifetime(app.id_token_lifetime_seconds, LIFETIME_BOUNDS_ID),
    )
}

pub async fn delete_application(state: &AppState, row: &ApplicationRow) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    // Revoke every token of the application in the same transaction as the
    // delete (the FK cascade removes the rows too, but an explicit revoke keeps
    // the intent visible and covers any schema without the cascade).
    sqlx::query(
        "UPDATE oauth_grants SET revoked = true WHERE application_id = $1 AND revoked = false",
    )
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM oauth_applications WHERE id = $1")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn rotate_client_secret(
    state: &AppState,
    row: &ApplicationRow,
) -> Result<(ApplicationRow, String)> {
    if row.is_public {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "Public applications do not have a client secret",
        ));
    }
    let client_secret = generate_client_secret();
    sqlx::query(
        "UPDATE oauth_applications SET client_secret_hash = $2, updated_at = $3 WHERE id = $1",
    )
    .bind(&row.id)
    .bind(sha256(&client_secret))
    .bind(orbitid_core::http::now())
    .execute(&state.pool)
    .await?;
    Ok((require_application(state, &row.id).await?, client_secret))
}

pub async fn list_applications(
    state: &AppState,
    limit: i64,
    offset: i64,
) -> Result<Vec<ApplicationRow>> {
    Ok(sqlx::query_as::<_, ApplicationRow>(
        "SELECT * FROM oauth_applications ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?)
}

pub async fn count_applications(state: &AppState) -> Result<i64> {
    Ok(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM oauth_applications")
            .fetch_one(&state.pool)
            .await?,
    )
}
