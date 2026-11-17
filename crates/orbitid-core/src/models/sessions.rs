//! Session tables: `clients`, `sessions`, `sign_ins`, `sign_ups`,
//! `verifications`, `oauth_states`, `rate_limits`.

use super::Jsonb;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ClientRow {
    pub id: String,
    /// sha256 of the opaque `__client` cookie value.
    pub token_hash: String,
    pub last_active_session_id: Option<String>,
    pub token_issued_at: Option<i64>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub id: String,
    pub client_id: String,
    pub user_id: String,
    pub status: String,
    pub last_active_at: i64,
    pub last_active_organization_id: Option<String>,
    pub expire_at: i64,
    pub abandon_at: i64,
    pub actor: Option<Jsonb>,
    pub first_factor_verified_at: Option<i64>,
    pub second_factor_verified_at: Option<i64>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub city: Option<String>,
    pub country: Option<String>,
    /// One of `resources::AuthMethod`.
    pub auth_method: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignInRow {
    pub id: String,
    pub client_id: String,
    pub status: String,
    pub identifier: Option<String>,
    pub user_id: Option<String>,
    pub state: Jsonb,
    pub created_session_id: Option<String>,
    pub abandon_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Optimistic-concurrency counter; every guarded write increments it.
    pub version: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SignUpRow {
    pub id: String,
    pub client_id: String,
    pub status: String,
    pub fields: Jsonb,
    pub unsafe_metadata: Jsonb,
    pub verifications: Jsonb,
    pub invitation_id: Option<String>,
    pub org_invitation_id: Option<String>,
    pub created_session_id: Option<String>,
    pub created_user_id: Option<String>,
    pub abandon_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// Optimistic-concurrency counter; every guarded write increments it.
    pub version: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VerificationRow {
    pub id: String,
    pub purpose: String,
    pub strategy: String,
    pub identifier: String,
    pub owner_id: String,
    pub code_hash: Option<String>,
    pub token_hash: Option<String>,
    pub attempts: i64,
    pub max_attempts: i64,
    pub redirect_url: Option<String>,
    pub data: Option<Jsonb>,
    pub consumed_at: Option<i64>,
    pub verified_at: Option<i64>,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OauthStateRow {
    pub state: String,
    pub provider: String,
    pub code_verifier: Option<String>,
    pub nonce: Option<String>,
    pub flow: Jsonb,
    pub expires_at: i64,
}

/// The combined fixed-window counter table used by the TypeScript server.
/// Distributed Rust rate limiting lives in `rate_limit_windows` (migration 0002).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RateLimitRow {
    pub key: String,
    pub count: i64,
    pub reset_at: i64,
}
