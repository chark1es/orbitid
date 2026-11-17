//! Adapter implementations for built-in providers, the generic OAuth2 client
//! and TikTok.

use async_trait::async_trait;
use base64::Engine;
use orbitid_core::AppState;
use url::Url;

use super::table::{pkce_challenge, BuiltInProvider, ClientAuth};
use crate::config::OAuthProviderConfig;
use crate::error::callback_error;
use crate::http::{form_body, request_json};
use crate::oauth::{AuthorizationInput, ExchangeInput, OAuthAdapter, OAuthTokenSet};
use crate::profile::ExternalProfile;
use crate::profiles::tokens_from_arctic;

fn basic_auth(client_id: &str, client_secret: &str) -> String {
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    format!("Basic {encoded}")
}

fn token_headers(client_auth: ClientAuth, cfg: &OAuthProviderConfig) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "content-type".to_string(),
            "application/x-www-form-urlencoded".to_string(),
        ),
        ("accept".to_string(), "application/json".to_string()),
        ("user-agent".to_string(), "arctic".to_string()),
    ];
    if client_auth == ClientAuth::Basic {
        headers.push((
            "authorization".to_string(),
            basic_auth(&cfg.client_id, &cfg.client_secret),
        ));
    }
    headers
}

fn exchange_body(
    client_auth: ClientAuth,
    cfg: &OAuthProviderConfig,
    redirect_uri: &str,
    code: &str,
    code_verifier: Option<&str>,
) -> String {
    let mut pairs = vec![("grant_type", "authorization_code"), ("code", code)];
    if let Some(verifier) = code_verifier.filter(|value| !value.is_empty()) {
        pairs.push(("code_verifier", verifier));
    }
    pairs.push(("redirect_uri", redirect_uri));
    if client_auth == ClientAuth::Body {
        pairs.push(("client_id", cfg.client_id.as_str()));
        pairs.push(("client_secret", cfg.client_secret.as_str()));
    }
    form_body(&pairs)
}

/// A fixed-endpoint social provider.
pub struct SocialAdapter {
    cfg: OAuthProviderConfig,
    redirect_uri: String,
    provider: BuiltInProvider,
    state: Option<AppState>,
}

impl SocialAdapter {
    pub fn new(cfg: OAuthProviderConfig, redirect_uri: String, provider: BuiltInProvider) -> Self {
        Self {
            cfg,
            redirect_uri,
            provider,
            state: None,
        }
    }

    /// Binds the application state so the SSRF policy (development mode) applies.
    pub fn with_state(mut self, state: &AppState) -> Self {
        self.state = Some(state.clone());
        self
    }
}

#[async_trait]
impl OAuthAdapter for SocialAdapter {
    fn key(&self) -> &str {
        &self.cfg.key
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError> {
        let mut url = Url::parse(self.provider.auth_url)
            .map_err(|_| callback_error("The identity provider URL was refused"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("response_type", "code");
            query.append_pair("client_id", &self.cfg.client_id);
            query.append_pair("state", input.state);
            if self.provider.include_scope {
                query.append_pair("scope", &input.scopes.join(" "));
            }
            if self.provider.include_redirect_uri {
                query.append_pair("redirect_uri", &self.redirect_uri);
            }
            if self.provider.pkce {
                query.append_pair("code_challenge_method", "S256");
                query.append_pair("code_challenge", &pkce_challenge(input.code_verifier));
            }
            for (name, value) in self.provider.extra {
                query.append_pair(name, value);
            }
        }
        Ok(url)
    }

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
        let body = exchange_body(
            self.provider.client_auth,
            &self.cfg,
            &self.redirect_uri,
            input.code,
            self.provider.pkce.then_some(input.code_verifier),
        );
        let data = request_json(
            self.state.as_ref(),
            self.provider.token_url,
            "POST",
            &token_headers(self.provider.client_auth, &self.cfg),
            Some(body),
        )
        .await?;
        tokens_from_arctic(&data)
    }

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError> {
        crate::fetch::fetch_profile_for(self.state.as_ref(), &self.cfg, tokens).await
    }
}

const GENERIC_ENDPOINTS: [(&str, &str, &str); 5] = [
    (
        "huggingface",
        "https://huggingface.co/oauth/authorize",
        "https://huggingface.co/oauth/token",
    ),
    (
        "xero",
        "https://login.xero.com/identity/connect/authorize",
        "https://identity.xero.com/connect/token",
    ),
    (
        "linkedin_oidc",
        "https://www.linkedin.com/oauth/v2/authorization",
        "https://www.linkedin.com/oauth/v2/accessToken",
    ),
    (
        "hubspot",
        "https://app.hubspot.com/oauth/authorize",
        "https://api.hubapi.com/oauth/v1/token",
    ),
    (
        "zoom",
        "https://zoom.us/oauth/authorize",
        "https://zoom.us/oauth/token",
    ),
];

/// `arctic`'s generic `OAuth2Client` providers: PKCE S256 and HTTP Basic.
pub struct GenericAdapter {
    cfg: OAuthProviderConfig,
    redirect_uri: String,
    auth_url: &'static str,
    token_url: &'static str,
    state: Option<AppState>,
}

impl GenericAdapter {
    pub fn new(
        cfg: OAuthProviderConfig,
        redirect_uri: String,
    ) -> Result<Self, orbitid_core::OrbitError> {
        let (_, auth_url, token_url) = GENERIC_ENDPOINTS
            .iter()
            .find(|(key, _, _)| *key == cfg.key)
            .ok_or_else(|| crate::config::unsupported(&cfg.key))?;
        Ok(Self {
            cfg,
            redirect_uri,
            auth_url,
            token_url,
            state: None,
        })
    }

    /// Binds the application state so the SSRF policy applies.
    pub fn with_state(mut self, state: &AppState) -> Self {
        self.state = Some(state.clone());
        self
    }
}

#[async_trait]
impl OAuthAdapter for GenericAdapter {
    fn key(&self) -> &str {
        &self.cfg.key
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError> {
        let mut url = Url::parse(self.auth_url)
            .map_err(|_| callback_error("The identity provider URL was refused"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("response_type", "code");
            query.append_pair("client_id", &self.cfg.client_id);
            query.append_pair("redirect_uri", &self.redirect_uri);
            query.append_pair("state", input.state);
            query.append_pair("code_challenge_method", "S256");
            query.append_pair("code_challenge", &pkce_challenge(input.code_verifier));
            if !input.scopes.is_empty() {
                query.append_pair("scope", &input.scopes.join(" "));
            }
        }
        Ok(url)
    }

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
        let body = exchange_body(
            ClientAuth::Basic,
            &self.cfg,
            &self.redirect_uri,
            input.code,
            Some(input.code_verifier),
        );
        let data = request_json(
            self.state.as_ref(),
            self.token_url,
            "POST",
            &token_headers(ClientAuth::Basic, &self.cfg),
            Some(body),
        )
        .await?;
        tokens_from_arctic(&data)
    }

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError> {
        crate::fetch::fetch_profile_for(self.state.as_ref(), &self.cfg, tokens).await
    }
}

/// TikTok's manual adapter: `client_key`, comma-separated scopes, no PKCE.
pub struct TikTokAdapter {
    cfg: OAuthProviderConfig,
    redirect_uri: String,
    state: Option<AppState>,
}

impl TikTokAdapter {
    pub fn new(cfg: OAuthProviderConfig, redirect_uri: String) -> Self {
        Self {
            cfg,
            redirect_uri,
            state: None,
        }
    }

    /// Binds the application state so the SSRF policy applies.
    pub fn with_state(mut self, state: &AppState) -> Self {
        self.state = Some(state.clone());
        self
    }
}

#[async_trait]
impl OAuthAdapter for TikTokAdapter {
    fn key(&self) -> &str {
        &self.cfg.key
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError> {
        let mut url = Url::parse("https://www.tiktok.com/v2/auth/authorize/")
            .map_err(|_| callback_error("The identity provider URL was refused"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("client_key", &self.cfg.client_id);
            query.append_pair("response_type", "code");
            query.append_pair("scope", &input.scopes.join(","));
            query.append_pair("redirect_uri", &self.redirect_uri);
            query.append_pair("state", input.state);
        }
        Ok(url)
    }

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
        let body = crate::fetch::tiktok_token_body(&self.cfg, input.code, &self.redirect_uri);
        let data = request_json(
            self.state.as_ref(),
            "https://open.tiktokapis.com/v2/oauth/token/",
            "POST",
            &[
                (
                    "content-type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ),
                ("accept".to_string(), "application/json".to_string()),
            ],
            Some(body),
        )
        .await?;
        let access_token = data
            .get("access_token")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| callback_error("Identity provider did not return an access token"))?;
        Ok(OAuthTokenSet {
            access_token: access_token.to_string(),
            refresh_token: data
                .get("refresh_token")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            expires_at: data
                .get("expires_in")
                .and_then(|value| value.as_i64())
                .map(|seconds| crate::http::now_ms() + seconds * 1000),
            scopes: data
                .get("scope")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            id_token: None,
            id_token_claims: None,
            raw: data,
        })
    }

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError> {
        let data = request_json(
            self.state.as_ref(),
            crate::fetch::tiktok_userinfo_url(),
            "GET",
            &crate::profiles::bearer_headers(tokens),
            None,
        )
        .await?;
        Ok(crate::profiles::normalize_profile("tiktok", &data, tokens))
    }
}
