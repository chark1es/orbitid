//! Per-provider userinfo fetching.
//!
//! Ported from `fetchProfileFor()` in `oauth-providers/adapters.ts`. Every call
//! goes through [`crate::http::request_json`], which uses the SSRF-safe fetch.

use orbitid_core::AppState;
use serde_json::Value;

use crate::config::OAuthProviderConfig;
use crate::error::callback_error;
use crate::http::{form_body, request_json};
use crate::oauth::OAuthTokenSet;
use crate::profile::ExternalProfile;
use crate::profiles::{
    bearer_headers, bool_or_undefined, id_token_profile, normalize_profile, rec, str_opt,
};

const USERINFO_URLS: [(&str, &str); 15] = [
    ("google", "https://openidconnect.googleapis.com/v1/userinfo"),
    ("gitlab", "https://gitlab.com/api/v4/user"),
    ("microsoft", "https://graph.microsoft.com/oidc/userinfo"),
    (
        "facebook",
        "https://graph.facebook.com/me?fields=id,name,email,first_name,last_name,picture",
    ),
    (
        "twitter",
        "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
    ),
    (
        "x",
        "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
    ),
    ("linkedin_oidc", "https://api.linkedin.com/v2/userinfo"),
    ("slack", "https://slack.com/api/openid.connect.userInfo"),
    ("twitch", "https://api.twitch.tv/helix/users"),
    ("spotify", "https://api.spotify.com/v1/me"),
    ("bitbucket", "https://api.bitbucket.org/2.0/user"),
    ("box", "https://api.box.com/2.0/users/me"),
    ("atlassian", "https://api.atlassian.com/me"),
    ("huggingface", "https://huggingface.co/oauth/userinfo"),
    ("linear", "https://api.linear.app/graphql"),
];

fn userinfo_url(key: &str) -> Option<&'static str> {
    USERINFO_URLS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, url)| *url)
}

async fn get_json(
    state: Option<&AppState>,
    url: &str,
    headers: Vec<(String, String)>,
) -> Result<Value, orbitid_core::OrbitError> {
    request_json(state, url, "GET", &headers, None).await
}

/// Fetches and maps the provider's profile for an exchanged token set.
pub async fn fetch_profile_for(
    state: Option<&AppState>,
    cfg: &OAuthProviderConfig,
    tokens: &OAuthTokenSet,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let key = cfg.key.as_str();
    let bearer = bearer_headers(tokens);
    match key {
        "github" => {
            let mut headers = bearer.clone();
            headers.extend(crate::http::header_pairs(&[
                ("user-agent", "OrbitID"),
                ("accept", "application/vnd.github+json"),
            ]));
            let data = get_json(state, "https://api.github.com/user", headers.clone()).await?;
            let mut profile = normalize_profile(key, &data, tokens);
            // The public profile email is unverified, so always ask for the verified list.
            if let Ok(Value::Array(values)) =
                get_json(state, "https://api.github.com/user/emails", headers).await
            {
                {
                    let list: Vec<&Value> = values.iter().collect();
                    let primary = list
                        .iter()
                        .find(|entry| {
                            rec(entry).get("primary") == Some(&Value::Bool(true))
                                && rec(entry).get("verified") == Some(&Value::Bool(true))
                        })
                        .or_else(|| {
                            list.iter().find(|entry| {
                                rec(entry).get("verified") == Some(&Value::Bool(true))
                            })
                        });
                    if let Some(primary) = primary {
                        profile.email = str_opt(rec(primary).get("email").unwrap_or(&Value::Null));
                        profile.email_verified =
                            Some(rec(primary).get("verified") == Some(&Value::Bool(true)));
                    }
                }
            }
            Ok(profile)
        }
        "discord" => {
            let data = get_json(state, "https://discord.com/api/users/@me", bearer).await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "bitbucket" => {
            let data =
                get_json(state, userinfo_url(key).unwrap_or_default(), bearer.clone()).await?;
            let mut profile = normalize_profile(key, &data, tokens);
            if profile.email.is_none() {
                if let Ok(Value::Array(values)) =
                    get_json(state, "https://api.bitbucket.org/2.0/user/emails", bearer).await
                {
                    let primary = values
                        .iter()
                        .find(|entry| rec(entry).get("is_primary") == Some(&Value::Bool(true)))
                        .or_else(|| {
                            values.iter().find(|entry| {
                                rec(entry).get("is_confirmed") == Some(&Value::Bool(true))
                            })
                        });
                    if let Some(primary) = primary {
                        profile.email = str_opt(rec(primary).get("email").unwrap_or(&Value::Null));
                        profile.email_verified =
                            Some(rec(primary).get("is_confirmed") == Some(&Value::Bool(true)));
                    }
                }
            }
            Ok(profile)
        }
        "twitch" => {
            let mut headers = bearer;
            headers.push(("client-id".to_string(), cfg.client_id.clone()));
            let data = get_json(state, userinfo_url(key).unwrap_or_default(), headers).await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "dropbox" => {
            let mut headers = bearer;
            headers.push(("content-type".to_string(), "application/json".to_string()));
            let data = request_json(
                state,
                "https://api.dropboxapi.com/2/users/get_current_account",
                "POST",
                &headers,
                Some("null".to_string()),
            )
            .await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "notion" => {
            let mut headers = bearer;
            headers.push(("notion-version".to_string(), "2022-06-28".to_string()));
            let data = get_json(state, "https://api.notion.com/v1/users/me", headers).await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "hubspot" => {
            let encoded = percent_encoding::utf8_percent_encode(
                &tokens.access_token,
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
            let data = get_json(
                state,
                &format!("https://api.hubapi.com/oauth/v1/access-tokens/{encoded}"),
                Vec::new(),
            )
            .await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "tiktok" => {
            let data = get_json(
                state,
                "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
                bearer,
            )
            .await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "coinbase" => {
            let data = get_json(state, "https://api.coinbase.com/v2/user", bearer.clone()).await?;
            let mut profile = normalize_profile(key, &data, tokens);
            if let Ok(auth) = get_json(state, "https://api.coinbase.com/v2/user/auth", bearer).await
            {
                let data = rec(&auth);
                let email = str_opt(rec(&data["data"]).get("email").unwrap_or(&Value::Null))
                    .or_else(|| {
                        let nested = rec(&data["data"]);
                        str_opt(
                            rec(nested.get("user").unwrap_or(&Value::Null))
                                .get("email")
                                .unwrap_or(&Value::Null),
                        )
                    });
                if let Some(email) = email {
                    profile.email = Some(email);
                    profile.email_verified = Some(false);
                }
            }
            Ok(profile)
        }
        "line" => {
            let data = get_json(state, "https://api.line.me/v2/profile", bearer).await?;
            let mut profile = normalize_profile(key, &data, tokens);
            if let Some(id_token) = tokens.id_token.as_deref() {
                if let Ok(claims) = crate::jwt::decode_claims(id_token) {
                    profile.email = str_opt(&claims["email"]);
                    profile.email_verified =
                        Some(bool_or_undefined(&claims["email_verified"]).unwrap_or(false));
                }
            }
            Ok(profile)
        }
        "linear" => {
            let mut headers = bearer;
            headers.push(("content-type".to_string(), "application/json".to_string()));
            let data = request_json(
                state,
                userinfo_url(key).unwrap_or_default(),
                "POST",
                &headers,
                Some(
                    "{\"query\":\"query { viewer { id name displayName email avatarUrl } }\"}"
                        .to_string(),
                ),
            )
            .await?;
            Ok(normalize_profile(key, &data, tokens))
        }
        "xero" => id_token_profile(key, tokens),
        _ => {
            let Some(url) = userinfo_url(key) else {
                if tokens.id_token.is_some() {
                    return id_token_profile(key, tokens);
                }
                return Err(callback_error(format!(
                    "No profile endpoint configured for provider \"{key}\""
                )));
            };
            let data = get_json(state, url, bearer).await?;
            Ok(normalize_profile(key, &data, tokens))
        }
    }
}

/// Kept for the manual TikTok adapter: its userinfo endpoint is fixed.
pub fn tiktok_userinfo_url() -> &'static str {
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name"
}

/// The form body for a manual TikTok code exchange.
pub fn tiktok_token_body(cfg: &OAuthProviderConfig, code: &str, redirect_uri: &str) -> String {
    form_body(&[
        ("client_key", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
        ("code", code),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn userinfo_urls_are_complete_for_the_simple_branch() {
        for key in ["google", "gitlab", "microsoft", "slack", "spotify"] {
            assert!(userinfo_url(key).is_some(), "{key}");
        }
        assert!(userinfo_url("github").is_none());
        assert!(userinfo_url("xero").is_none());
    }

    #[test]
    fn tiktok_token_body_uses_client_key() {
        let cfg = OAuthProviderConfig {
            key: "tiktok".into(),
            name: "TikTok".into(),
            client_id: "ck".into(),
            client_secret: "cs".into(),
            scopes: vec![],
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
        };
        let body = tiktok_token_body(&cfg, "code", "https://r/cb");
        assert!(body.contains("client_key=ck"));
        assert!(!body.contains("client_id="));
    }
}
