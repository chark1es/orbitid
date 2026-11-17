//! Token tables: `jwt_templates`, `actor_tokens`, `sign_in_tokens`.

use super::{JsonMetadata, Jsonb};

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JwtTemplateRow {
    pub id: String,
    pub name: String,
    pub claims: JsonMetadata,
    pub lifetime: i64,
    pub allowed_clock_skew: i64,
    pub custom_signing_key: bool,
    pub signing_algorithm: String,
    pub signing_key_enc: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ActorTokenRow {
    pub id: String,
    pub user_id: String,
    pub actor: Jsonb,
    pub token_hash: String,
    pub status: String,
    pub expires_at: i64,
    pub session_max_duration_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignInTokenRow {
    pub id: String,
    pub user_id: String,
    pub token_hash: String,
    pub status: String,
    pub expires_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
