//! Enterprise-connection policy for an already-linked user: extra
//! identifications and attribute sync. Ported from
//! `services/enterprise-access.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::state::AppState;

use crate::external_identity::ExternalProfile;

const PROVIDER_PREFIXES: &[&str] = &["saml_", "oidc_", "enterprise_saml_", "enterprise_oidc_"];

/// `saml_ent_...` / `oidc_ent_...` → the connection id, or `None` for a social
/// provider.
pub fn enterprise_connection_id_from_provider(provider: &str) -> Option<String> {
    for prefix in PROVIDER_PREFIXES {
        if let Some(rest) = provider.strip_prefix(prefix) {
            return Some(rest.to_string());
        }
    }
    None
}

/// Every enterprise connection a user is linked to (one external account per
/// connection is enough).
pub async fn enterprise_connections_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<EnterpriseConnectionRow>> {
    let providers: Vec<String> =
        sqlx::query_scalar("SELECT provider FROM external_accounts WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    let mut connection_ids: Vec<String> = Vec::new();
    for provider in providers {
        if let Some(id) = enterprise_connection_id_from_provider(&provider) {
            if !connection_ids.contains(&id) {
                connection_ids.push(id);
            }
        }
    }
    if connection_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = ANY($1)",
    )
    .bind(&connection_ids)
    .fetch_all(&state.pool)
    .await?)
}

/// The first enterprise connection a user signed in through, if any.
pub async fn enterprise_connection_for_user(
    state: &AppState,
    user_id: &str,
) -> Result<Option<EnterpriseConnectionRow>> {
    Ok(enterprise_connections_for_user(state, user_id)
        .await?
        .into_iter()
        .next())
}

/// `disable_additional_identifications` belongs to every connection the user
/// belongs to; if ANY of them forbids additions, the addition is refused.
pub async fn assert_additional_identifications_allowed(
    state: &AppState,
    user_id: &str,
) -> Result<()> {
    let mut conn = state.pool.acquire().await?;
    assert_additional_identifications_allowed_on(&mut conn, state, user_id).await
}

/// [`assert_additional_identifications_allowed`] on a caller-owned connection,
/// so a link/insert transaction never acquires a second pool connection.
pub async fn assert_additional_identifications_allowed_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    user_id: &str,
) -> Result<()> {
    let providers: Vec<String> =
        sqlx::query_scalar("SELECT provider FROM external_accounts WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?;
    let mut connection_ids: Vec<String> = Vec::new();
    for provider in providers {
        if let Some(id) = enterprise_connection_id_from_provider(&provider) {
            if !connection_ids.contains(&id) {
                connection_ids.push(id);
            }
        }
    }
    if connection_ids.is_empty() {
        return Ok(());
    }
    let connections = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = ANY($1)",
    )
    .bind(&connection_ids)
    .fetch_all(&mut *conn)
    .await?;
    let blocked = connections
        .into_iter()
        .find(|row| row.disable_additional_identifications);
    let Some(connection) = blocked else {
        return Ok(());
    };
    Err(OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        "Additional identifications are disabled for your enterprise connection",
    )
    .with_meta(serde_json::json!({ "enterprise_connection_id": connection.id })))
}

/// `sync_user_attributes`: keep the local name and avatar aligned with the
/// identity provider on each SSO sign-in. Only fields the provider supplied are
/// overwritten.
pub async fn sync_enterprise_user_attributes(
    state: &AppState,
    user_id: &str,
    profile: &ExternalProfile,
) -> Result<()> {
    let Some(connection_id) = enterprise_connection_id_from_provider(&profile.provider) else {
        return Ok(());
    };
    let connection = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = $1",
    )
    .bind(&connection_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(connection) = connection else {
        return Ok(());
    };
    if !connection.sync_user_attributes {
        return Ok(());
    }
    let has_image = profile.image_url.is_some();
    if profile.first_name.is_none() && profile.last_name.is_none() && profile.image_url.is_none() {
        return Ok(());
    }
    sqlx::query(
        "UPDATE users SET first_name = COALESCE($1, first_name), \
         last_name = COALESCE($2, last_name), image_url = COALESCE($3, image_url), \
         has_image = CASE WHEN $4 THEN false ELSE has_image END, updated_at = $5 \
         WHERE id = $6",
    )
    .bind(&profile.first_name)
    .bind(&profile.last_name)
    .bind(&profile.image_url)
    .bind(has_image)
    .bind(now())
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}
