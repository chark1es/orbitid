//! `POST /oauth/m2m/token`: machine-secret `client_credentials` minting,
//! ported from `modules/oidc/machine.ts`.

use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::Deserialize;
use serde_json::{json, Value};

use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;

use crate::services::m2m::{
    authenticate_machine_secret, issue_machine_token, serialize_machine_token, IssueTokenInput,
};
use crate::services::oidc::applications::parse_basic_authorization;
use crate::services::oidc::shared::OAuthError;

use super::m2m::{opt_i64, parse_claims, token_format};

/// Public machine-token minting (`POST /oauth/m2m/token`).
pub fn router() -> Router<AppState> {
    Router::new().route("/oauth/m2m/token", post(oauth_machine_token))
}

#[derive(Debug, Default, Deserialize)]
struct OAuthMachineBody {
    #[serde(default)]
    grant_type: Option<String>,
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    machine_secret: Option<String>,
    #[serde(default, deserialize_with = "opt_i64")]
    seconds_until_expiration: Option<i64>,
    #[serde(default)]
    claims: Option<Value>,
    #[serde(default)]
    token_format: Option<String>,
}

async fn oauth_machine_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<OAuthMachineBody>,
) -> Result<Response, OAuthError> {
    if let Some(grant_type) = body.grant_type.as_deref().filter(|value| !value.is_empty()) {
        if grant_type != "client_credentials" {
            return Err(OAuthError::bad_request(
                "unsupported_grant_type",
                "Only client_credentials is supported",
            ));
        }
    }
    let basic = parse_basic_authorization(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    );
    let machine_id = basic
        .as_ref()
        .map(|basic| basic.client_id.clone())
        .or_else(|| body.machine_id.clone());
    let machine_secret = basic
        .as_ref()
        .map(|basic| basic.client_secret.clone())
        .or_else(|| body.machine_secret.clone());
    let (Some(machine_id), Some(machine_secret)) = (machine_id, machine_secret) else {
        return Err(OAuthError::invalid_client(
            "machine_id and machine_secret are required",
        ));
    };
    let machine = authenticate_machine_secret(&state, &machine_secret)
        .await
        .map_err(|error| OAuthError::new(error.status, error.code, error.message))?
        .filter(|machine| machine.id == machine_id)
        .ok_or_else(|| OAuthError::invalid_client("Machine authentication failed"))?;
    let claims = parse_claims(body.claims.clone())
        .map_err(|error| OAuthError::bad_request("invalid_request", error.message))?;
    let format = token_format(body.token_format.as_deref())
        .map_err(|error| OAuthError::bad_request("invalid_request", error.message))?;
    let (row, token) = issue_machine_token(
        &state,
        &machine,
        IssueTokenInput {
            seconds_until_expiration: body.seconds_until_expiration,
            claims,
            token_format: Some(format),
        },
    )
    .await
    .map_err(|error| OAuthError::new(error.status, error.code, error.message))?;
    let expires_in = ((row.expires_at.unwrap_or_else(orbitid_core::http::now)
        - orbitid_core::http::now()) as f64
        / 1000.0)
        .round()
        .max(0.0) as i64;
    Ok(axum::Json(json!({
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": expires_in,
        "token_format": body.token_format.as_deref().unwrap_or("opaque"),
        "machine_token": serialize_machine_token(&row, None),
        "scope": machine.scoped_machines.0.join(" "),
    }))
    .into_response())
}
