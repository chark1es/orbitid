//! HTTP handlers for the mock OIDC provider.

use std::collections::HashMap;

use axum::extract::{Query, State as AxumState};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};

use super::{state_of, Shared, State, TokenRequest};
use crate::test_support::keys::rsa_jwk_parts;

pub(crate) async fn discovery(AxumState(shared): AxumState<Shared>) -> impl IntoResponse {
    let state = state_of(&shared);
    let base = state.issuer.clone();
    Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "userinfo_endpoint": format!("{base}/userinfo"),
        "jwks_uri": format!("{base}/jwks"),
        "scopes_supported": ["openid", "profile", "email"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
        "response_types_supported": ["code"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
    }))
}

pub(crate) async fn jwks(AxumState(shared): AxumState<Shared>) -> impl IntoResponse {
    let state = state_of(&shared);
    let (n, e) = rsa_jwk_parts(&state.key.key).unwrap_or_default();
    Json(json!({
        "keys": [{
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": state.kid,
            "n": n,
            "e": e,
        }]
    }))
}

fn s256(value: &str) -> String {
    crate::adapters::pkce_challenge(value)
}

pub(crate) async fn authorize(
    AxumState(shared): AxumState<Shared>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let (redirect_uri, code, state_value) = {
        let mut state = state_of(&shared);
        let redirect_uri = params.get("redirect_uri").cloned().unwrap_or_default();
        if params.get("client_id").map(String::as_str) != Some(state.options.client_id.as_str())
            || redirect_uri.is_empty()
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_request" })),
            )
                .into_response();
        }
        state.code_challenge = params.get("code_challenge").cloned();
        state.nonce = params.get("nonce").cloned();
        let code = state.options.code.clone();
        let state_value = params.get("state").cloned().unwrap_or_default();
        (redirect_uri, code, state_value)
    };
    let mut target = match url::Url::parse(&redirect_uri) {
        Ok(url) => url,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "invalid_request" })),
            )
                .into_response()
        }
    };
    target.query_pairs_mut().append_pair("code", &code);
    if !state_value.is_empty() {
        target.query_pairs_mut().append_pair("state", &state_value);
    }
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, target.to_string())],
    )
        .into_response()
}

fn basic_credentials(headers: &HeaderMap) -> Option<(String, String)> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let encoded = value.strip_prefix("Basic ")?;
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (id, secret) = decoded.split_once(':')?;
    Some((id.to_string(), secret.to_string()))
}

fn id_token_for(state: &State) -> Result<String, String> {
    if let Some(raw) = &state.raw_id_token {
        return Ok(raw.clone());
    }
    let now = crate::http::now_ms() / 1000;
    let mut claims = json!({
        "iss": state.issuer.clone(),
        "aud": state.options.client_id,
        "sub": state.options.user.sub,
        "email": state.options.user.email,
        "email_verified": state.options.user.email_verified,
        "given_name": state.options.user.given_name,
        "family_name": state.options.user.family_name,
        "iat": now,
        "exp": now + 600,
        "auth_time": now,
    });
    if let Some(nonce) = &state.nonce {
        claims["nonce"] = Value::String(nonce.clone());
    }
    if let Some(overrides) = &state.next_claims {
        if let (Value::Object(base), Value::Object(extra)) = (&mut claims, overrides) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(state.kid.clone());
    let key = EncodingKey::from_rsa_pem(state.signing_key.private_key_pem.as_bytes())
        .map_err(|error| error.to_string())?;
    encode(&header, &claims, &key).map_err(|error| error.to_string())
}

pub(crate) async fn token(
    AxumState(shared): AxumState<Shared>,
    headers: HeaderMap,
    axum::extract::Form(form): axum::extract::Form<HashMap<String, String>>,
) -> Response {
    let (authorization, outcome) = {
        let mut state = state_of(&shared);
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        state.token_requests.push(TokenRequest {
            authorization: authorization.clone(),
            form: form
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        });

        let credentials_ok = match basic_credentials(&headers) {
            Some((id, secret)) => {
                id == state.options.client_id && secret == state.options.client_secret
            }
            None => {
                form.get("client_id") == Some(&state.options.client_id)
                    && form.get("client_secret") == Some(&state.options.client_secret)
            }
        };
        if !credentials_ok {
            (authorization, Err("invalid_client"))
        } else if form.get("grant_type").map(String::as_str) != Some("authorization_code")
            || form.get("code") != Some(&state.options.code)
        {
            (authorization, Err("invalid_grant"))
        } else if let Some(challenge) = &state.code_challenge {
            match form.get("code_verifier") {
                Some(verifier) if s256(verifier) == *challenge => (
                    authorization,
                    id_token_for(&state).map_err(|_| "server_error"),
                ),
                _ => (authorization, Err("invalid_grant")),
            }
        } else {
            (
                authorization,
                id_token_for(&state).map_err(|_| "server_error"),
            )
        }
    };
    let _ = authorization;
    match outcome {
        Ok(id_token) => Json(json!({
            "access_token": "test-access-token",
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": "test-refresh-token",
            "scope": "openid profile email",
            "id_token": id_token,
        }))
        .into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response(),
    }
}

pub(crate) async fn userinfo(AxumState(shared): AxumState<Shared>, headers: HeaderMap) -> Response {
    let authorized = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some("Bearer test-access-token");
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid_token" })),
        )
            .into_response();
    }
    let state = state_of(&shared);
    if let Some(document) = &state.userinfo {
        return Json(document.clone()).into_response();
    }
    Json(json!({
        "sub": state.options.user.sub,
        "email": state.options.user.email,
        "email_verified": state.options.user.email_verified,
        "given_name": state.options.user.given_name,
        "family_name": state.options.user.family_name,
    }))
    .into_response()
}
