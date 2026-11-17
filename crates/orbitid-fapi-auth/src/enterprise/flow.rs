use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::keys::cookies::CLIENT;
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::state::AppState;
use orbitid_identity::trusted_devices::{
    apply_trusted_device_cookie, read_trusted_device_token, TrustedDeviceCookie,
};

use crate::external::ExternalIdentityFlow;
use crate::util::safe_origin;

const ENTERPRISE_STATE_TTL_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct EnterpriseFlow {
    pub(super) kind: String,
    pub(super) client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) user_id: Option<String>,
    pub(super) redirect_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) action_complete_redirect_url: Option<String>,
    pub(super) connection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) browser_hash: Option<String>,
}

pub(super) async fn create_enterprise_state(
    state: &AppState,
    provider: &str,
    flow: &EnterpriseFlow,
    code_verifier: Option<&str>,
    nonce: Option<&str>,
) -> Result<String> {
    let value = orbitid_core::crypto::random_token(24);
    sqlx::query(
        "INSERT INTO oauth_states (state, provider, code_verifier, nonce, flow, expires_at) \
         VALUES ($1,$2,$3,$4,$5,$6)",
    )
    .bind(&value)
    .bind(provider)
    .bind(code_verifier)
    .bind(nonce)
    .bind(sqlx::types::Json(
        serde_json::to_value(flow).unwrap_or_default(),
    ))
    .bind(orbitid_core::http::now() + ENTERPRISE_STATE_TTL_MS)
    .execute(&state.pool)
    .await?;
    Ok(value)
}

pub(super) struct TakenState {
    pub(super) flow: EnterpriseFlow,
    pub(super) code_verifier: Option<String>,
    pub(super) nonce: Option<String>,
}

pub(super) async fn take_enterprise_state(
    state: &AppState,
    value: &str,
    provider: &str,
) -> Result<Option<TakenState>> {
    if value.is_empty() {
        return Ok(None);
    }
    let row = sqlx::query_as::<_, orbitid_core::models::OauthStateRow>(
        "DELETE FROM oauth_states WHERE state = $1 AND provider = $2 AND expires_at > $3 \
         RETURNING state, provider, code_verifier, nonce, flow, expires_at",
    )
    .bind(value)
    .bind(provider)
    .bind(orbitid_core::http::now())
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|row| TakenState {
        flow: serde_json::from_value(row.flow.0).unwrap_or_default(),
        code_verifier: row.code_verifier,
        nonce: row.nonce,
    }))
}

pub(super) async fn peek_enterprise_state(
    state: &AppState,
    value: &str,
    provider: &str,
) -> Result<bool> {
    if value.is_empty() {
        return Ok(false);
    }
    let row = sqlx::query_as::<_, orbitid_core::models::OauthStateRow>(
        "SELECT state, provider, code_verifier, nonce, flow, expires_at FROM oauth_states WHERE state = $1",
    )
    .bind(value)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row
        .map(|row| row.provider == provider && row.expires_at > orbitid_core::http::now())
        .unwrap_or(false))
}

pub(super) fn assert_allowed_redirect_url(
    state: &AppState,
    url: &str,
    param: &str,
) -> Result<String> {
    let parsed = url::Url::parse(url).map_err(|_| {
        OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} is not a valid URL"),
        )
        .with_meta(serde_json::json!({ "param_name": param }))
    })?;
    let settings = state.settings.get();
    let app = &settings.application;
    let origin = parsed.origin().ascii_serialization();
    let allowed = std::iter::once(&app.home_url)
        .chain(app.allowed_origins.iter())
        .chain(app.allowed_redirect_origins.iter())
        .filter_map(|value| safe_origin(value))
        .any(|candidate| candidate == origin);
    let dev_localhost = app.development_mode && crate::util::is_dev_localhost(&origin);
    if !allowed && !dev_localhost {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("{param} origin is not allowed"),
        )
        .with_meta(serde_json::json!({ "param_name": param })));
    }
    Ok(url.to_string())
}

pub(super) async fn flow_from_query(
    state: &AppState,
    headers: &HeaderMap,
    query: &std::collections::HashMap<String, String>,
    connection: &EnterpriseConnectionRow,
) -> Result<(EnterpriseFlow, String)> {
    let token = orbitid_core::http::cookies::get_cookie(headers, CLIENT);
    let client = match token {
        Some(token) => {
            sqlx::query_as::<_, orbitid_core::models::ClientRow>(
                "SELECT * FROM clients WHERE token_hash = $1",
            )
            .bind(orbitid_core::crypto::sha256(token))
            .fetch_optional(&state.pool)
            .await?
        }
        None => None,
    };
    let client = match client {
        Some(client) => client,
        None => {
            return Err(OrbitError::unprocessable(
                error_codes::CLIENT_STATE_INVALID,
                "This browser has no sign-in in progress",
            )
            .with_meta(serde_json::json!({ "param_name": "client_id" })))
        }
    };
    if let Some(requested) = query.get("client_id") {
        if requested != &client.id {
            return Err(OrbitError::unprocessable(
                error_codes::CLIENT_STATE_INVALID,
                "This browser has no sign-in in progress",
            )
            .with_meta(serde_json::json!({ "param_name": "client_id" })));
        }
    }
    let home = state.settings.get().application.home_url.clone();
    let redirect = query.get("redirect_url").cloned().unwrap_or(home);
    let redirect = assert_allowed_redirect_url(state, &redirect, "redirect_url")?;
    let action_complete = match query.get("action_complete_redirect_url") {
        Some(value) => Some(assert_allowed_redirect_url(
            state,
            value,
            "action_complete_redirect_url",
        )?),
        None => None,
    };
    let (nonce, browser_hash) = orbitid_federation::bind_browser();
    Ok((
        EnterpriseFlow {
            kind: if query.get("action").map(String::as_str) == Some("sign_up") {
                "sign_up".into()
            } else {
                "sign_in".into()
            },
            client_id: client.id,
            owner_id: None,
            user_id: None,
            redirect_url: redirect,
            action_complete_redirect_url: action_complete,
            connection_id: connection.id.clone(),
            browser_hash: Some(browser_hash),
        },
        nonce,
    ))
}

pub(super) fn identity_flow(flow: &EnterpriseFlow, headers: &HeaderMap) -> ExternalIdentityFlow {
    ExternalIdentityFlow {
        client_id: flow.client_id.clone(),
        kind: flow.kind.clone(),
        owner_id: flow.owner_id.clone(),
        user_id: flow.user_id.clone(),
        redirect_url: flow.redirect_url.clone(),
        action_complete_redirect_url: flow.action_complete_redirect_url.clone(),
        trusted_device_token: read_trusted_device_token(headers),
    }
}

pub(super) fn enterprise_error(code: &str, message: &str) -> OrbitError {
    OrbitError::bad_request(code, message)
}

pub(super) fn apply_trusted(
    state: &AppState,
    headers_out: &mut Vec<String>,
    result: &crate::external::ExternalIdentityResult,
) {
    let mut trusted = HeaderMap::new();
    apply_trusted_device_cookie(
        &mut trusted,
        state,
        &TrustedDeviceCookie {
            token: result.trusted_device_token.clone(),
            expires_at: result.trusted_device_expires_at,
            clear: result.clear_trusted_device,
        },
    );
    for value in trusted.get_all(axum::http::header::SET_COOKIE) {
        if let Ok(value) = value.to_str() {
            headers_out.push(value.to_string());
        }
    }
}
