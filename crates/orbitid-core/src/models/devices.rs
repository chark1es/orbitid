//! Device tables: `trusted_devices`, `operator_sessions`, `device_codes`.

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrustedDeviceRow {
    pub id: String,
    pub user_id: String,
    pub token_hash: String,
    pub label: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub expires_at: i64,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct OperatorSessionRow {
    pub id: String,
    pub token_hash: String,
    pub key_fingerprint: String,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub expires_at: i64,
    pub revoked_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The signed-in account behind the console session.
    pub user_id: String,
    /// That account's own session on this browser; ending it ends the console session.
    pub session_id: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceCodeRow {
    pub id: String,
    pub application_id: String,
    pub device_code_hash: String,
    /// Short code the user types, upper-case without separators.
    pub user_code: String,
    pub scopes: String,
    /// `pending` | `approved` | `denied` | `consumed`
    pub status: String,
    pub user_id: Option<String>,
    pub interval_seconds: i64,
    pub last_polled_at: Option<i64>,
    pub expires_at: i64,
    pub created_at: i64,
}
