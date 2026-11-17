//! The provider adapter contract, OAuth token set, and persisted authorization state.
//!
//! The state/flow logic is ported from the retired TypeScript server
//! and lives in the `oauth_states` table so several replicas behind a load balancer
//! see the same state. Session/account creation is deliberately left to the caller.

use async_trait::async_trait;
use orbitid_core::models::OauthStateRow;
use orbitid_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use url::Url;

use crate::config::{provider_config, provider_key_from_strategy, provider_redirect_uri};
use crate::error::{callback_invalid, provider_not_enabled};
use crate::profile::ExternalProfile;

/// Tokens a provider exchange produced.
#[derive(Clone, Default)]
pub struct OAuthTokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix epoch milliseconds.
    pub expires_at: Option<i64>,
    pub scopes: Option<String>,
    pub id_token: Option<String>,
    /// Claims already verified against the provider's JWKS during the code exchange.
    pub id_token_claims: Option<Value>,
    pub raw: Value,
}

impl std::fmt::Debug for OAuthTokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthTokenSet")
            .field("access_token", &"<redacted>")
            .field("refresh_token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .field("id_token", &"<redacted>")
            .field("id_token_claims", &self.id_token_claims)
            .field("raw", &self.raw)
            .finish()
    }
}

/// Inputs to an authorization URL.
#[derive(Debug, Clone)]
pub struct AuthorizationInput<'a> {
    pub state: &'a str,
    pub code_verifier: &'a str,
    pub scopes: &'a [String],
    pub nonce: Option<&'a str>,
}

/// Inputs to a code exchange.
#[derive(Debug, Clone)]
pub struct ExchangeInput<'a> {
    pub code: &'a str,
    pub code_verifier: &'a str,
    pub nonce: Option<&'a str>,
}

/// One configured identity provider.
#[async_trait]
pub trait OAuthAdapter: Send + Sync {
    /// Provider key (`google`, `custom_acme`, …).
    fn key(&self) -> &str;

    /// True for OpenID Connect providers: the authorization request carries a
    /// nonce and the ID token must repeat it.
    fn uses_nonce(&self) -> bool {
        false
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError>;

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError>;

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError>;
}

/// Builds the adapter for a provider key. `None` when the provider is not
/// configured (or the key is unknown), matching `getOAuthAdapter`.
pub async fn get_oauth_adapter(
    state: &AppState,
    key: &str,
) -> Result<Option<Box<dyn OAuthAdapter>>, orbitid_core::OrbitError> {
    let cfg = match provider_config(state, key) {
        Some(cfg) => cfg,
        None => return Ok(None),
    };
    let redirect_uri = provider_redirect_uri(&state.env.base_url, key);
    #[cfg(any(test, feature = "test-util"))]
    if let Some(factory) = crate::adapters::adapter_override(key) {
        return factory(&cfg, &redirect_uri, state).map(Some);
    }
    match key {
        "apple" => Ok(Some(Box::new(
            crate::apple::AppleAdapter::new(cfg, redirect_uri).with_state(state),
        ))),
        "tiktok" => Ok(Some(Box::new(
            crate::adapters::TikTokAdapter::new(cfg, redirect_uri).with_state(state),
        ))),
        "hubspot" | "huggingface" | "xero" | "zoom" | "linkedin_oidc" => Ok(Some(Box::new(
            crate::adapters::GenericAdapter::new(cfg, redirect_uri)?.with_state(state),
        ))),
        _ if key.starts_with("custom_") => Ok(Some(Box::new(
            crate::custom::CustomAdapter::build(state, cfg, redirect_uri).await?,
        ))),
        _ => match crate::adapters::BuiltInProvider::from_key(key) {
            Some(provider) => Ok(Some(Box::new(
                crate::adapters::SocialAdapter::new(cfg, redirect_uri, provider).with_state(state),
            ))),
            None => Ok(None),
        },
    }
}

/// The flow a stored OAuth state belongs to. Field names match the JSON the
/// TypeScript server writes into `oauth_states.flow`.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthFlow {
    pub client_id: String,
    /// `sign_in`, `sign_up` or `connect`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub redirect_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_complete_redirect_url: Option<String>,
    #[serde(default)]
    pub additional_scopes: Vec<String>,
    #[serde(default)]
    pub browser_hash: String,
}

impl std::fmt::Debug for OAuthFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthFlow")
            .field("client_id", &self.client_id)
            .field("kind", &self.kind)
            .field("owner_id", &self.owner_id)
            .field("user_id", &self.user_id)
            .field("redirect_url", &self.redirect_url)
            .field(
                "action_complete_redirect_url",
                &self.action_complete_redirect_url,
            )
            .field("additional_scopes", &self.additional_scopes)
            .field("browser_hash", &self.browser_hash)
            .finish()
    }
}

/// The consumed state plus the secrets the callback needs.
#[derive(Debug, Clone)]
pub struct StoredOAuthFlow {
    pub flow: OAuthFlow,
    pub provider: String,
    pub code_verifier: String,
    pub nonce: Option<String>,
}

/// How long a started flow stays valid.
pub const OAUTH_STATE_TTL_MS: i64 = 10 * 60_000;
/// Name of the cookie that binds a flow to the initiating browser.
pub const BROWSER_COOKIE: &str = "__orbit_oauth";
/// Path the binding cookie is scoped to (so it reaches `/v1/oauth_callback`).
pub const BROWSER_COOKIE_PATH: &str = "/v1";
/// Binding cookie lifetime.
pub const BROWSER_COOKIE_TTL_SECONDS: i64 = 10 * 60;

/// What a newly started authorization needs from the caller: where to send the
/// browser, and the cookie nonce/hash that binds the flow to this browser.
#[derive(Debug, Clone)]
pub struct CreatedAuthorization {
    pub url: String,
    pub state: String,
    pub browser_hash: String,
}

/// `bindBrowser()`: a fresh cookie nonce and the hash to store with the flow.
pub fn bind_browser() -> (String, String) {
    let nonce = orbitid_core::crypto::random_token(24);
    let hash = orbitid_core::crypto::sha256(&nonce);
    (nonce, hash)
}

/// True when a callback carries the cookie that was set for the stored hash.
/// The comparison is constant time.
pub fn browser_matches(presented: Option<&str>, expected_hash: &str) -> bool {
    match presented {
        Some(value) if !value.is_empty() && !expected_hash.is_empty() => {
            orbitid_core::crypto::safe_equal(&orbitid_core::crypto::sha256(value), expected_hash)
        }
        _ => false,
    }
}

/// The message the TypeScript server attaches to a browser-binding failure.
pub fn browser_mismatch_message(base_url: &str, method: &str) -> String {
    let needs_https = method.eq_ignore_ascii_case("POST") && !base_url.starts_with("https://");
    if needs_https {
        "This sign-in was started in a different browser, or the callback is a cross-site POST that needs an https base URL".to_string()
    } else {
        "This sign-in was started in a different browser".to_string()
    }
}

/// Builds the provider authorization URL and stores PKCE/state → flow.
pub async fn create_oauth_authorization(
    state: &AppState,
    provider: &str,
    flow: OAuthFlow,
    browser_hash: String,
) -> Result<CreatedAuthorization, orbitid_core::OrbitError> {
    let cfg = provider_config(state, provider).ok_or_else(|| {
        provider_not_enabled(format!("Social provider \"{provider}\" is not enabled"))
            .with_meta(serde_json::json!({ "param_name": "strategy" }))
    })?;
    let adapter = get_oauth_adapter(state, provider).await?.ok_or_else(|| {
        provider_not_enabled(format!("Social provider \"{provider}\" is not supported"))
            .with_meta(serde_json::json!({ "param_name": "strategy" }))
    })?;

    let state_value = orbitid_core::crypto::random_token(32);
    let code_verifier = orbitid_core::crypto::random_token(32);
    let nonce = adapter
        .uses_nonce()
        .then(|| orbitid_core::crypto::random_token(16));
    let mut scopes = cfg.scopes.clone();
    for scope in &flow.additional_scopes {
        if !scopes.contains(scope) {
            scopes.push(scope.clone());
        }
    }
    let url = adapter
        .create_authorization_url(AuthorizationInput {
            state: &state_value,
            code_verifier: &code_verifier,
            scopes: &scopes,
            nonce: nonce.as_deref(),
        })
        .await?;

    let mut stored = flow;
    stored.additional_scopes = stored.additional_scopes.clone();
    stored.browser_hash = browser_hash.clone();
    let flow_json = serde_json::to_value(&stored).unwrap_or(Value::Null);
    sqlx::query(
        "INSERT INTO oauth_states (state, provider, code_verifier, nonce, flow, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&state_value)
    .bind(provider)
    .bind(&code_verifier)
    .bind(&nonce)
    .bind(sqlx::types::Json(&flow_json))
    .bind(crate::http::now_ms() + OAUTH_STATE_TTL_MS)
    .execute(&state.pool)
    .await?;

    Ok(CreatedAuthorization {
        url: url.to_string(),
        state: state_value,
        browser_hash,
    })
}

/// Consumes an OAuth state exactly once. Rows written by other features
/// (`saml_cache`, `enterprise_*`) are never accepted here.
pub async fn take_oauth_state(
    pool: &PgPool,
    state_value: &str,
    provider: &str,
) -> Result<StoredOAuthFlow, orbitid_core::OrbitError> {
    let now = crate::http::now_ms();
    let row = sqlx::query_as::<_, OauthStateRow>(
        "SELECT state, provider, code_verifier, nonce, flow, expires_at \
         FROM oauth_states WHERE state = $1",
    )
    .bind(state_value)
    .fetch_optional(pool)
    .await?;

    let is_oauth_flow = row.as_ref().is_some_and(|row| {
        row.flow.0.get("kind").is_some_and(|kind| kind.is_string())
            && row.code_verifier.is_some()
            && !row.provider.starts_with("enterprise_")
    });
    let usable = is_oauth_flow
        && row
            .as_ref()
            .is_some_and(|row| row.provider == provider && row.expires_at > now);
    if !usable {
        if let Some(row) = &row {
            if is_oauth_flow && row.expires_at <= now {
                sqlx::query("DELETE FROM oauth_states WHERE state = $1")
                    .bind(state_value)
                    .execute(pool)
                    .await?;
            }
        }
        return Err(callback_invalid(
            "The OAuth state is invalid or has expired",
        ));
    }

    let consumed = sqlx::query_as::<_, OauthStateRow>(
        "DELETE FROM oauth_states \
         WHERE state = $1 AND provider = $2 AND expires_at > $3 \
         RETURNING state, provider, code_verifier, nonce, flow, expires_at",
    )
    .bind(state_value)
    .bind(provider)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    let Some(consumed) = consumed else {
        return Err(callback_invalid(
            "The OAuth state is invalid or has expired",
        ));
    };
    let flow: OAuthFlow = serde_json::from_value(consumed.flow.0)
        .map_err(|_| callback_invalid("The OAuth state is invalid or has expired"))?;
    Ok(StoredOAuthFlow {
        flow,
        provider: consumed.provider,
        code_verifier: consumed.code_verifier.unwrap_or_default(),
        nonce: consumed.nonce,
    })
}

/// `oauth_google` → `google`; provided for route handlers.
pub fn provider_from_strategy(strategy: &str) -> &str {
    provider_key_from_strategy(strategy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn browser_binding_is_constant_time_and_single_use_by_contract() {
        let (nonce, hash) = bind_browser();
        assert!(browser_matches(Some(&nonce), &hash));
        assert!(!browser_matches(Some("other"), &hash));
        assert!(!browser_matches(None, &hash));
        assert!(!browser_matches(Some(&nonce), ""));
    }

    #[test]
    fn browser_mismatch_message_mentions_https_for_cross_site_posts() {
        assert!(browser_mismatch_message("http://localhost:4000", "POST").contains("https"));
        assert!(!browser_mismatch_message("https://a", "POST").contains("https base"));
        assert!(!browser_mismatch_message("http://localhost", "GET").contains("https base"));
    }

    #[test]
    fn flow_json_uses_the_ts_field_names() {
        let flow = OAuthFlow {
            client_id: "cli".into(),
            kind: "sign_in".into(),
            redirect_url: "http://localhost/done".into(),
            browser_hash: "h".into(),
            ..OAuthFlow::default()
        };
        let value = serde_json::to_value(&flow).expect("json");
        assert_eq!(value["clientId"], "cli");
        assert_eq!(value["actionCompleteRedirectUrl"], Value::Null);
        let back: OAuthFlow = serde_json::from_value(value).expect("round trip");
        assert_eq!(back.kind, "sign_in");
    }

    #[test]
    fn token_set_defaults_are_empty() {
        let tokens = OAuthTokenSet::default();
        assert!(tokens.access_token.is_empty());
        assert!(HashMap::<String, String>::new().is_empty());
    }
}
