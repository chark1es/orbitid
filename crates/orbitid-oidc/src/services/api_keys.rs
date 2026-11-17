//! API keys (`ak_live_...`): one-time secret display, hash-at-rest,
//! scopes/claims/expiry/revocation. Ported from `services/api-keys.ts`.

use serde_json::{Map, Value};

use orbitid_core::crypto::{random_token, sha256};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{ApiKeyRow, OrganizationMembershipRow};
use orbitid_core::resources::ApiKeyJson;
use orbitid_core::state::AppState;

use orbitid_identity::rbac::permissions_for_role;

const SECRET_PREFIX: &str = "ak_live_";
/// Visible prefix length (kept in the DB so UIs can show which key it is).
const PREFIX_LENGTH: usize = 12;
/// Custom org permission that grants API-key management.
pub const ORG_API_KEYS_PERMISSION: &str = "org:sys_api_keys:manage";
const ORG_PROFILE_MANAGE: &str = "org:sys_profile:manage";
const ADMIN_ROLE: &str = "org:admin";

/// New one-time API key secret: `ak_live_` + 32 url-safe random characters.
pub fn generate_api_key_secret() -> String {
    format!("{SECRET_PREFIX}{}", random_token(24))
}

pub fn serialize_api_key(row: &ApiKeyRow, secret: Option<&str>) -> ApiKeyJson {
    ApiKeyJson {
        object: "api_key".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        description: row.description.clone(),
        subject: row.subject.clone(),
        prefix: row.prefix.clone(),
        secret: secret.map(str::to_string),
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

/// Keys are only valid while they are not revoked and not expired.
pub fn is_api_key_valid(row: &ApiKeyRow, at: i64) -> bool {
    !row.revoked && row.expires_at.is_none_or(|expires| expires > at)
}

async fn assert_subject_exists(state: &AppState, subject: &str) -> Result<()> {
    let invalid = |message: &str| {
        OrbitError::unprocessable(error_codes::FORM_PARAM_VALUE_INVALID, message)
            .with_meta(serde_json::json!({ "param_name": "subject" }))
    };
    if subject.starts_with("user_") {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1")
            .bind(subject)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(invalid("subject does not match an existing user"));
        }
        return Ok(());
    }
    if subject.starts_with("org_") {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM organizations WHERE id = $1")
                .bind(subject)
                .fetch_optional(&state.pool)
                .await?;
        if exists.is_none() {
            return Err(invalid("subject does not match an existing organization"));
        }
        return Ok(());
    }
    Err(invalid("subject must be a user_... or org_... id"))
}

#[derive(Debug, Clone, Default)]
pub struct CreateApiKeyInput {
    pub name: String,
    pub subject: String,
    pub scopes: Option<Vec<String>>,
    pub claims: Option<Map<String, Value>>,
    pub seconds_until_expiration: Option<i64>,
    pub description: Option<String>,
    pub created_by: Option<String>,
}

/// Creates a key and returns the row plus the plaintext secret (shown once).
pub async fn create_api_key(
    state: &AppState,
    input: CreateApiKeyInput,
) -> Result<(ApiKeyRow, String)> {
    assert_subject_exists(state, &input.subject).await?;
    let secret = generate_api_key_secret();
    let now_ms = now();
    let row = ApiKeyRow {
        id: new_id(id_prefix::API_KEY),
        name: input.name,
        description: input.description,
        subject: input.subject,
        prefix: secret.chars().take(PREFIX_LENGTH).collect(),
        secret_hash: sha256(&secret),
        scopes: sqlx::types::Json(input.scopes.unwrap_or_default()),
        claims: input.claims.map(sqlx::types::Json),
        revoked: false,
        revocation_reason: None,
        expires_at: input
            .seconds_until_expiration
            .filter(|seconds| *seconds > 0)
            .map(|seconds| now_ms + seconds * 1000),
        last_used_at: None,
        created_by: input.created_by,
        created_at: now_ms,
        updated_at: now_ms,
    };
    let mut tx = state.pool.begin().await?;
    // Re-check the subject under its lock: a ban (which revokes the subject's
    // keys under `FOR UPDATE`) or deletion that committed after the unlocked
    // check above must not be followed by a fresh live key.
    if row.subject.starts_with("user_") {
        match orbitid_identity::locks::key_share_active_user_on(&mut tx, &row.subject).await? {
            None => {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_PARAM_VALUE_INVALID,
                    "subject does not match an existing user",
                )
                .with_meta(serde_json::json!({ "param_name": "subject" })))
            }
            Some(state) if state.banned => {
                return Err(OrbitError::forbidden(
                    error_codes::USER_BANNED,
                    "This user has been banned",
                ))
            }
            Some(_) => {}
        }
    } else {
        orbitid_identity::locks::lock_organization_on(&mut tx, &row.subject).await?;
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM organizations WHERE id = $1")
                .bind(&row.subject)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                "subject does not match an existing organization",
            )
            .with_meta(serde_json::json!({ "param_name": "subject" })));
        }
    }
    sqlx::query(
        "INSERT INTO api_keys (id, name, description, subject, prefix, secret_hash, scopes, claims, \
         revoked, revocation_reason, expires_at, last_used_at, created_by, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    )
    .bind(&row.id)
    .bind(&row.name)
    .bind(&row.description)
    .bind(&row.subject)
    .bind(&row.prefix)
    .bind(&row.secret_hash)
    .bind(&row.scopes)
    .bind(&row.claims)
    .bind(row.revoked)
    .bind(&row.revocation_reason)
    .bind(row.expires_at)
    .bind(row.last_used_at)
    .bind(&row.created_by)
    .bind(row.created_at)
    .bind(row.updated_at)
    .execute(&mut *tx)
    .await?;
    let json = serialize_api_key(&row, None);
    orbitid_platform::webhooks::emit_event_on(&mut tx, "apiKey.created", serde_json::json!(json))
        .await?;
    tx.commit().await?;
    Ok((row, secret))
}

pub async fn get_api_key(state: &AppState, id: &str) -> Result<Option<ApiKeyRow>> {
    Ok(
        sqlx::query_as::<_, ApiKeyRow>("SELECT * FROM api_keys WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn require_api_key(state: &AppState, id: &str) -> Result<ApiKeyRow> {
    get_api_key(state, id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "API key not found"))
}

#[derive(Debug, Clone)]
pub struct ListApiKeysOptions<'a> {
    pub subject: Option<&'a str>,
    pub include_invalid: bool,
    pub limit: i64,
    pub offset: i64,
    pub order_by: Option<&'a str>,
}

fn order_clause(order_by: Option<&str>) -> &'static str {
    let raw = order_by.unwrap_or("-created_at").trim();
    let descending = raw.starts_with('-');
    let key = raw.trim_start_matches('-');
    match (key, descending) {
        ("updated_at", true) => "ORDER BY updated_at DESC",
        ("updated_at", false) => "ORDER BY updated_at ASC",
        ("name", true) => "ORDER BY name DESC",
        ("name", false) => "ORDER BY name ASC",
        ("last_used_at", true) => "ORDER BY last_used_at DESC",
        ("last_used_at", false) => "ORDER BY last_used_at ASC",
        (_, true) => "ORDER BY created_at DESC",
        (_, false) => "ORDER BY created_at ASC",
    }
}

pub async fn list_api_keys(
    state: &AppState,
    options: ListApiKeysOptions<'_>,
) -> Result<(Vec<ApiKeyRow>, i64)> {
    let now_ms = now();
    let order = order_clause(options.order_by);
    let rows = if options.include_invalid {
        sqlx::query_as::<_, ApiKeyRow>(&format!(
            "SELECT * FROM api_keys WHERE ($1::text IS NULL OR subject = $1) {order} LIMIT $2 OFFSET $3"
        ))
        .bind(options.subject)
        .bind(options.limit)
        .bind(options.offset)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as::<_, ApiKeyRow>(&format!(
            "SELECT * FROM api_keys WHERE ($1::text IS NULL OR subject = $1) AND revoked = false \
             AND (expires_at IS NULL OR expires_at > $4) {order} LIMIT $2 OFFSET $3"
        ))
        .bind(options.subject)
        .bind(options.limit)
        .bind(options.offset)
        .bind(now_ms)
        .fetch_all(&state.pool)
        .await?
    };
    let total: i64 = if options.include_invalid {
        sqlx::query_scalar("SELECT COUNT(*) FROM api_keys WHERE ($1::text IS NULL OR subject = $1)")
            .bind(options.subject)
            .fetch_one(&state.pool)
            .await?
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM api_keys WHERE ($1::text IS NULL OR subject = $1) AND revoked = false \
             AND (expires_at IS NULL OR expires_at > $2)",
        )
        .bind(options.subject)
        .bind(now_ms)
        .fetch_one(&state.pool)
        .await?
    };
    Ok((rows, total))
}

#[derive(Debug, Clone, Default)]
pub struct UpdateApiKeyInput {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub scopes: Option<Vec<String>>,
    pub claims: Option<Option<Map<String, Value>>>,
}

pub async fn update_api_key(
    state: &AppState,
    row: &ApiKeyRow,
    patch: UpdateApiKeyInput,
) -> Result<ApiKeyRow> {
    let name = patch.name.unwrap_or_else(|| row.name.clone());
    let description = patch.description.unwrap_or_else(|| row.description.clone());
    let scopes = patch
        .scopes
        .map(sqlx::types::Json)
        .unwrap_or_else(|| row.scopes.clone());
    let claims = match patch.claims {
        Some(claims) => claims.map(sqlx::types::Json),
        None => row.claims.clone(),
    };
    sqlx::query(
        "UPDATE api_keys SET name = $2, description = $3, scopes = $4, claims = $5, updated_at = $6 \
         WHERE id = $1",
    )
    .bind(&row.id)
    .bind(&name)
    .bind(&description)
    .bind(&scopes)
    .bind(&claims)
    .bind(now())
    .execute(&state.pool)
    .await?;
    require_api_key(state, &row.id).await
}

pub async fn revoke_api_key(
    state: &AppState,
    row: &ApiKeyRow,
    reason: Option<&str>,
) -> Result<ApiKeyRow> {
    let now_ms = now();
    let mut tx = state.pool.begin().await?;
    let revoked = sqlx::query_as::<_, ApiKeyRow>(
        "UPDATE api_keys SET revoked = true, revocation_reason = $2, updated_at = $3 \
         WHERE id = $1 AND revoked = false RETURNING *",
    )
    .bind(&row.id)
    .bind(reason)
    .bind(now_ms)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(revoked) = revoked else {
        tx.rollback().await?;
        return Ok(row.clone());
    };
    let json = serialize_api_key(&revoked, None);
    orbitid_platform::webhooks::emit_event_on(&mut tx, "apiKey.revoked", serde_json::json!(json))
        .await?;
    tx.commit().await?;
    Ok(revoked)
}

/// Deletes the key. Emits `apiKey.revoked` — deletion revokes the credential —
/// in the same transaction as the delete.
pub async fn delete_api_key(state: &AppState, row: &ApiKeyRow) -> Result<()> {
    let mut revoked = row.clone();
    revoked.revoked = true;
    let json = serialize_api_key(&revoked, None);
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM api_keys WHERE id = $1")
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "apiKey.revoked", serde_json::json!(json))
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Validates a plaintext secret and updates `last_used_at`.
pub async fn verify_api_key(state: &AppState, secret: &str) -> Result<ApiKeyRow> {
    let invalid = || OrbitError::unauthorized(error_codes::API_KEY_INVALID, "Invalid API key");
    if !secret.starts_with(SECRET_PREFIX) {
        return Err(invalid());
    }
    let Some(row) = sqlx::query_as::<_, ApiKeyRow>("SELECT * FROM api_keys WHERE secret_hash = $1")
        .bind(sha256(secret))
        .fetch_optional(&state.pool)
        .await?
    else {
        return Err(invalid());
    };
    if !is_api_key_valid(&row, now()) {
        return Err(invalid());
    }
    if !subject_usable(state, &row.subject).await? {
        return Err(invalid());
    }
    let now_ms = now();
    sqlx::query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1")
        .bind(&row.id)
        .bind(now_ms)
        .execute(&state.pool)
        .await?;
    let mut row = row;
    row.last_used_at = Some(now_ms);
    Ok(row)
}

/// A key is only as usable as the account it acts for.
async fn subject_usable(state: &AppState, subject: &str) -> Result<bool> {
    let now_ms = now();
    if subject.starts_with("user_") {
        let user =
            sqlx::query_as::<_, orbitid_core::models::UserRow>("SELECT * FROM users WHERE id = $1")
                .bind(subject)
                .fetch_optional(&state.pool)
                .await?;
        let Some(user) = user else {
            return Ok(false);
        };
        if user.banned {
            return Ok(false);
        }
        if user.locked
            && (user.lockout_expires_at.is_none() || user.lockout_expires_at.unwrap_or(0) > now_ms)
        {
            return Ok(false);
        }
        return Ok(true);
    }
    if subject.starts_with("org_") {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM organizations WHERE id = $1")
                .bind(subject)
                .fetch_optional(&state.pool)
                .await?;
        return Ok(exists.is_some());
    }
    Ok(false)
}

/// Banning a subject is a credential revocation, not a flag read later.
/// The canonical implementation lives in `orbitid_identity::api_keys`.
/// Banning a subject is a credential revocation, not a flag read later.
/// The canonical implementation lives in `orbitid_identity::api_keys`.
pub async fn revoke_api_keys_for_subject(
    state: &AppState,
    subject: &str,
    reason: &str,
) -> Result<i64> {
    orbitid_identity::api_keys::revoke_api_keys_for_subject(state, subject, reason).await
}

/// Org-level authorization for `/organizations/:orgId/api_keys`.
pub async fn assert_org_api_keys_permission(
    state: &AppState,
    user_id: &str,
    organization_id: &str,
) -> Result<OrganizationMembershipRow> {
    let membership = sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::forbidden(
            error_codes::NOT_A_MEMBER_IN_ORGANIZATION,
            "You are not a member of this organization",
        )
    })?;
    if membership.role_key == ADMIN_ROLE {
        return Ok(membership);
    }
    let granted = permissions_for_role(state, &membership.role_key).await?;
    if granted
        .iter()
        .any(|permission| permission == ORG_PROFILE_MANAGE)
        || granted
            .iter()
            .any(|permission| permission == ORG_API_KEYS_PERMISSION)
    {
        return Ok(membership);
    }
    Err(OrbitError::forbidden(
        error_codes::ORG_PERMISSION_REQUIRED,
        format!("Missing permission {ORG_API_KEYS_PERMISSION}"),
    ))
}

/// A key belongs to the caller's subject only (Frontend API).
pub fn assert_api_key_ownership(row: &ApiKeyRow, subject: &str) -> Result<()> {
    if row.subject != subject {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "API key not found",
        ));
    }
    Ok(())
}
