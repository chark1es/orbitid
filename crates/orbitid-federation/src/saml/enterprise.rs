//! Enterprise OIDC connections (OrbitID acting as an OIDC client).

use orbitid_core::models::EnterpriseConnectionRow;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config::config_object;
use crate::error::{callback_error, callback_invalid, missing_param};

/// An enterprise OIDC provider's discovery document (all endpoints required).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnterpriseDiscovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub userinfo_endpoint: Option<String>,
    pub jwks_uri: String,
}

/// The OIDC half of an enterprise connection's `config` JSON.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OidcConfig {
    pub client_id: String,
    pub client_secret_enc: String,
    pub discovery_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery: Option<EnterpriseDiscovery>,
}

pub fn oidc_config(conn: &EnterpriseConnectionRow) -> Result<OidcConfig, orbitid_core::OrbitError> {
    let value = Value::Object(config_object(conn));
    let cfg: OidcConfig = serde_json::from_value(value).unwrap_or_default();
    if cfg.client_id.is_empty() || cfg.client_secret_enc.is_empty() || cfg.discovery_url.is_empty()
    {
        return Err(missing_param(
            "OIDC connection is missing client configuration",
        ));
    }
    Ok(cfg)
}

pub fn encrypt_client_secret(
    encryption_key: &str,
    secret: &str,
) -> Result<String, orbitid_core::OrbitError> {
    orbitid_core::crypto::encrypt(encryption_key, secret)
        .map_err(|_| callback_invalid("Could not encrypt the OIDC client secret"))
}

/// Decrypts an enterprise OIDC client secret.
pub fn decrypt_client_secret(
    encryption_key: &str,
    conn: &EnterpriseConnectionRow,
) -> Result<String, orbitid_core::OrbitError> {
    let cfg = oidc_config(conn)?;
    orbitid_core::crypto::decrypt(encryption_key, &cfg.client_secret_enc)
        .map_err(|_| callback_invalid("Could not decrypt the OIDC client secret"))
}

/// Loads (and persists into `config.discovery`) the IdP discovery document.
pub async fn get_oidc_discovery(
    state: &orbitid_core::AppState,
    conn: &EnterpriseConnectionRow,
) -> Result<EnterpriseDiscovery, orbitid_core::OrbitError> {
    let cfg = oidc_config(conn)?;
    if let Some(discovery) = cfg.discovery {
        return Ok(discovery);
    }
    let response = orbitid_core::safe_fetch::safe_fetch(
        Some(state),
        &cfg.discovery_url,
        orbitid_core::safe_fetch::SafeFetchOptions {
            timeout_ms: Some(10_000),
            max_bytes: Some(256 * 1024),
            headers: orbitid_core::safe_fetch::headers(&[("accept", "application/json")]),
            ..orbitid_core::safe_fetch::SafeFetchOptions::default()
        },
    )
    .await
    .map_err(|error| {
        callback_error(format!(
            "Could not load OIDC discovery document: {}",
            error.message
        ))
    })?;
    if !response.ok() {
        return Err(callback_error(format!(
            "Could not load OIDC discovery document: discovery returned {}",
            response.status
        )));
    }
    let doc: Value = serde_json::from_str(&response.body).map_err(|_| {
        callback_error("Could not load OIDC discovery document: response was not JSON")
    })?;
    let discovery = EnterpriseDiscovery {
        issuer: doc
            .get("issuer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        authorization_endpoint: doc
            .get("authorization_endpoint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        token_endpoint: doc
            .get("token_endpoint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        userinfo_endpoint: doc
            .get("userinfo_endpoint")
            .and_then(Value::as_str)
            .map(str::to_string),
        jwks_uri: doc
            .get("jwks_uri")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    };
    if discovery.issuer.is_empty()
        || discovery.authorization_endpoint.is_empty()
        || discovery.token_endpoint.is_empty()
        || discovery.jwks_uri.is_empty()
    {
        return Err(callback_invalid("OIDC discovery document is incomplete"));
    }
    for endpoint in [
        Some(discovery.authorization_endpoint.as_str()),
        Some(discovery.token_endpoint.as_str()),
        Some(discovery.jwks_uri.as_str()),
        discovery.userinfo_endpoint.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if orbitid_core::safe_fetch::assert_public_url(Some(state), endpoint, "discovery_url")
            .await
            .is_err()
        {
            return Err(callback_invalid(
                "OIDC discovery document points at a non-public address",
            ));
        }
    }
    let mut config = config_object(conn);
    config.insert(
        "discovery".to_string(),
        serde_json::to_value(&discovery).unwrap_or(Value::Null),
    );
    sqlx::query("UPDATE enterprise_connections SET config = $1, updated_at = $2 WHERE id = $3")
        .bind(sqlx::types::Json(Value::Object(config)))
        .bind(crate::http::now_ms())
        .bind(&conn.id)
        .execute(&state.pool)
        .await?;
    Ok(discovery)
}

/// Parameters of an enterprise OIDC authorization request.
#[derive(Debug, Clone, Default)]
pub struct EnterpriseAuthorizeParams {
    pub redirect_uri: String,
    pub state: String,
    pub nonce: String,
    pub code_challenge: String,
    pub scope: Option<String>,
}

/// Builds the IdP authorize URL for an enterprise OIDC connection.
pub fn enterprise_oidc_authorize_url(
    conn: &EnterpriseConnectionRow,
    discovery: &EnterpriseDiscovery,
    params: &EnterpriseAuthorizeParams,
) -> Result<String, orbitid_core::OrbitError> {
    let cfg = oidc_config(conn)?;
    let mut url = url::Url::parse(&discovery.authorization_endpoint)
        .map_err(|_| callback_invalid("The OIDC authorization endpoint is not a valid URL"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &cfg.client_id);
        query.append_pair("redirect_uri", &params.redirect_uri);
        query.append_pair(
            "scope",
            params.scope.as_deref().unwrap_or("openid profile email"),
        );
        query.append_pair("state", &params.state);
        query.append_pair("nonce", &params.nonce);
        query.append_pair("code_challenge", &params.code_challenge);
        query.append_pair("code_challenge_method", "S256");
    }
    Ok(url.to_string())
}

/// The enterprise OIDC token endpoint's response.
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct EnterpriseTokenResponse {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl std::fmt::Debug for EnterpriseTokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnterpriseTokenResponse")
            .field("access_token", &"<redacted>")
            .field("id_token", &"<redacted>")
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("refresh_token", &"<redacted>")
            .finish()
    }
}

/// Exchanges an enterprise OIDC authorization code.
pub async fn exchange_enterprise_oidc_code(
    state: &orbitid_core::AppState,
    conn: &EnterpriseConnectionRow,
    discovery: &EnterpriseDiscovery,
    code: &str,
    redirect_uri: &str,
    code_verifier: Option<&str>,
) -> Result<EnterpriseTokenResponse, orbitid_core::OrbitError> {
    let cfg = oidc_config(conn)?;
    let secret = decrypt_client_secret(&state.env.encryption_key, conn)?;
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", cfg.client_id.as_str()),
        ("client_secret", secret.as_str()),
    ];
    if let Some(verifier) = code_verifier.filter(|value| !value.is_empty()) {
        pairs.push(("code_verifier", verifier));
    }
    let response = orbitid_core::safe_fetch::safe_fetch(
        Some(state),
        &discovery.token_endpoint,
        orbitid_core::safe_fetch::SafeFetchOptions {
            method: Some("POST".to_string()),
            headers: orbitid_core::safe_fetch::headers(&[
                ("content-type", "application/x-www-form-urlencoded"),
                ("accept", "application/json"),
            ]),
            body: Some(crate::http::form_body(&pairs).into_bytes()),
            timeout_ms: Some(10_000),
            max_bytes: Some(256 * 1024),
            ..orbitid_core::safe_fetch::SafeFetchOptions::default()
        },
    )
    .await?;
    if !response.ok() {
        return Err(callback_invalid(format!(
            "OIDC token exchange failed ({}): {}",
            response.status,
            response.body.chars().take(200).collect::<String>()
        )));
    }
    let json: Value = response.json().unwrap_or(Value::Null);
    let access_token = json
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| callback_invalid("OIDC token response has no access_token"))?;
    Ok(EnterpriseTokenResponse {
        access_token: access_token.to_string(),
        id_token: json
            .get("id_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        token_type: json
            .get("token_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_in: json.get("expires_in").and_then(Value::as_i64),
        refresh_token: json
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Verifies the IdP's `id_token` against its published JWKS (issuer, audience, nonce).
pub async fn verify_enterprise_id_token(
    state: &orbitid_core::AppState,
    conn: &EnterpriseConnectionRow,
    discovery: &EnterpriseDiscovery,
    id_token: &str,
    nonce: Option<&str>,
) -> Result<Value, orbitid_core::OrbitError> {
    let cfg = oidc_config(conn)?;
    let result = async {
        let jwks = crate::jwt::remote_jwks(Some(state), &discovery.jwks_uri, false).await?;
        crate::jwt::verify_id_token(
            &jwks,
            id_token,
            Some(&discovery.issuer),
            &cfg.client_id,
            0,
            nonce,
        )
    }
    .await;
    result.map_err(|error| {
        callback_invalid(format!(
            "OIDC id_token verification failed: {}",
            error.message
        ))
    })
}

/// Fetches the IdP's userinfo document (empty object when it publishes none).
pub async fn fetch_enterprise_user_info(
    state: &orbitid_core::AppState,
    discovery: &EnterpriseDiscovery,
    access_token: &str,
) -> Result<Value, orbitid_core::OrbitError> {
    let Some(userinfo) = discovery.userinfo_endpoint.as_deref() else {
        return Ok(Value::Object(Map::new()));
    };
    let response = orbitid_core::safe_fetch::safe_fetch(
        Some(state),
        userinfo,
        orbitid_core::safe_fetch::SafeFetchOptions {
            headers: orbitid_core::safe_fetch::headers(&[
                ("authorization", &format!("Bearer {access_token}")),
                ("accept", "application/json"),
            ]),
            timeout_ms: Some(10_000),
            max_bytes: Some(512 * 1024),
            ..orbitid_core::safe_fetch::SafeFetchOptions::default()
        },
    )
    .await?;
    if !response.ok() {
        return Err(callback_invalid(format!(
            "OIDC userinfo request failed ({})",
            response.status
        )));
    }
    Ok(response.json().unwrap_or(Value::Null))
}

/// Builds the external profile for an enterprise OIDC login.
pub fn enterprise_oidc_profile(
    conn: &EnterpriseConnectionRow,
    claims: &Value,
    tokens: &EnterpriseTokenResponse,
) -> Result<crate::profile::ExternalProfile, orbitid_core::OrbitError> {
    let text = |value: &Value| -> Option<String> {
        value
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let sub =
        text(&claims["sub"]).ok_or_else(|| callback_invalid("OIDC id_token has no subject"))?;
    let mut profile = crate::profile::build_profile(&format!("oidc_{}", conn.id), sub, None);
    profile.email = text(&claims["email"]);
    profile.email_verified = Some(
        claims["email_verified"] == Value::Bool(true)
            || claims["email_verified"] == Value::String("true".to_string()),
    );
    profile.first_name = text(&claims["given_name"]).or_else(|| text(&claims["first_name"]));
    profile.last_name = text(&claims["family_name"]).or_else(|| text(&claims["last_name"]));
    profile.username = text(&claims["preferred_username"]).or_else(|| text(&claims["username"]));
    profile.image_url = text(&claims["picture"]);
    profile.access_token = Some(tokens.access_token.clone());
    profile.refresh_token = tokens.refresh_token.clone();
    profile.expires_at = tokens
        .expires_in
        .map(|seconds| crate::http::now_ms() + seconds * 1000);
    profile.scopes = text(&claims["scope"]);
    profile.raw = Some(claims.clone());
    Ok(profile)
}
