//! Session serialization, including the batched form used by client/list
//! endpoints so a list of N sessions does not become N extra user queries.

use std::collections::HashMap;

use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::models::{SessionRow, UserRow};
use orbitid_core::resources::{
    AuthMethod, PublicUserData, SessionActivityJson, SessionJson, SessionStatus, TokenJson,
};
use orbitid_core::state::AppState;
use serde_json::Value;

use super::user::{load_relations_for_users, public_user_data_for, user_json, UserRelations};
use crate::user_roles::{role_claims_for_user, role_claims_for_users, RoleClaims};

#[derive(Debug, Clone, Default)]
pub struct SessionSerializeOptions {
    pub with_user: bool,
    pub last_token: Option<String>,
}

pub(crate) fn parse_session_status(value: &str) -> SessionStatus {
    match value {
        "active" => SessionStatus::Active,
        "ended" => SessionStatus::Ended,
        "expired" => SessionStatus::Expired,
        "removed" => SessionStatus::Removed,
        "abandoned" => SessionStatus::Abandoned,
        "replaced" => SessionStatus::Replaced,
        "revoked" => SessionStatus::Revoked,
        "pending" => SessionStatus::Pending,
        _ => SessionStatus::Active,
    }
}

pub(crate) fn parse_auth_method(value: &str) -> Option<AuthMethod> {
    match value {
        "password" => Some(AuthMethod::Password),
        "email_code" => Some(AuthMethod::EmailCode),
        "email_link" => Some(AuthMethod::EmailLink),
        "sms" => Some(AuthMethod::Sms),
        "passkey" => Some(AuthMethod::Passkey),
        "oauth" => Some(AuthMethod::Oauth),
        "sso" => Some(AuthMethod::Sso),
        "ticket" => Some(AuthMethod::Ticket),
        _ => None,
    }
}

fn minutes_since(at: Option<i64>) -> i64 {
    match at {
        Some(value) if value != 0 => (now() - value) / 60_000,
        _ => -1,
    }
}

fn activity(row: &SessionRow) -> SessionActivityJson {
    let user_agent = row.user_agent.as_deref().unwrap_or("");
    let last_word = user_agent.split(' ').next_back().unwrap_or("");
    let browser_name = last_word.split('/').next().unwrap_or("");
    let browser_version = user_agent.split('/').next_back().unwrap_or("");
    SessionActivityJson {
        id: row.id.clone(),
        is_mobile: user_agent.to_lowercase().contains("mobile"),
        ip_address: row.ip.clone().unwrap_or_default(),
        city: row.city.clone(),
        country: row.country.clone(),
        browser_name: browser_name.to_string(),
        browser_version: browser_version.to_string(),
        device_type: String::new(),
    }
}

fn base_json(
    row: &SessionRow,
    public: Option<PublicUserData>,
    opts: &SessionSerializeOptions,
    trusted_device_skip: bool,
) -> SessionJson {
    let last_active_token = opts.last_token.as_ref().map(|jwt| TokenJson {
        object: "token".into(),
        jwt: jwt.clone(),
    });
    SessionJson {
        object: "session".into(),
        id: row.id.clone(),
        status: parse_session_status(&row.status),
        expire_at: row.expire_at,
        abandon_at: row.abandon_at,
        last_active_at: row.last_active_at,
        last_active_organization_id: row.last_active_organization_id.clone(),
        actor: row
            .actor
            .as_ref()
            .map(|actor| actor.0.clone())
            .filter(|value| !value.is_null()),
        user: None,
        public_user_data: public,
        factor_verification_age: Some([
            minutes_since(row.first_factor_verified_at),
            minutes_since(row.second_factor_verified_at),
        ]),
        second_factor_skipped_by_trusted_device: trusted_device_skip.then_some(true),
        sign_in_method: row.auth_method.as_deref().and_then(parse_auth_method),
        last_active_token,
        latest_activity: Some(activity(row)),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn sign_in_state_has_trusted_device(state: &Value) -> bool {
    state
        .get("second")
        .and_then(|second| second.get("strategy"))
        .and_then(Value::as_str)
        == Some("trusted_device")
}

async fn user_json_for(
    state: &AppState,
    user: &UserRow,
    relations: &UserRelations,
    with_user: bool,
    claims: Option<&RoleClaims>,
) -> Result<Option<orbitid_core::resources::UserJson>> {
    if !with_user {
        return Ok(None);
    }
    let claims = match claims {
        Some(claims) => claims.clone(),
        None => role_claims_for_user(state, &user.id).await?,
    };
    Ok(Some(user_json(
        state,
        user,
        relations,
        claims.roles,
        claims.permissions,
        super::UserSerializeOptions::default(),
    )))
}

/// Serializes one session. Runs the same queries as `serializeSession`.
pub async fn serialize_session(
    state: &AppState,
    row: &SessionRow,
    opts: SessionSerializeOptions,
) -> Result<SessionJson> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&state.pool)
        .await?;
    let mut public = None;
    let mut json_user = None;
    if let Some(user) = user.as_ref() {
        let relations = super::user::load_user_relations(state, user).await?;
        public = Some(public_user_data_for(user, &relations));
        json_user = user_json_for(state, user, &relations, opts.with_user, None).await?;
    }
    let sign_in_state: Option<Value> = sqlx::query_scalar(
        "SELECT state FROM sign_ins WHERE created_session_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&row.id)
    .fetch_optional(&state.pool)
    .await?;
    let skip = sign_in_state
        .as_ref()
        .map(sign_in_state_has_trusted_device)
        .unwrap_or(false);
    let mut json = base_json(row, public, &opts, skip);
    json.user = json_user;
    Ok(json)
}

async fn user_json_for_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    relations: &UserRelations,
    with_user: bool,
) -> Result<Option<orbitid_core::resources::UserJson>> {
    if !with_user {
        return Ok(None);
    }
    let claims = crate::user_roles::role_claims_for_user_on(conn, &user.id).await?;
    Ok(Some(user_json(
        state,
        user,
        relations,
        claims.roles,
        claims.permissions,
        super::UserSerializeOptions::default(),
    )))
}

/// [`serialize_session`] on a caller-owned connection, for webhook payloads
/// that commit in the same transaction as the session change. Every query uses
/// `conn`; the pool is never touched.
pub async fn serialize_session_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SessionRow,
    opts: SessionSerializeOptions,
) -> Result<SessionJson> {
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&row.user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let mut public = None;
    let mut json_user = None;
    if let Some(user) = user.as_ref() {
        let relations = super::user::load_user_relations_on(conn, user).await?;
        public = Some(public_user_data_for(user, &relations));
        json_user = user_json_for_on(conn, state, user, &relations, opts.with_user).await?;
    }
    let sign_in_state: Option<Value> = sqlx::query_scalar(
        "SELECT state FROM sign_ins WHERE created_session_id = $1 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&row.id)
    .fetch_optional(&mut *conn)
    .await?;
    let skip = sign_in_state
        .as_ref()
        .map(sign_in_state_has_trusted_device)
        .unwrap_or(false);
    let mut json = base_json(row, public, &opts, skip);
    json.user = json_user;
    Ok(json)
}

async fn load_sign_in_states(
    state: &AppState,
    session_ids: &[String],
) -> Result<HashMap<String, bool>> {
    let mut map = HashMap::new();
    if session_ids.is_empty() {
        return Ok(map);
    }
    let rows: Vec<(Option<String>, Value)> = sqlx::query_as(
        "SELECT created_session_id, state FROM sign_ins WHERE created_session_id = ANY($1)",
    )
    .bind(session_ids)
    .fetch_all(&state.pool)
    .await?;
    for (session_id, value) in rows {
        if let Some(session_id) = session_id {
            map.entry(session_id)
                .or_insert_with(|| sign_in_state_has_trusted_device(&value));
        }
    }
    Ok(map)
}

/// Batch serializer for client JSON and list endpoints: users and their
/// identifications are loaded in single queries instead of one per session.
pub async fn serialize_sessions(
    state: &AppState,
    rows: &[SessionRow],
    with_user: bool,
    last_tokens: &HashMap<String, String>,
) -> Result<Vec<SessionJson>> {
    let user_ids: Vec<String> = {
        let mut ids: Vec<String> = rows.iter().map(|row| row.user_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let users: HashMap<String, UserRow> =
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = ANY($1)")
            .bind(&user_ids)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .map(|user| (user.id.clone(), user))
            .collect();
    let relations = load_relations_for_users(state, &user_ids).await?;
    let claims = role_claims_for_users(state, &user_ids).await?;
    let session_ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let mut sign_in_states = load_sign_in_states(state, &session_ids).await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let opts = SessionSerializeOptions {
            with_user,
            last_token: last_tokens.get(&row.id).cloned(),
        };
        let user = users.get(&row.user_id);
        let relations_entry = relations.get(&row.user_id);
        let public = user
            .zip(relations_entry)
            .map(|(user, relations)| public_user_data_for(user, relations));
        let json_user = match user.zip(relations_entry) {
            Some((user, relations)) => {
                user_json_for(state, user, relations, with_user, claims.get(&user.id)).await?
            }
            None => None,
        };
        let skip = sign_in_states.remove(&row.id).unwrap_or(false);
        let mut json = base_json(row, public, &opts, skip);
        json.user = json_user;
        out.push(json);
    }
    Ok(out)
}
