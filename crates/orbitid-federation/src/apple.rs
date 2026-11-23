//! Apple sign-in: the ES256 client secret minted from a `.p8` key, verification
//! of Apple's ID token, and the manual form_post adapter.
//!
//! Ported from the Apple parts of `oauth-providers/core.ts` and `adapters.ts`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use async_trait::async_trait;
use serde_json::{json, Value};
use url::Url;

use crate::config::{
    has_apple_key, OAuthProviderConfig, APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
    APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS, APPLE_ISSUER, APPLE_JWKS_URL, APPLE_TOKEN_URL,
};
use crate::error::{callback_error, provider_not_enabled};
use crate::http::{form_body, now_ms, request_json};
use crate::jwt::{remote_jwks, sign_es256_pem, verify_id_token};
use crate::oauth::{AuthorizationInput, ExchangeInput, OAuthAdapter, OAuthTokenSet};
use crate::profile::{build_profile, ExternalProfile};
use crate::profiles::{bool_or_undefined, rec, str_opt};

struct CachedSecret {
    jwt: String,
    /// Unix epoch ms from which a fresh secret must be minted.
    renew_at: i64,
}

fn cache() -> &'static Mutex<HashMap<String, CachedSecret>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSecret>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every input to the signed secret is part of the key, so a changed or rotated
/// key never sees a secret minted from another, and nothing needs to clear it.
fn cache_key(cfg: &OAuthProviderConfig) -> String {
    orbitid_core::crypto::sha256(
        &[
            cfg.client_id.as_str(),
            cfg.apple_team_id.as_deref().unwrap_or(""),
            cfg.apple_key_id.as_deref().unwrap_or(""),
            cfg.apple_private_key.as_deref().unwrap_or(""),
        ]
        .join("\u{0}"),
    )
}

/// Accepts a `.p8` with or without the PEM header and with the line breaks a
/// dashboard paste usually loses.
pub fn normalize_p8(raw: &str) -> String {
    let trimmed = raw.trim().replace("\\n", "\n");
    if trimmed.contains("-----BEGIN") {
        return trimmed;
    }
    let body: String = trimmed.chars().filter(|ch| !ch.is_whitespace()).collect();
    let mut lines = String::new();
    for (index, chunk) in body.as_bytes().chunks(64).enumerate() {
        if index > 0 {
            lines.push('\n');
        }
        lines.push_str(&String::from_utf8_lossy(chunk));
    }
    format!("-----BEGIN PRIVATE KEY-----\n{lines}\n-----END PRIVATE KEY-----\n")
}

/// Apple requires `client_secret` to be an ES256 JWT: `iss` = team id,
/// `sub` = client id, `aud` = https://appleid.apple.com, at most six months,
/// `kid` in the header. A configured secret wins when no key is present.
pub fn apple_client_secret(
    cfg: &OAuthProviderConfig,
    now: i64,
) -> Result<String, orbitid_core::OrbitError> {
    if !has_apple_key(cfg) {
        if !cfg.client_secret.is_empty() {
            return Ok(cfg.client_secret.clone());
        }
        return Err(provider_not_enabled(
            "Apple needs a client secret or a team id, key id and private key",
        ));
    }
    let key = cache_key(cfg);
    if let Ok(guard) = cache().lock() {
        if let Some(cached) = guard.get(&key) {
            if cached.renew_at > now {
                return Ok(cached.jwt.clone());
            }
        }
    }

    let team_id = cfg.apple_team_id.clone().unwrap_or_default();
    let key_id = cfg.apple_key_id.clone().unwrap_or_default();
    let private_key = normalize_p8(cfg.apple_private_key.as_deref().unwrap_or(""));
    let issued_at = now.div_euclid(1000);
    let expires_at = issued_at + APPLE_CLIENT_SECRET_LIFETIME_SECONDS;
    let claims = json!({
        "iss": team_id,
        "iat": issued_at,
        "exp": expires_at,
        "aud": [APPLE_ISSUER],
        "sub": cfg.client_id,
    });
    let jwt = sign_es256_pem(&claims, &key_id, &private_key).map_err(|_| {
        provider_not_enabled("The Apple private key is not a valid ES256 (.p8) key")
    })?;
    let renew_at = (expires_at - APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS) * 1000;
    if let Ok(mut guard) = cache().lock() {
        guard.insert(
            key,
            CachedSecret {
                jwt: jwt.clone(),
                renew_at,
            },
        );
    }
    Ok(jwt)
}

/// Verifies an Apple ID token: signature against Apple's JWKS,
/// `iss` = https://appleid.apple.com, `aud` = the configured client id, expiry.
pub async fn verify_apple_id_token(
    state: Option<&orbitid_core::AppState>,
    id_token: &str,
    client_id: &str,
) -> Result<Value, orbitid_core::OrbitError> {
    let result = async {
        let jwks = remote_jwks(state, APPLE_JWKS_URL, false).await?;
        verify_id_token(&jwks, id_token, Some(APPLE_ISSUER), client_id, 0, None)
    }
    .await;
    result.map_err(|_| callback_error("Apple returned an ID token that could not be verified"))
}

/// Apple's first-authorization `user` form field carries the name; it is absent
/// on every later authorization.
pub fn apple_profile_name(user_json: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(raw) = user_json.filter(|value| !value.is_empty()) else {
        return (None, None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return (None, None);
    };
    let Some(name) = parsed.get("name").and_then(Value::as_object) else {
        return (None, None);
    };
    (
        name.get("firstName")
            .and_then(Value::as_str)
            .map(str::to_string),
        name.get("lastName")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

fn apple_profile(
    cfg: &OAuthProviderConfig,
    tokens: &OAuthTokenSet,
    claims: &Value,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let _ = cfg;
    let sub = str_opt(&claims["sub"])
        .ok_or_else(|| callback_error("Apple returned an ID token without a subject"))?;
    let mut profile = build_profile("apple", sub, Some(tokens));
    profile.email = str_opt(&claims["email"]);
    profile.email_verified = Some(bool_or_undefined(&claims["email_verified"]).unwrap_or(false));
    profile.raw = Some(claims.clone());
    Ok(profile)
}

/// Apple's manual adapter: `response_mode=form_post`, no PKCE.
pub struct AppleAdapter {
    cfg: OAuthProviderConfig,
    redirect_uri: String,
    state: Option<orbitid_core::AppState>,
}

impl AppleAdapter {
    pub fn new(cfg: OAuthProviderConfig, redirect_uri: String) -> Self {
        Self {
            cfg,
            redirect_uri,
            state: None,
        }
    }

    /// Binds the application state so the SSRF policy applies.
    pub fn with_state(mut self, state: &orbitid_core::AppState) -> Self {
        self.state = Some(state.clone());
        self
    }
}

#[async_trait]
impl OAuthAdapter for AppleAdapter {
    fn key(&self) -> &str {
        &self.cfg.key
    }

    async fn create_authorization_url(
        &self,
        input: AuthorizationInput<'_>,
    ) -> Result<Url, orbitid_core::OrbitError> {
        let mut url = Url::parse("https://appleid.apple.com/auth/authorize")
            .map_err(|_| callback_error("The identity provider URL was refused"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("client_id", &self.cfg.client_id);
            query.append_pair("redirect_uri", &self.redirect_uri);
            query.append_pair("response_type", "code");
            query.append_pair("response_mode", "form_post");
            query.append_pair("scope", &input.scopes.join(" "));
            query.append_pair("state", input.state);
        }
        Ok(url)
    }

    async fn exchange_code(
        &self,
        input: ExchangeInput<'_>,
    ) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
        let secret = apple_client_secret(&self.cfg, now_ms())?;
        let body = form_body(&[
            ("client_id", &self.cfg.client_id),
            ("client_secret", &secret),
            ("code", input.code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &self.redirect_uri),
        ]);
        let data = request_json(
            self.state.as_ref(),
            APPLE_TOKEN_URL,
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
        let access_token = str_opt(&data["access_token"])
            .ok_or_else(|| callback_error("Apple did not return tokens"))?;
        let id_token = str_opt(&data["id_token"])
            .ok_or_else(|| callback_error("Apple did not return tokens"))?;
        let id_token_claims =
            verify_apple_id_token(self.state.as_ref(), &id_token, &self.cfg.client_id).await?;
        Ok(OAuthTokenSet {
            access_token,
            refresh_token: str_opt(&data["refresh_token"]),
            id_token: Some(id_token),
            id_token_claims: Some(id_token_claims),
            expires_at: data
                .get("expires_in")
                .and_then(Value::as_i64)
                .map(|seconds| now_ms() + seconds * 1000),
            scopes: None,
            raw: data,
        })
    }

    async fn fetch_profile(
        &self,
        tokens: &OAuthTokenSet,
    ) -> Result<ExternalProfile, orbitid_core::OrbitError> {
        let claims = match &tokens.id_token_claims {
            Some(claims) => claims.clone(),
            None => match tokens.id_token.as_deref() {
                Some(id_token) => {
                    verify_apple_id_token(self.state.as_ref(), id_token, &self.cfg.client_id)
                        .await?
                }
                None => return Err(callback_error("Apple did not return an ID token")),
            },
        };
        let _ = rec(&claims);
        apple_profile(&self.cfg, tokens, &claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(secret: Option<&str>) -> OAuthProviderConfig {
        OAuthProviderConfig {
            key: "apple".into(),
            name: "Apple".into(),
            client_id: "com.example.web".into(),
            client_secret: secret.unwrap_or("").into(),
            scopes: vec!["name".into(), "email".into()],
            discovery_url: None,
            protocol: None,
            authorization_url: None,
            token_url: None,
            userinfo_url: None,
            jwks_url: None,
            issuer: None,
            client_auth_method: None,
            pkce: None,
            trust_email_verified: None,
            logo_url: None,
            claim_mapping: None,
            apple_team_id: None,
            apple_key_id: None,
            apple_private_key: None,
        }
    }

    #[test]
    fn configured_secret_is_preferred() {
        let cfg = config(Some("pre-generated-secret"));
        assert_eq!(
            apple_client_secret(&cfg, now_ms()).unwrap(),
            "pre-generated-secret"
        );
    }

    #[test]
    fn missing_secret_and_key_is_an_error() {
        let cfg = config(None);
        let error = apple_client_secret(&cfg, now_ms()).unwrap_err();
        assert_eq!(error.code, "oauth_provider_not_enabled");
        assert!(error.message.contains("needs a client secret"));
    }

    #[test]
    fn invalid_key_reports_the_es256_shape() {
        let mut cfg = config(None);
        cfg.apple_team_id = Some("TEAM".into());
        cfg.apple_key_id = Some("KEY".into());
        cfg.apple_private_key = Some("not-a-key".into());
        let error = apple_client_secret(&cfg, now_ms()).unwrap_err();
        assert!(error.message.contains("valid ES256"));
    }

    #[test]
    fn p8_normalization_accepts_bare_base64_and_literal_newlines() {
        let bare = "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg";
        let pem = normalize_p8(bare);
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----\n"));
        assert!(pem.ends_with("-----END PRIVATE KEY-----\n"));
        assert!(
            normalize_p8("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")
                .starts_with("-----BEGIN PRIVATE KEY-----")
        );
        assert!(normalize_p8("a\\nb").contains('\n'));
    }

    #[test]
    fn first_authorization_name_only() {
        assert_eq!(
            apple_profile_name(Some(
                r#"{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"a@x"}"#
            )),
            (Some("Ada".into()), Some("Lovelace".into()))
        );
        assert_eq!(apple_profile_name(None), (None, None));
        assert_eq!(apple_profile_name(Some("")), (None, None));
        assert_eq!(apple_profile_name(Some("not json")), (None, None));
        assert_eq!(apple_profile_name(Some(r#"{"name":null}"#)), (None, None));
    }

    #[test]
    fn apple_profile_flags_string_true() {
        let cfg = config(None);
        let tokens = OAuthTokenSet::default();
        let claims = json!({ "sub": "apple-1", "email": "a@x", "email_verified": "true" });
        let profile = apple_profile(&cfg, &tokens, &claims).unwrap();
        assert_eq!(profile.provider, "apple");
        assert_eq!(profile.provider_user_id, "apple-1");
        assert_eq!(profile.email_verified, Some(true));
    }
}
