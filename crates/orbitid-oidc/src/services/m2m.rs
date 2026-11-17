//! Machine-to-machine identities: machine secrets, opaque/JWT tokens,
//! revocation. Ported from `services/m2m.ts`.

use serde_json::{Map, Value};

use orbitid_core::crypto::{random_token, safe_equal, sha256};
use orbitid_core::error::{error_codes, OrbitError};

/// Service results: plain OrbitID errors.
type Result<T> = std::result::Result<T, OrbitError>;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{M2mTokenRow, MachineRow};
use orbitid_core::resources::{M2mMachineJson, M2mTokenJson};
use orbitid_core::state::AppState;

use orbitid_credentials::jwt::{verify_jws, Jwk, JwkSet, JwsAlgorithm, VerifyOptions};
use orbitid_credentials::keys::get_jwks;
use orbitid_credentials::session::SignJwtOptions;
use orbitid_credentials::sign_jwt;

pub const MACHINE_SECRET_PREFIX: &str = "mk_";
pub const MACHINE_TOKEN_PREFIX: &str = "mt_";
pub const M2M_TOKEN_AUDIENCE: &str = "orbitid-m2m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenFormat {
    Opaque,
    Jwt,
}

pub fn serialize_machine(row: &MachineRow) -> M2mMachineJson {
    M2mMachineJson {
        object: "machine".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        scoped_machines: row.scoped_machines.0.clone(),
        default_token_ttl: row.default_token_ttl,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn serialize_machine_token(row: &M2mTokenRow, token: Option<&str>) -> M2mTokenJson {
    M2mTokenJson {
        object: "machine_token".into(),
        id: row.id.clone(),
        machine_id: row.machine_id.clone(),
        token: token.map(str::to_string),
        claims: row.claims.as_ref().map(|claims| claims.0.clone()),
        revoked: row.revoked,
        expired: row.expires_at.is_some_and(|expires| expires <= now()),
        expiration: row.expires_at,
        created_at: row.created_at,
    }
}

pub fn generate_machine_secret() -> String {
    format!("{MACHINE_SECRET_PREFIX}{}", random_token(24))
}

pub async fn get_machine(state: &AppState, id: &str) -> Result<Option<MachineRow>> {
    Ok(
        sqlx::query_as::<_, MachineRow>("SELECT * FROM machines WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn list_machines(
    state: &AppState,
    limit: i64,
    offset: i64,
) -> Result<(Vec<MachineRow>, i64)> {
    let rows = sqlx::query_as::<_, MachineRow>(
        "SELECT * FROM machines ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM machines")
        .fetch_one(&state.pool)
        .await?;
    Ok((rows, total))
}

pub async fn require_machine(state: &AppState, id: &str) -> Result<MachineRow> {
    get_machine(state, id)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Machine not found"))
}

#[derive(Debug, Clone, Default)]
pub struct CreateMachineInput {
    pub name: String,
    pub scoped_machines: Option<Vec<String>>,
    pub default_token_ttl: Option<i64>,
}

pub async fn create_machine(
    state: &AppState,
    input: CreateMachineInput,
) -> Result<(MachineRow, String)> {
    let secret = generate_machine_secret();
    let now_ms = now();
    let row = MachineRow {
        id: new_id(id_prefix::MACHINE),
        name: input.name,
        secret_hash: sha256(&secret),
        scoped_machines: sqlx::types::Json(input.scoped_machines.unwrap_or_default()),
        default_token_ttl: input.default_token_ttl.unwrap_or(3600),
        created_at: now_ms,
        updated_at: now_ms,
    };
    sqlx::query(
        "INSERT INTO machines (id, name, secret_hash, scoped_machines, default_token_ttl, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&row.id)
    .bind(&row.name)
    .bind(&row.secret_hash)
    .bind(&row.scoped_machines)
    .bind(row.default_token_ttl)
    .bind(row.created_at)
    .bind(row.updated_at)
    .execute(&state.pool)
    .await?;
    Ok((row, secret))
}

#[derive(Debug, Clone, Default)]
pub struct UpdateMachineInput {
    pub name: Option<String>,
    pub scoped_machines: Option<Vec<String>>,
    pub default_token_ttl: Option<i64>,
}

pub async fn update_machine(
    state: &AppState,
    row: &MachineRow,
    patch: UpdateMachineInput,
) -> Result<MachineRow> {
    let name = patch.name.unwrap_or_else(|| row.name.clone());
    let scoped = patch
        .scoped_machines
        .map(sqlx::types::Json)
        .unwrap_or_else(|| row.scoped_machines.clone());
    let ttl = patch.default_token_ttl.unwrap_or(row.default_token_ttl);
    sqlx::query(
        "UPDATE machines SET name = $2, scoped_machines = $3, default_token_ttl = $4, updated_at = $5 \
         WHERE id = $1",
    )
    .bind(&row.id)
    .bind(&name)
    .bind(&scoped)
    .bind(ttl)
    .bind(now())
    .execute(&state.pool)
    .await?;
    require_machine(state, &row.id).await
}

/// Deleting a machine revokes it everywhere; its tokens cascade.
pub async fn delete_machine(state: &AppState, row: &MachineRow) -> Result<()> {
    sqlx::query("DELETE FROM machines WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

/// Adds `scoped_machine_id` to the machine's scopes. Idempotent.
pub async fn add_machine_scope(
    state: &AppState,
    row: &MachineRow,
    scoped_machine_id: &str,
) -> Result<MachineRow> {
    if scoped_machine_id == row.id {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "A machine cannot scope itself",
        )
        .with_meta(serde_json::json!({ "param_name": "scoped_machine_id" })));
    }
    let target = require_machine(state, scoped_machine_id).await?;
    let mut scopes = row.scoped_machines.0.clone();
    if !scopes.contains(&target.id) {
        scopes.push(target.id);
    }
    update_machine(
        state,
        row,
        UpdateMachineInput {
            scoped_machines: Some(scopes),
            ..Default::default()
        },
    )
    .await
}

/// Rotates the machine secret; the previous secret stops working immediately.
pub async fn rotate_machine_secret(
    state: &AppState,
    row: &MachineRow,
) -> Result<(MachineRow, String)> {
    let secret = generate_machine_secret();
    sqlx::query("UPDATE machines SET secret_hash = $2, updated_at = $3 WHERE id = $1")
        .bind(&row.id)
        .bind(sha256(&secret))
        .bind(now())
        .execute(&state.pool)
        .await?;
    Ok((require_machine(state, &row.id).await?, secret))
}

pub async fn authenticate_machine_secret(
    state: &AppState,
    secret: &str,
) -> Result<Option<MachineRow>> {
    if !secret.starts_with(MACHINE_SECRET_PREFIX) {
        return Ok(None);
    }
    let hash = sha256(secret);
    let row = sqlx::query_as::<_, MachineRow>("SELECT * FROM machines WHERE secret_hash = $1")
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await?;
    Ok(row.filter(|row| safe_equal(&row.secret_hash, &hash)))
}

/// Claims that identify tokens or sessions; a machine token must never forge them.
const RESERVED_CLAIMS: [&str; 13] = [
    "iss", "aud", "sub", "exp", "iat", "nbf", "jti", "azp", "sid", "sts", "fva", "act", "scopes",
];

fn reserved_claim(key: &str) -> bool {
    RESERVED_CLAIMS.contains(&key) || key.starts_with("org_")
}

#[derive(Debug, Clone, Default)]
pub struct IssueTokenInput {
    pub seconds_until_expiration: Option<i64>,
    pub claims: Option<Map<String, Value>>,
    pub token_format: Option<TokenFormat>,
}

/// Issues an `mt_...` opaque token (hashed at rest) or an RS256 JWT bound to
/// the machine.
pub async fn issue_machine_token(
    state: &AppState,
    machine: &MachineRow,
    input: IssueTokenInput,
) -> Result<(M2mTokenRow, String)> {
    let format = input.token_format.unwrap_or(TokenFormat::Opaque);
    let ttl = input
        .seconds_until_expiration
        .unwrap_or(machine.default_token_ttl);
    if ttl <= 0 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "seconds_until_expiration must be positive",
        )
        .with_meta(serde_json::json!({ "param_name": "seconds_until_expiration" })));
    }
    let expires_at = now() + ttl * 1000;
    let id = new_id(id_prefix::M2M_TOKEN);
    let mut claims = input.claims.unwrap_or_default();
    let reserved: Vec<&str> = claims
        .keys()
        .filter(|key| reserved_claim(key))
        .map(String::as_str)
        .collect();
    if !reserved.is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("claims may not set {}", reserved.join(", ")),
        )
        .with_meta(serde_json::json!({ "param_name": "claims" })));
    }
    claims.insert("sub".into(), Value::String(machine.id.clone()));
    claims.insert(
        "scopes".into(),
        serde_json::json!(machine.scoped_machines.0.clone()),
    );
    claims.insert("jti".into(), Value::String(id.clone()));

    let token = match format {
        TokenFormat::Jwt => {
            sign_jwt(
                state,
                &claims,
                SignJwtOptions {
                    expires_in_seconds: ttl,
                    audience: Some(M2M_TOKEN_AUDIENCE.to_string()),
                    issuer: Some(state.env.base_url.clone()),
                    kid: None,
                },
            )
            .await?
        }
        TokenFormat::Opaque => format!("{MACHINE_TOKEN_PREFIX}{}", random_token(24)),
    };

    let row = M2mTokenRow {
        id,
        machine_id: machine.id.clone(),
        token_hash: sha256(&token),
        claims: Some(sqlx::types::Json(claims)),
        revoked: false,
        expires_at: Some(expires_at),
        created_at: now(),
    };
    sqlx::query(
        "INSERT INTO m2m_tokens (id, machine_id, token_hash, claims, revoked, expires_at, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&row.id)
    .bind(&row.machine_id)
    .bind(&row.token_hash)
    .bind(&row.claims)
    .bind(row.revoked)
    .bind(row.expires_at)
    .bind(row.created_at)
    .execute(&state.pool)
    .await?;
    Ok((row, token))
}

/// Resolves the instance signing key (by kid when the JWT names one).
async fn instance_verify_key(state: &AppState, kid: Option<&str>) -> Result<JwkSet> {
    let keys = get_jwks(state).await?;
    let parsed: Vec<Jwk> = keys
        .iter()
        .filter_map(|value| Jwk::from_value(value).ok())
        .collect();
    match kid {
        Some(kid) => {
            let matching: Vec<Jwk> = parsed
                .into_iter()
                .filter(|key| key.kid() == Some(kid))
                .collect();
            if matching.is_empty() {
                return Err(OrbitError::unauthorized(
                    error_codes::AUTHORIZATION_INVALID,
                    "Unknown signing key",
                ));
            }
            Ok(JwkSet::new(matching))
        }
        None => Ok(JwkSet::new(parsed)),
    }
}

/// Verifies an opaque machine token or a JWT machine token.
pub async fn verify_machine_token(
    state: &AppState,
    token: &str,
) -> Result<(M2mTokenRow, MachineRow)> {
    let invalid =
        |message: &str| OrbitError::unauthorized(error_codes::AUTHORIZATION_INVALID, message);
    if token.is_empty() {
        return Err(invalid("Invalid machine token"));
    }
    let Some(row) =
        sqlx::query_as::<_, M2mTokenRow>("SELECT * FROM m2m_tokens WHERE token_hash = $1")
            .bind(sha256(token))
            .fetch_optional(&state.pool)
            .await?
    else {
        return Err(invalid("Invalid machine token"));
    };
    if row.revoked {
        return Err(invalid("Machine token has been revoked"));
    }
    if row.expires_at.is_some_and(|expires| expires <= now()) {
        return Err(invalid("Machine token has expired"));
    }
    let Some(machine) = get_machine(state, &row.machine_id).await? else {
        return Err(invalid("Machine no longer exists"));
    };

    if !token.starts_with(MACHINE_TOKEN_PREFIX) {
        let header_payload = token.split('.').next().unwrap_or("");
        let kid = decode_header_kid(header_payload);
        let keys = instance_verify_key(state, kid.as_deref()).await?;
        let verified = verify_jws(
            token,
            &keys,
            &VerifyOptions {
                algorithms: vec![JwsAlgorithm::RS256],
                issuer: Some(vec![state.env.base_url.clone()]),
                audience: Some(vec![M2M_TOKEN_AUDIENCE.to_string()]),
                clock_tolerance_seconds: 0,
            },
        )
        .map_err(|_| invalid("Machine token signature is invalid"))?;
        if verified.get("sub").and_then(Value::as_str) != Some(machine.id.as_str()) {
            return Err(invalid("Machine token subject mismatch"));
        }
    }
    Ok((row, machine))
}

fn decode_header_kid(part: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(part)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.get("kid").and_then(Value::as_str).map(str::to_string)
}

pub async fn revoke_machine_token(state: &AppState, row: &M2mTokenRow) -> Result<M2mTokenRow> {
    let revoked = sqlx::query_as::<_, M2mTokenRow>(
        "UPDATE m2m_tokens SET revoked = true WHERE id = $1 AND revoked = false RETURNING *",
    )
    .bind(&row.id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(revoked.unwrap_or_else(|| {
        let mut row = row.clone();
        row.revoked = true;
        row
    }))
}

pub async fn list_machine_tokens(
    state: &AppState,
    machine_id: Option<&str>,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
) -> Result<(Vec<M2mTokenRow>, i64)> {
    let raw = order_by.unwrap_or("-created_at").trim();
    let descending = raw.starts_with('-');
    let column = if raw.trim_start_matches('-') == "expires_at" {
        "expires_at"
    } else {
        "created_at"
    };
    let direction = if descending { "DESC" } else { "ASC" };
    let rows = sqlx::query_as::<_, M2mTokenRow>(&format!(
        "SELECT * FROM m2m_tokens WHERE ($1::text IS NULL OR machine_id = $1) \
         ORDER BY {column} {direction} LIMIT $2 OFFSET $3"
    ))
    .bind(machine_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM m2m_tokens WHERE ($1::text IS NULL OR machine_id = $1)",
    )
    .bind(machine_id)
    .fetch_one(&state.pool)
    .await?;
    Ok((rows, total))
}

pub async fn require_machine_token(state: &AppState, id: &str) -> Result<M2mTokenRow> {
    sqlx::query_as::<_, M2mTokenRow>("SELECT * FROM m2m_tokens WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Machine token not found")
        })
}
