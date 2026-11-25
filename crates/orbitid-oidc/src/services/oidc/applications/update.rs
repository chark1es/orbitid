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
    /// `Some(Some(org))` assigns the application to an organization,
    /// `Some(None)` makes it instance-wide, `None` leaves the owner unchanged.
    pub organization_id: Option<Option<String>>,
}

/// What an update changed that callers report (the audit log).
#[derive(Debug, Clone, Default)]
pub struct ApplicationUpdateEffects {
    /// `(previous, new)` owner when the owning organization changed.
    pub owner_change: Option<(Option<String>, Option<String>)>,
    /// Grants revoked because their users lost access with the owner change.
    pub revoked_grants: u64,
    /// Access grants deleted because the application became instance-wide.
    pub deleted_access_grants: u64,
}

pub async fn update_application(
    state: &AppState,
    row: &ApplicationRow,
    patch: UpdateApplicationInput,
) -> Result<ApplicationRow> {
    Ok(update_application_with_effects(state, row, patch).await?.0)
}

/// [`update_application`], also returning the owner change it made.
///
/// One transaction: the new owner is key-shared (rank 8), then the application
/// row is locked `FOR UPDATE` (between ranks 10 and 11), updated, and the grants
/// of users the new owner does not entitle are revoked (rank 11). Issuers hold
/// the application `FOR SHARE` while they check access and write, so the
/// revocation sees every grant they committed and later issuers read the new
/// owner.
pub async fn update_application_with_effects(
    state: &AppState,
    row: &ApplicationRow,
    patch: UpdateApplicationInput,
) -> Result<(ApplicationRow, ApplicationUpdateEffects)> {
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
    let mut tx = state.pool.begin().await?;
    let outcome = async {
        if let Some(Some(organization_id)) = patch.organization_id.as_ref() {
            key_share_owner_on(&mut tx, organization_id).await?;
        }
        let previous: Option<Option<String>> = sqlx::query_scalar(
            "SELECT organization_id FROM oauth_applications WHERE id = $1 FOR UPDATE",
        )
        .bind(&row.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(previous) = previous else {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "OAuth application not found",
            ));
        };
        let owner = patch
            .organization_id
            .clone()
            .unwrap_or_else(|| previous.clone());
        let updated = sqlx::query_as::<_, ApplicationRow>(
            "UPDATE oauth_applications SET name = $2, redirect_uris = $3, post_logout_redirect_uris = $4, \
             scopes = $5, consent_screen_enabled = $6, pkce_required = $7, \
             access_token_lifetime_seconds = $8, refresh_token_lifetime_seconds = $9, \
             id_token_lifetime_seconds = $10, groups_claim = $11, organization_id = $12, \
             updated_at = $13 WHERE id = $1 RETURNING *",
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
        .bind(&owner)
        .bind(now)
        .fetch_one(&mut *tx)
        .await?;
        let mut effects = ApplicationUpdateEffects::default();
        if owner != previous {
            // Widening (to instance-wide) revokes nothing, but its access
            // grants mean nothing any more and would silently apply again if an
            // owner were set later: they go with the owner. Any other change
            // revokes the grants of users the new owner does not entitle.
            if owner.is_some() {
                effects.revoked_grants =
                    orbitid_identity::app_access::revoke_application_grants_after_owner_change_on(
                        &mut tx, &row.id,
                    )
                    .await?;
            } else {
                effects.deleted_access_grants = sqlx::query(
                    "DELETE FROM oauth_application_access_grants WHERE application_id = $1",
                )
                .bind(&row.id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            }
            effects.owner_change = Some((previous, owner));
        }
        Ok((updated, effects))
    }
    .await;
    orbitid_core::db::finish_transaction(tx, outcome).await
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
    // The application row first: issuers hold it `FOR SHARE` before they touch
    // grant rows, so locking the grants first could deadlock with them.
    sqlx::query("SELECT id FROM oauth_applications WHERE id = $1 FOR UPDATE")
        .bind(&row.id)
        .fetch_optional(&mut *tx)
        .await?;
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

/// Which applications a listing returns.
#[derive(Debug, Clone, Copy, Default)]
pub enum OwnerFilter<'a> {
    #[default]
    Any,
    /// Only instance-wide applications (`organization_id=null`).
    InstanceWide,
    /// Only applications owned by this organization.
    Organization(&'a str),
}

impl OwnerFilter<'_> {
    /// `(sql condition, bound organization id)`. Every condition references `$1`
    /// (bound to `NULL` when unused) so the statement shape is fixed.
    fn condition(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::Any => ("$1::text IS NULL", None),
            Self::InstanceWide => ("organization_id IS NULL AND $1::text IS NULL", None),
            Self::Organization(id) => ("organization_id = $1", Some(id)),
        }
    }
}

pub async fn list_applications(
    state: &AppState,
    limit: i64,
    offset: i64,
) -> Result<Vec<ApplicationRow>> {
    list_applications_owned(state, OwnerFilter::Any, limit, offset).await
}

pub async fn list_applications_owned(
    state: &AppState,
    owner: OwnerFilter<'_>,
    limit: i64,
    offset: i64,
) -> Result<Vec<ApplicationRow>> {
    let (condition, organization_id) = owner.condition();
    Ok(sqlx::query_as::<_, ApplicationRow>(&format!(
        "SELECT * FROM oauth_applications WHERE {condition} \
         ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ))
    .bind(organization_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?)
}

pub async fn count_applications(state: &AppState) -> Result<i64> {
    count_applications_owned(state, OwnerFilter::Any).await
}

pub async fn count_applications_owned(state: &AppState, owner: OwnerFilter<'_>) -> Result<i64> {
    let (condition, organization_id) = owner.condition();
    Ok(sqlx::query_scalar::<_, i64>(&format!(
        "SELECT COUNT(*) FROM oauth_applications WHERE {condition}"
    ))
    .bind(organization_id)
    .fetch_one(&state.pool)
    .await?)
}
