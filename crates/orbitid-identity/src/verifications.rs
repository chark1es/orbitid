//! One-time codes, magic links and their delivery, ported from
//! `modules/auth/verifications.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::VerificationRow;
use orbitid_core::resources::{VerificationErrorJson, VerificationJson, VerificationStatus};
use orbitid_core::state::AppState;
use serde_json::Value;

/// Verification purposes used by the auth surfaces.
pub mod purposes {
    pub const SIGN_IN_FIRST_FACTOR: &str = "sign_in_first_factor";
    pub const SIGN_IN_SECOND_FACTOR: &str = "sign_in_second_factor";
    pub const SIGN_UP_EMAIL: &str = "sign_up_email";
    pub const SIGN_UP_PHONE: &str = "sign_up_phone";
    pub const RESET_PASSWORD: &str = "reset_password";
    pub const REVERIFY_FIRST_FACTOR: &str = "reverify_first_factor";
    pub const REVERIFY_SECOND_FACTOR: &str = "reverify_second_factor";
    pub const ADD_EMAIL: &str = "add_email";
    pub const ADD_PHONE: &str = "add_phone";
    pub const PASSKEY_REGISTRATION: &str = "passkey_registration";
    pub const PASSKEY_AUTHENTICATION: &str = "passkey_authentication";
    pub const ORG_DOMAIN: &str = "org_domain";
}

#[derive(Debug, Clone)]
pub struct IssueVerificationInput {
    pub purpose: String,
    pub strategy: String,
    pub identifier: String,
    pub owner_id: String,
    pub redirect_url: Option<String>,
    pub data: Option<Value>,
    pub lifetime_seconds: i64,
    pub max_attempts: Option<i64>,
    pub code_length: Option<i64>,
}

impl IssueVerificationInput {
    pub fn new(
        purpose: impl Into<String>,
        strategy: impl Into<String>,
        identifier: impl Into<String>,
        owner_id: impl Into<String>,
        lifetime_seconds: i64,
    ) -> Self {
        Self {
            purpose: purpose.into(),
            strategy: strategy.into(),
            identifier: identifier.into(),
            owner_id: owner_id.into(),
            redirect_url: None,
            data: None,
            lifetime_seconds,
            max_attempts: None,
            code_length: None,
        }
    }

    pub fn with_code_length(mut self, code_length: i64) -> Self {
        self.code_length = Some(code_length);
        self
    }
}

#[derive(Clone)]
pub struct IssuedVerification {
    pub row: VerificationRow,
    /// Numeric code (email_code / phone_code / reset_password_*).
    pub code: Option<String>,
    /// Opaque token for magic links.
    pub token: Option<String>,
}

impl std::fmt::Debug for IssuedVerification {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedVerification")
            .field("row", &self.row)
            .field("code", &self.code)
            .field("token", &"<redacted>")
            .finish()
    }
}

fn is_link_strategy(strategy: &str) -> bool {
    strategy == "email_link" || strategy == "reset_password_link"
}

/// Creates a hashed one-time code or link token. Never stores plaintext.
///
/// Invalidation of the previous pending row and the insert are one statement
/// (a data-modifying CTE), so a failure can never expire the old code without
/// storing its replacement, and two concurrent issues for the same owner leave
/// exactly one live row.
pub async fn issue_verification(
    state: &AppState,
    input: IssueVerificationInput,
) -> Result<IssuedVerification> {
    let mut tx = state.pool.begin().await?;
    let issued = issue_verification_on(&mut tx, state, input).await?;
    tx.commit().await?;
    Ok(issued)
}

/// [`issue_verification`] on a caller-owned connection. Safe inside a caller's
/// transaction: a transaction-scoped advisory lock serializes issues for the
/// same owner/purpose/identifier, then the previous row is invalidated and the
/// new one inserted on the same connection. Two concurrent issues therefore
/// leave exactly one live row.
pub async fn issue_verification_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    input: IssueVerificationInput,
) -> Result<IssuedVerification> {
    let now_ms = now();
    let link = is_link_strategy(&input.strategy);
    let code = if link {
        None
    } else {
        let length = input
            .code_length
            .unwrap_or(state.settings.get().email.code_length);
        Some(orbitid_core::crypto::random_code(length.max(1) as usize))
    };
    let token = link.then(|| orbitid_core::crypto::random_token(32));
    let id = new_id(id_prefix::VERIFICATION);
    // Serialize issues for the same owner/purpose/identifier. The lock is held
    // until the surrounding transaction ends, and the UPDATE below takes its
    // snapshot after the lock is acquired, so it sees a concurrent insert.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))")
        .bind(&input.owner_id)
        .bind(&input.purpose)
        .bind(&input.identifier)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE verifications SET expires_at = $1 \
         WHERE owner_id = $2 AND purpose = $3 AND identifier = $4 \
         AND verified_at IS NULL AND consumed_at IS NULL",
    )
    .bind(now_ms - 1)
    .bind(&input.owner_id)
    .bind(&input.purpose)
    .bind(&input.identifier)
    .execute(&mut *conn)
    .await?;
    let row = sqlx::query_as::<_, VerificationRow>(
        "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, code_hash, \
             token_hash, attempts, max_attempts, redirect_url, data, expires_at, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12) \
         RETURNING *",
    )
    .bind(&id)
    .bind(&input.purpose)
    .bind(&input.strategy)
    .bind(&input.identifier)
    .bind(&input.owner_id)
    .bind(
        code.as_ref()
            .map(|code| orbitid_core::crypto::hash_low_entropy(&state.env.encryption_key, code)),
    )
    .bind(
        token
            .as_ref()
            .map(|token| orbitid_core::crypto::sha256(token)),
    )
    .bind(input.max_attempts.unwrap_or(5))
    .bind(&input.redirect_url)
    .bind(
        input
            .data
            .as_ref()
            .map(|value| sqlx::types::Json(value.clone())),
    )
    .bind(now_ms + input.lifetime_seconds * 1000)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?;
    Ok(IssuedVerification { row, code, token })
}

pub async fn get_verification_by_id(state: &AppState, id: &str) -> Result<Option<VerificationRow>> {
    let mut conn = state.pool.acquire().await?;
    get_verification_by_id_on(&mut conn, id).await
}

/// [`get_verification_by_id`] on a caller-owned connection.
pub async fn get_verification_by_id_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<VerificationRow>> {
    Ok(
        sqlx::query_as::<_, VerificationRow>("SELECT * FROM verifications WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

/// Most recent verification for a purpose/owner (optionally one identifier).
///
/// The filter and `LIMIT 1` live in SQL: a user can accumulate many expired
/// verifications, and loading all of them just to pick the newest was an
/// unbounded scan on an authentication path.
pub async fn get_verification(
    state: &AppState,
    purpose: &str,
    owner_id: &str,
    identifier: Option<&str>,
) -> Result<Option<VerificationRow>> {
    let row = match identifier {
        Some(identifier) => {
            sqlx::query_as::<_, VerificationRow>(
                "SELECT * FROM verifications \
                 WHERE purpose = $1 AND owner_id = $2 AND identifier = $3 \
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(purpose)
            .bind(owner_id)
            .bind(identifier)
            .fetch_optional(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as::<_, VerificationRow>(
                "SELECT * FROM verifications WHERE purpose = $1 AND owner_id = $2 \
                 ORDER BY created_at DESC LIMIT 1",
            )
            .bind(purpose)
            .bind(owner_id)
            .fetch_optional(&state.pool)
            .await?
        }
    };
    Ok(row)
}

pub async fn get_verification_by_token(
    state: &AppState,
    token: &str,
) -> Result<Option<VerificationRow>> {
    Ok(
        sqlx::query_as::<_, VerificationRow>("SELECT * FROM verifications WHERE token_hash = $1")
            .bind(orbitid_core::crypto::sha256(token))
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub(crate) fn is_expired(row: &VerificationRow) -> bool {
    row.expires_at <= now()
}

fn data_string(row: &VerificationRow, key: &str) -> Option<String> {
    row.data
        .as_ref()
        .and_then(|data| data.0.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Wire status of a verification row (`transferable` is stored explicitly in
/// `data.transferable`).
pub fn verification_json(
    row: Option<&VerificationRow>,
    fallback_strategy: Option<&str>,
) -> Option<VerificationJson> {
    let row = row?;
    let strategy = row.strategy.clone();
    let nonce = data_string(row, "nonce");
    if row
        .data
        .as_ref()
        .and_then(|data| data.0.get("transferable"))
        .and_then(Value::as_bool)
        == Some(true)
        && row.verified_at.is_none()
    {
        return Some(VerificationJson {
            status: VerificationStatus::Transferable,
            strategy: fallback_strategy.unwrap_or(&strategy).to_string(),
            attempts: Some(row.attempts),
            expire_at: Some(row.expires_at),
            external_verification_redirect_url: None,
            error: None,
            nonce: None,
        });
    }
    if row.verified_at.is_some() || row.consumed_at.is_some() {
        return Some(VerificationJson {
            status: VerificationStatus::Verified,
            strategy,
            attempts: Some(row.attempts),
            expire_at: Some(row.expires_at),
            external_verification_redirect_url: None,
            error: None,
            nonce,
        });
    }
    if row.attempts >= row.max_attempts {
        return Some(VerificationJson {
            status: VerificationStatus::Failed,
            strategy,
            attempts: Some(row.attempts),
            expire_at: Some(row.expires_at),
            external_verification_redirect_url: None,
            error: Some(VerificationErrorJson {
                code: error_codes::TOO_MANY_ATTEMPTS.into(),
                message: "Too many attempts".into(),
            }),
            nonce: None,
        });
    }
    if is_expired(row) {
        return Some(VerificationJson {
            status: VerificationStatus::Expired,
            strategy,
            attempts: Some(row.attempts),
            expire_at: Some(row.expires_at),
            external_verification_redirect_url: None,
            error: Some(VerificationErrorJson {
                code: error_codes::VERIFICATION_EXPIRED.into(),
                message: "Verification expired".into(),
            }),
            nonce: None,
        });
    }
    Some(VerificationJson {
        status: VerificationStatus::Unverified,
        strategy,
        attempts: Some(row.attempts),
        expire_at: Some(row.expires_at),
        external_verification_redirect_url: None,
        error: None,
        nonce,
    })
}

pub use crate::code_check::{
    check_code, check_code_on, commit_code_refusal, CodeCheck, CodeRefusal,
};

/// Marks a magic link as clicked. Cross-device: the sign-in attempt poll then
/// sees it.
pub async fn consume_link(state: &AppState, row: &VerificationRow) -> Result<VerificationRow> {
    let mut conn = state.pool.acquire().await?;
    consume_link_on(&mut conn, row).await
}

/// [`consume_link`] on a caller-owned connection. A second consumer observes
/// the verified row; only one statement ever performs the transition.
pub async fn consume_link_on(
    conn: &mut sqlx::PgConnection,
    row: &VerificationRow,
) -> Result<VerificationRow> {
    if row.verified_at.is_some() {
        return Ok(row.clone());
    }
    let now_ms = now();
    let claimed = sqlx::query_as::<_, VerificationRow>(
        "UPDATE verifications SET consumed_at = $1, verified_at = $1 \
         WHERE id = $2 AND consumed_at IS NULL AND expires_at > $1 RETURNING *",
    )
    .bind(now_ms)
    .bind(&row.id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(claimed) = claimed {
        return Ok(claimed);
    }
    let current = get_verification_by_id_on(conn, &row.id).await?;
    if current.as_ref().and_then(|row| row.verified_at).is_some() {
        return current.ok_or_else(|| OrbitError::internal("verification disappeared"));
    }
    Err(OrbitError::unprocessable(
        error_codes::VERIFICATION_EXPIRED,
        "That link has expired",
    ))
}

/// `<baseUrl>/v1/verify?token=…`.
pub fn magic_link_url(state: &AppState, token: &str, params: &[(&str, Option<&str>)]) -> String {
    let mut url = match url::Url::parse(&format!(
        "{}/v1/verify",
        state.env.base_url.trim_end_matches('/')
    )) {
        Ok(url) => url,
        Err(_) => return format!("{}/v1/verify?token={token}", state.env.base_url),
    };
    url.query_pairs_mut().append_pair("token", token);
    for (key, value) in params {
        if let Some(value) = value {
            url.query_pairs_mut().append_pair(key, value);
        }
    }
    url.to_string()
}
