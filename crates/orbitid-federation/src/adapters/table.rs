//! The fixed endpoint table for built-in providers and the PKCE helper.

use base64::Engine;
use sha2::{Digest, Sha256};

/// How a provider expects its client credentials at the token endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientAuth {
    /// `Authorization: Basic base64(id:secret)`.
    Basic,
    /// `client_id`/`client_secret` in the form body.
    Body,
}

/// A fixed-endpoint built-in provider.
#[derive(Debug, Clone, Copy)]
pub struct BuiltInProvider {
    pub auth_url: &'static str,
    pub token_url: &'static str,
    pub pkce: bool,
    pub client_auth: ClientAuth,
    pub include_scope: bool,
    pub include_redirect_uri: bool,
    pub extra: &'static [(&'static str, &'static str)],
}

impl BuiltInProvider {
    /// The table from `getOAuthAdapter()`.
    pub fn from_key(key: &str) -> Option<Self> {
        let provider = match key {
            "google" => Self {
                auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
                token_url: "https://oauth2.googleapis.com/token",
                pkce: true,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "github" => Self {
                auth_url: "https://github.com/login/oauth/authorize",
                token_url: "https://github.com/login/oauth/access_token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "gitlab" => Self {
                auth_url: "https://gitlab.com/oauth/authorize",
                token_url: "https://gitlab.com/oauth/token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "discord" => Self {
                auth_url: "https://discord.com/oauth2/authorize",
                token_url: "https://discord.com/api/oauth2/token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "microsoft" => Self {
                auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                pkce: true,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "facebook" => Self {
                auth_url: "https://www.facebook.com/v16.0/dialog/oauth",
                token_url: "https://graph.facebook.com/v16.0/oauth/access_token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "twitter" | "x" => Self {
                auth_url: "https://twitter.com/i/oauth2/authorize",
                token_url: "https://api.twitter.com/2/oauth2/token",
                pkce: true,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "slack" => Self {
                auth_url: "https://slack.com/openid/connect/authorize",
                token_url: "https://slack.com/api/openid.connect.token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "twitch" => Self {
                auth_url: "https://id.twitch.tv/oauth2/authorize",
                token_url: "https://id.twitch.tv/oauth2/token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "spotify" => Self {
                auth_url: "https://accounts.spotify.com/authorize",
                token_url: "https://accounts.spotify.com/api/token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "bitbucket" => Self {
                auth_url: "https://bitbucket.org/site/oauth2/authorize",
                token_url: "https://bitbucket.org/site/oauth2/access_token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: false,
                include_redirect_uri: true,
                extra: &[],
            },
            "dropbox" => Self {
                auth_url: "https://www.dropbox.com/oauth2/authorize",
                token_url: "https://api.dropboxapi.com/oauth2/token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "notion" => Self {
                auth_url: "https://api.notion.com/v1/oauth/authorize",
                token_url: "https://api.notion.com/v1/oauth/token",
                pkce: false,
                client_auth: ClientAuth::Basic,
                include_scope: false,
                include_redirect_uri: true,
                extra: &[("owner", "user")],
            },
            "box" => Self {
                auth_url: "https://account.box.com/api/oauth2/authorize",
                token_url: "https://api.box.com/oauth2/token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "coinbase" => Self {
                auth_url: "https://www.coinbase.com/oauth/authorize",
                token_url: "https://www.coinbase.com/oauth/token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "line" => Self {
                auth_url: "https://access.line.me/oauth2/v2.1/authorize",
                token_url: "https://api.line.me/oauth2/v2.1/token",
                pkce: true,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "linear" => Self {
                auth_url: "https://linear.app/oauth/authorize",
                token_url: "https://api.linear.app/oauth/token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[],
            },
            "atlassian" => Self {
                auth_url: "https://auth.atlassian.com/authorize",
                token_url: "https://auth.atlassian.com/oauth/token",
                pkce: false,
                client_auth: ClientAuth::Body,
                include_scope: true,
                include_redirect_uri: true,
                extra: &[("audience", "api.atlassian.com"), ("prompt", "consent")],
            },
            _ => return None,
        };
        Some(provider)
    }
}

/// `base64url(sha256(verifier))`, no padding.
pub fn pkce_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}
