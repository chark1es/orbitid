//! Custom OIDC and plain OAuth 2.0 providers (`custom_<key>`).
//!
//! Ported from the retired TypeScript server: a custom
//! provider is discovered through a `.well-known` document or configured with
//! manual endpoints. OIDC providers may return a signed ID token; OAuth 2.0
//! providers return a profile from userinfo. Dotted `claimMapping` paths map
//! wrapped payloads without code changes.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use orbitid_core::safe_fetch::assert_public_url;
use orbitid_core::settings::types::{ClientAuthMethod, SocialProtocol};
use orbitid_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::config::OAuthProviderConfig;
use crate::error::{callback_error, provider_not_enabled};
use crate::http::{form_body, now_ms, request_json};
use crate::oauth::{AuthorizationInput, ExchangeInput, OAuthAdapter, OAuthTokenSet};
use crate::profile::ExternalProfile;
use crate::profiles::{rec, str_opt};

mod mapped;
mod verify;
pub use mapped::{mapped_profile, trust_applies};
pub use verify::verify_custom_id_token;

/// The subset of an OIDC discovery document OrbitID consumes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OidcDiscovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub userinfo_endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jwks_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes_supported: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_challenge_methods_supported: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

fn discovery_cache() -> &'static Mutex<HashMap<String, (OidcDiscovery, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (OidcDiscovery, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Forgets cached discovery documents (tests change providers between cases).
pub fn reset_discovery_cache() {
    if let Ok(mut guard) = discovery_cache().lock() {
        guard.clear();
    }
}

fn string_list(value: &Value) -> Option<Vec<String>> {
    match value {
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

/// Fetches a discovery document, validates its shape and judges every endpoint.
pub async fn load_discovery(
    state: &AppState,
    url: &str,
) -> Result<OidcDiscovery, orbitid_core::OrbitError> {
    if let Ok(guard) = discovery_cache().lock() {
        if let Some((cached, expires)) = guard.get(url) {
            if *expires > Instant::now() {
                return Ok(cached.clone());
            }
        }
    }
    let raw = request_json(
        Some(state),
        url,
        "GET",
        &[("accept".to_string(), "application/json".to_string())],
        None,
    )
    .await?;
    let raw = rec(&raw);
    let discovery = OidcDiscovery {
        issuer: str_opt(&raw["issuer"]),
        authorization_endpoint: str_opt(&raw["authorization_endpoint"]).unwrap_or_default(),
        token_endpoint: str_opt(&raw["token_endpoint"]).unwrap_or_default(),
        userinfo_endpoint: str_opt(&raw["userinfo_endpoint"]),
        jwks_uri: str_opt(&raw["jwks_uri"]),
        scopes_supported: string_list(&raw["scopes_supported"]),
        code_challenge_methods_supported: string_list(&raw["code_challenge_methods_supported"]),
        token_endpoint_auth_methods_supported: string_list(
            &raw["token_endpoint_auth_methods_supported"],
        ),
    };
    if discovery.issuer.is_none()
        || discovery.authorization_endpoint.is_empty()
        || discovery.token_endpoint.is_empty()
    {
        return Err(provider_not_enabled(
            "The OIDC discovery document is missing its issuer or endpoints",
        ));
    }
    for endpoint in [
        Some(discovery.authorization_endpoint.as_str()),
        Some(discovery.token_endpoint.as_str()),
        discovery.userinfo_endpoint.as_deref(),
        discovery.jwks_uri.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if assert_public_url(Some(state), endpoint, "discoveryUrl")
            .await
            .is_err()
        {
            return Err(provider_not_enabled(
                "The OIDC discovery document points at a non-public address",
            ));
        }
    }
    if let Ok(mut guard) = discovery_cache().lock() {
        guard.insert(
            url.to_string(),
            (
                discovery.clone(),
                Instant::now() + Duration::from_secs(3600),
            ),
        );
    }
    Ok(discovery)
}

/// The endpoints a custom provider talks to: discovery wins, then manual fields.
pub async fn custom_endpoints(
    state: &AppState,
    cfg: &OAuthProviderConfig,
) -> Result<OidcDiscovery, orbitid_core::OrbitError> {
    if let Some(discovery_url) = cfg
        .discovery_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return load_discovery(state, discovery_url).await;
    }
    let authorization = cfg.authorization_url.as_deref().map(str::trim);
    let token = cfg.token_url.as_deref().map(str::trim);
    let (Some(authorization), Some(token)) = (authorization, token) else {
        return Err(provider_not_enabled(
            "The custom provider needs a discovery URL or manual authorization and token endpoints",
        ));
    };
    for (url, field) in [
        (Some(authorization), "authorizationUrl"),
        (Some(token), "tokenUrl"),
        (cfg.userinfo_url.as_deref().map(str::trim), "userinfoUrl"),
        (cfg.jwks_url.as_deref().map(str::trim), "jwksUrl"),
    ] {
        if let Some(url) = url.filter(|value| !value.is_empty()) {
            assert_public_url(Some(state), url, field).await?;
        }
    }
    Ok(OidcDiscovery {
        issuer: cfg
            .issuer
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        authorization_endpoint: authorization.to_string(),
        token_endpoint: token.to_string(),
        userinfo_endpoint: cfg
            .userinfo_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        jwks_uri: cfg
            .jwks_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        scopes_supported: None,
        code_challenge_methods_supported: None,
        token_endpoint_auth_methods_supported: None,
    })
}

async fn custom_profile(
    state: &AppState,
    cfg: &OAuthProviderConfig,
    tokens: &OAuthTokenSet,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let endpoints = custom_endpoints(state, cfg).await?;
    if let Some(claims) = &tokens.id_token_claims {
        return mapped_profile(cfg, claims, tokens);
    }
    if let (Some(id_token), Some(_jwks)) =
        (tokens.id_token.as_deref(), endpoints.jwks_uri.as_deref())
    {
        let claims = verify_custom_id_token(state, cfg, &endpoints, id_token, None).await?;
        return mapped_profile(cfg, &claims, tokens);
    }
    if let Some(userinfo) = endpoints.userinfo_endpoint.as_deref() {
        let data = request_json(
            Some(state),
            userinfo,
            "GET",
            &crate::profiles::bearer_headers(tokens),
            None,
        )
        .await?;
        return mapped_profile(cfg, &data, tokens);
    }
    Err(callback_error(
        "The identity provider did not return a usable profile",
    ))
}

/// True when the provider is configured for plain OAuth 2.0 (no ID token).
pub fn is_oauth2_provider(cfg: &OAuthProviderConfig) -> bool {
    cfg.protocol == Some(SocialProtocol::Oauth2)
}

fn basic_auth(cfg: &OAuthProviderConfig) -> String {
    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        format!("{}:{}", cfg.client_id, cfg.client_secret),
    );
    format!("Basic {encoded}")
}

/// The adapter for a `custom_<key>` provider, discovered or manually configured.
pub struct CustomAdapter {
    cfg: OAuthProviderConfig,
    redirect_uri: String,
    endpoints: OidcDiscovery,
    uses_pkce: bool,
    verifies_id_token: bool,
    state: AppState,
}

impl CustomAdapter {
    /// Resolves discovery/endpoints and builds the adapter.
    pub async fn build(
        state: &AppState,
        cfg: OAuthProviderConfig,
        redirect_uri: String,
    ) -> Result<Self, orbitid_core::OrbitError> {
        let endpoints = custom_endpoints(state, &cfg).await?;
        let uses_pkce = cfg.pkce != Some(false);
        let verifies_id_token = !is_oauth2_provider(&cfg) && endpoints.jwks_uri.is_some();
        Ok(Self {
            cfg,
            redirect_uri,
            endpoints,
            uses_pkce,
            verifies_id_token,
            state: state.clone(),
        })
    }
}

#[async_trait]
impl OAuthAdapter for CustomAdapter {
    fn key(&self) -> &str {
        &self.cfg.key
    }

    fn uses_nonce(&self) -> bool {
        self.verifies_id_token
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError> {
        let mut url = Url::parse(&self.endpoints.authorization_endpoint)
            .map_err(|_| callback_error("The identity provider URL was refused"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("response_type", "code");
            query.append_pair("client_id", &self.cfg.client_id);
            query.append_pair("redirect_uri", &self.redirect_uri);
            if !input.scopes.is_empty() {
                query.append_pair("scope", &input.scopes.join(" "));
            }
            query.append_pair("state", input.state);
            if let Some(nonce) = input.nonce {
                query.append_pair("nonce", nonce);
            }
            if self.uses_pkce {
                query.append_pair(
                    "code_challenge",
                    &crate::adapters::pkce_challenge(input.code_verifier),
                );
                query.append_pair("code_challenge_method", "S256");
            }
        }
        Ok(url)
    }

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
        let mut pairs = vec![
            ("grant_type", "authorization_code"),
            ("code", input.code),
            ("redirect_uri", self.redirect_uri.as_str()),
        ];
        if self.uses_pkce && !input.code_verifier.is_empty() {
            pairs.push(("code_verifier", input.code_verifier));
        }
        let basic = self.cfg.client_auth_method != Some(ClientAuthMethod::ClientSecretPost)
            && !self.cfg.client_secret.is_empty();
        let mut headers = vec![
            (
                "content-type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            ),
            ("accept".to_string(), "application/json".to_string()),
        ];
        if basic {
            headers.push(("authorization".to_string(), basic_auth(&self.cfg)));
        } else {
            pairs.push(("client_id", self.cfg.client_id.as_str()));
            if !self.cfg.client_secret.is_empty() {
                pairs.push(("client_secret", self.cfg.client_secret.as_str()));
            }
        }
        let raw = request_json(
            Some(&self.state),
            &self.endpoints.token_endpoint,
            "POST",
            &headers,
            Some(form_body(&pairs)),
        )
        .await?;
        let access_token = str_opt(&raw["access_token"])
            .ok_or_else(|| callback_error("Identity provider did not return an access token"))?;
        let id_token = str_opt(&raw["id_token"]);
        let mut tokens = OAuthTokenSet {
            access_token,
            refresh_token: str_opt(&raw["refresh_token"]),
            expires_at: raw
                .get("expires_in")
                .and_then(Value::as_f64)
                .map(|seconds| now_ms() + (seconds * 1000.0) as i64),
            scopes: str_opt(&raw["scope"]),
            id_token: id_token.clone(),
            id_token_claims: None,
            raw,
        };
        if let (Some(id_token), true) = (id_token.as_deref(), self.verifies_id_token) {
            tokens.id_token_claims = Some(
                verify_custom_id_token(
                    &self.state,
                    &self.cfg,
                    &self.endpoints,
                    id_token,
                    input.nonce,
                )
                .await?,
            );
        }
        Ok(tokens)
    }

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError> {
        custom_profile(&self.state, &self.cfg, tokens).await
    }
}

/// Reads a claim by dotted path (exported for mappings and tests).
pub fn claim_at(data: &Value, path: &str) -> Value {
    crate::profiles::at(data, path)
}

/// `boolOrUndefined` re-export for callers of [`mapped_profile`].
pub use crate::profiles::bool_or_undefined as flag;

#[cfg(test)]
mod tests;
