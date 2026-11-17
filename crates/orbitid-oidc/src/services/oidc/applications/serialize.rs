use sqlx::PgConnection;

use orbitid_core::crypto::{random_token, sha256};
use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OauthApplicationRow;
use orbitid_core::resources::{
    OauthApplicationJson, DEFAULT_OAUTH_APPLICATION_SCOPES, DEFAULT_OAUTH_GROUPS_CLAIM,
    DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS,
};
use orbitid_core::state::AppState;

use crate::services::oidc::shared::{
    GROUPS_CLAIM_MODES, LIFETIME_BOUNDS_ACCESS, LIFETIME_BOUNDS_ID, LIFETIME_BOUNDS_REFRESH,
};

pub type ApplicationRow = OauthApplicationRow;

/// Service results: plain OrbitID errors.
type Result<T> = std::result::Result<T, OrbitError>;

pub fn serialize_application(
    row: &ApplicationRow,
    client_secret: Option<&str>,
) -> OauthApplicationJson {
    OauthApplicationJson {
        object: "oauth_application".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        client_id: row.client_id.clone(),
        client_secret: client_secret.map(str::to_string),
        public: row.is_public,
        redirect_uris: row.redirect_uris.0.clone(),
        post_logout_redirect_uris: row.post_logout_redirect_uris.0.clone(),
        scopes: row.scopes.clone(),
        consent_screen_enabled: row.consent_screen_enabled,
        pkce_required: row.pkce_required,
        access_token_lifetime_seconds: row.access_token_lifetime_seconds,
        refresh_token_lifetime_seconds: row.refresh_token_lifetime_seconds,
        id_token_lifetime_seconds: row.id_token_lifetime_seconds,
        groups_claim: row.groups_claim.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn generate_client_secret() -> String {
    format!("oas_{}", random_token(24))
}

pub async fn get_application(state: &AppState, id: &str) -> Result<Option<ApplicationRow>> {
    Ok(
        sqlx::query_as::<_, ApplicationRow>("SELECT * FROM oauth_applications WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn require_application(state: &AppState, id: &str) -> Result<ApplicationRow> {
    get_application(state, id).await?.ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "OAuth application not found",
        )
    })
}

pub async fn get_application_by_client_id(
    state: &AppState,
    client_id: &str,
) -> Result<Option<ApplicationRow>> {
    Ok(
        sqlx::query_as::<_, ApplicationRow>(
            "SELECT * FROM oauth_applications WHERE client_id = $1",
        )
        .bind(client_id)
        .fetch_optional(&state.pool)
        .await?,
    )
}

#[derive(Debug, Clone, Default)]
pub struct CreateApplicationInput {
    pub name: String,
    pub redirect_uris: Option<Vec<String>>,
    pub post_logout_redirect_uris: Option<Vec<String>>,
    pub scopes: Option<String>,
    pub is_public: Option<bool>,
    pub consent_screen_enabled: Option<bool>,
    pub pkce_required: Option<bool>,
    pub access_token_lifetime_seconds: Option<i64>,
    pub refresh_token_lifetime_seconds: Option<i64>,
    pub id_token_lifetime_seconds: Option<i64>,
    pub groups_claim: Option<String>,
}

pub fn clamp_lifetime(value: i64, bounds: (i64, i64)) -> i64 {
    value.max(bounds.0).min(bounds.1)
}

/// Whether a `groups_claim` value is one of the supported modes.
pub fn valid_groups_claim(value: &str) -> bool {
    GROUPS_CLAIM_MODES.contains(&value)
}

pub async fn create_application(
    state: &AppState,
    input: CreateApplicationInput,
) -> Result<(ApplicationRow, Option<String>)> {
    let now = orbitid_core::http::now();
    let is_public = input.is_public.unwrap_or(false);
    let client_secret = if is_public {
        None
    } else {
        Some(generate_client_secret())
    };
    let row = ApplicationRow {
        id: new_id(id_prefix::OAUTH_APP),
        name: input.name,
        client_id: new_id(id_prefix::OAUTH_APP),
        client_secret_hash: client_secret.as_ref().map(|secret| sha256(secret)),
        is_public,
        redirect_uris: sqlx::types::Json(input.redirect_uris.unwrap_or_default()),
        post_logout_redirect_uris: sqlx::types::Json(
            input.post_logout_redirect_uris.unwrap_or_default(),
        ),
        scopes: input
            .scopes
            .unwrap_or_else(|| DEFAULT_OAUTH_APPLICATION_SCOPES.to_string()),
        consent_screen_enabled: input.consent_screen_enabled.unwrap_or(true),
        // Public clients are always PKCE-bound; confidential clients stay
        // interop-friendly unless opted in.
        pkce_required: if is_public {
            true
        } else {
            input.pkce_required.unwrap_or(false)
        },
        access_token_lifetime_seconds: clamp_lifetime(
            input
                .access_token_lifetime_seconds
                .unwrap_or(DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS),
            LIFETIME_BOUNDS_ACCESS,
        ),
        refresh_token_lifetime_seconds: clamp_lifetime(
            input.refresh_token_lifetime_seconds.unwrap_or(2_592_000),
            LIFETIME_BOUNDS_REFRESH,
        ),
        id_token_lifetime_seconds: clamp_lifetime(
            input.id_token_lifetime_seconds.unwrap_or(3600),
            LIFETIME_BOUNDS_ID,
        ),
        groups_claim: match input.groups_claim {
            Some(mode) if valid_groups_claim(&mode) => mode,
            _ => DEFAULT_OAUTH_GROUPS_CLAIM.to_string(),
        },
        created_at: now,
        updated_at: now,
    };
    insert_application(&state.pool, &row).await?;
    Ok((row, client_secret))
}

async fn insert_application(pool: &sqlx::PgPool, row: &ApplicationRow) -> Result<()> {
    let mut conn = pool.acquire().await?;
    insert_application_on(&mut conn, row).await
}

pub(super) async fn insert_application_on(
    conn: &mut PgConnection,
    row: &ApplicationRow,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO oauth_applications (id, name, client_id, client_secret_hash, is_public, \
         redirect_uris, post_logout_redirect_uris, scopes, consent_screen_enabled, pkce_required, \
         access_token_lifetime_seconds, refresh_token_lifetime_seconds, id_token_lifetime_seconds, \
         groups_claim, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
    )
    .bind(&row.id)
    .bind(&row.name)
    .bind(&row.client_id)
    .bind(&row.client_secret_hash)
    .bind(row.is_public)
    .bind(&row.redirect_uris)
    .bind(&row.post_logout_redirect_uris)
    .bind(&row.scopes)
    .bind(row.consent_screen_enabled)
    .bind(row.pkce_required)
    .bind(row.access_token_lifetime_seconds)
    .bind(row.refresh_token_lifetime_seconds)
    .bind(row.id_token_lifetime_seconds)
    .bind(&row.groups_claim)
    .bind(row.created_at)
    .bind(row.updated_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}
