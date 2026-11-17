//! RP-initiated logout (`end_session_endpoint`), ported from
//! `services/oidc/logout.ts`.

use orbitid_core::models::SessionRow;
use orbitid_core::state::AppState;
use serde_json::Value;

use orbitid_credentials::jwt::{
    decode_jwt_payload, verify_jws, Jwk, JwkError, JwkSet, JwsAlgorithm, VerifyOptions,
};
use orbitid_credentials::keys::get_jwks;
use orbitid_identity::sessions::end_session;

use super::applications::{
    assert_post_logout_redirect_uri, get_application_by_client_id, ApplicationRow,
};
use super::shared::OAuthError;

#[derive(Debug, Clone, Default)]
pub struct LogoutInput {
    pub id_token_hint: Option<String>,
    pub client_id: Option<String>,
    pub post_logout_redirect_uri: Option<String>,
    pub state: Option<String>,
    pub issuer: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LogoutResult {
    pub redirect_to: String,
    pub application: Option<ApplicationRow>,
    pub session_id: Option<String>,
}

struct HintClaims {
    sub: Option<String>,
    aud: Option<Vec<String>>,
    azp: Option<String>,
    sid: Option<String>,
}

fn claims_of(payload: &Value) -> HintClaims {
    let aud = match payload.get("aud") {
        Some(Value::String(value)) => Some(vec![value.clone()]),
        Some(Value::Array(values)) => Some(
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    };
    HintClaims {
        sub: payload
            .get("sub")
            .and_then(Value::as_str)
            .map(str::to_string),
        aud,
        azp: payload
            .get("azp")
            .and_then(Value::as_str)
            .map(str::to_string),
        sid: payload
            .get("sid")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Verifies the signature (not the expiry: an expired hint is still valid for
/// logout) and returns its claims.
async fn verify_hint(
    state: &AppState,
    hint: &str,
    issuer: &str,
) -> std::result::Result<HintClaims, OAuthError> {
    let keys = get_jwks(state).await.map_err(|_| {
        OAuthError::invalid_request("id_token_hint is not a token signed by this instance")
    })?;
    let keyset = JwkSet::new(
        keys.iter()
            .filter_map(|value| Jwk::from_value(value).ok())
            .collect(),
    );
    let verified = verify_jws(
        hint,
        &keyset,
        &VerifyOptions {
            algorithms: vec![JwsAlgorithm::RS256],
            issuer: None,
            audience: None,
            clock_tolerance_seconds: 0,
        },
    );
    match verified {
        Ok(_) => {}
        // An expired-but-correctly-signed hint is deliberately accepted.
        Err(JwkError::Expired) | Err(JwkError::NotYetValid) => {}
        Err(_) => {
            return Err(OAuthError::invalid_request(
                "id_token_hint is not a token signed by this instance",
            ))
        }
    }
    let payload = decode_jwt_payload(hint).ok_or_else(|| {
        OAuthError::invalid_request("id_token_hint is not a token signed by this instance")
    })?;
    if payload.get("iss").and_then(Value::as_str) != Some(issuer) {
        return Err(OAuthError::invalid_request(
            "id_token_hint was issued by another issuer",
        ));
    }
    Ok(claims_of(&payload))
}

/// `GET/POST /oauth/end_session`.
pub async fn end_session_at_provider(
    state: &AppState,
    input: LogoutInput,
) -> std::result::Result<LogoutResult, OAuthError> {
    let issuer = input
        .issuer
        .clone()
        .unwrap_or_else(|| state.env.base_url.clone());
    let claims = match input
        .id_token_hint
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(hint) => Some(verify_hint(state, hint, &issuer).await?),
        None => None,
    };
    let mut application: Option<ApplicationRow> = None;
    if let Some(claims) = &claims {
        let audience = claims
            .aud
            .as_ref()
            .and_then(|values| values.first().cloned());
        if let Some(client_id) = input.client_id.as_deref().filter(|value| !value.is_empty()) {
            if audience.as_deref() != Some(client_id) {
                return Err(OAuthError::invalid_request(
                    "client_id does not match the id_token_hint audience",
                ));
            }
        }
        if let (Some(azp), Some(audience)) = (claims.azp.as_deref(), audience.as_deref()) {
            if azp != audience {
                return Err(OAuthError::invalid_request(
                    "id_token_hint azp does not match its audience",
                ));
            }
        }
        if let Some(audience) = audience {
            application = get_application_by_client_id(state, &audience)
                .await
                .map_err(map_error)?;
        }
    } else if let Some(client_id) = input.client_id.as_deref().filter(|value| !value.is_empty()) {
        application = get_application_by_client_id(state, client_id)
            .await
            .map_err(map_error)?;
        if application.is_none() {
            return Err(OAuthError::invalid_request("Unknown client_id"));
        }
    }

    let mut redirect_to = state.settings.get().application.home_url.clone();
    if let Some(uri) = input
        .post_logout_redirect_uri
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let Some(application) = application.as_ref() else {
            return Err(OAuthError::invalid_request(
                "client_id or id_token_hint is required with post_logout_redirect_uri",
            ));
        };
        redirect_to = assert_post_logout_redirect_uri(application, uri)?;
    }

    let session_id = claims
        .as_ref()
        .and_then(|claims| claims.sid.clone())
        .filter(|value| !value.is_empty());
    let subject = claims.as_ref().and_then(|claims| claims.sub.clone());
    if let (Some(session_id), Some(subject)) = (session_id.as_deref(), subject.as_deref()) {
        let session = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(orbitid_core::OrbitError::from)
            .map_err(map_error)?;
        // Only end a session the hint actually describes.
        if let Some(session) = session.filter(|session| session.user_id == subject) {
            // `end_session` already revokes the session's grants in the same
            // transaction (status, grants, client pointer and event).
            end_session(state, &session, "ended")
                .await
                .map_err(map_error)?;
        }
    }

    if input
        .post_logout_redirect_uri
        .as_deref()
        .is_some_and(|value| !value.is_empty())
    {
        if let Some(state_param) = input.state.as_deref().filter(|value| !value.is_empty()) {
            redirect_to = crate::web::url_with(&redirect_to, &[("state", Some(state_param))]);
        }
    }
    Ok(LogoutResult {
        redirect_to,
        application,
        session_id: session_id.clone(),
    })
}

fn map_error(error: orbitid_core::OrbitError) -> OAuthError {
    OAuthError::new(error.status, error.code, error.message)
}
