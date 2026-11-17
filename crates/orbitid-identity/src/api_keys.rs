//! API-key credential revocation shared by every surface.
//!
//! An API key is a credential, not a flag read later: banning a subject or
//! deleting their account has to revoke every key they hold. The implementation
//! lives here (next to [`crate::grants`]) so the Backend API, the OIDC provider
//! and any future surface revoke exactly the same rows and emit the same
//! `apiKey.revoked` events.
//!
//! Ported from `services/api-keys.ts` (`revokeApiKeysForSubject`).

use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::models::ApiKeyRow;
use orbitid_core::resources::ApiKeyJson;
use orbitid_core::state::AppState;

/// Wire form of a key without its one-time secret.
pub fn serialize_api_key(row: &ApiKeyRow) -> ApiKeyJson {
    ApiKeyJson {
        object: "api_key".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        subject: row.subject.clone(),
        prefix: row.prefix.clone(),
        secret: None,
        scopes: row.scopes.0.clone(),
        claims: row.claims.as_ref().map(|claims| claims.0.clone()),
        revoked: row.revoked,
        expiration: row.expires_at,
        last_used_at: row.last_used_at,
        created_by: row.created_by.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Revokes every live key a user or organization holds and returns how many
/// were revoked. Each revocation emits `apiKey.revoked`, like the single-key
/// route does, so webhook consumers see bans as credential changes.
pub async fn revoke_api_keys_for_subject(
    state: &AppState,
    subject: &str,
    reason: &str,
) -> Result<i64> {
    if subject.is_empty() {
        return Ok(0);
    }
    let mut tx = state.pool.begin().await?;
    let revoked = revoke_api_keys_for_subject_on(&mut tx, subject, reason).await?;
    tx.commit().await?;
    Ok(revoked)
}

/// [`revoke_api_keys_for_subject`] on a caller-owned transaction, so a ban or
/// deletion commits with the revocation and its `apiKey.revoked` events.
pub async fn revoke_api_keys_for_subject_on(
    conn: &mut sqlx::PgConnection,
    subject: &str,
    reason: &str,
) -> Result<i64> {
    if subject.is_empty() {
        return Ok(0);
    }
    let rows = sqlx::query_as::<_, ApiKeyRow>(
        "UPDATE api_keys SET revoked = true, revocation_reason = $2, updated_at = $3 \
         WHERE subject = $1 AND revoked = false RETURNING *",
    )
    .bind(subject)
    .bind(reason)
    .bind(now())
    .fetch_all(&mut *conn)
    .await?;
    for revoked in &rows {
        let json = serialize_api_key(revoked);
        orbitid_platform::webhooks::emit_event_on(conn, "apiKey.revoked", serde_json::json!(json))
            .await?;
    }
    Ok(rows.len() as i64)
}
