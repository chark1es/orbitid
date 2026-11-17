//! Built-in social adapters: authorization URLs and token/profile wire shapes
//! reproduced from `arctic`.
//!
//! Fixed provider hosts cannot be contacted from tests, so responses are served
//! by core's SSRF-safe fetch test seam. Every adapter still goes through the
//! production `safe_fetch` path.

#![cfg(feature = "test-util")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use orbitid_core::safe_fetch::{
    set_safe_fetch_transport_for_tests, SafeFetchOptions, SafeFetchResult, SafeFetchTransport,
};
use orbitid_core::testing::test_state;
use orbitid_core::AppState;
use orbitid_federation::{get_oauth_adapter, ExchangeInput};
use serde_json::{json, Value};
use tokio::sync::Mutex;

static SEAM: Mutex<()> = Mutex::const_new(());

type SeenRequest = (String, Option<String>, HashMap<String, String>);

#[derive(Default)]
struct Canned {
    routes: HashMap<String, (u16, String)>,
    seen: StdMutex<Vec<SeenRequest>>,
}

#[async_trait]
impl SafeFetchTransport for Canned {
    async fn call(
        &self,
        url: &url::Url,
        options: &SafeFetchOptions,
    ) -> orbitid_core::Result<SafeFetchResult> {
        let mut headers = HashMap::new();
        for (name, value) in &options.headers {
            headers.insert(
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            );
        }
        let body = options
            .body
            .as_ref()
            .map(|body| String::from_utf8_lossy(body).into_owned());
        if let Ok(mut seen) = self.seen.lock() {
            seen.push((url.to_string(), body.clone(), headers));
        }
        let key = url.to_string();
        let (status, body) = self
            .routes
            .get(&key)
            .cloned()
            .or_else(|| {
                self.routes
                    .iter()
                    .find(|(route, _)| key.starts_with(route.as_str()))
                    .map(|(_, value)| value.clone())
            })
            .unwrap_or((404, "{}".to_string()));
        Ok(SafeFetchResult {
            status,
            headers: axum::http::HeaderMap::new(),
            body,
        })
    }
}

fn parse_form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect()
}

async fn configure(state: &AppState, provider: &str, value: Value) {
    state
        .settings
        .update(json!({ "social": { provider: value } }))
        .await
        .expect("settings");
}

#[tokio::test]
async fn social_adapters_match_arctic_wire_shapes() {
    let _guard = SEAM.lock().await;
    let ctx = test_state().await;
    let mut routes = HashMap::new();
    routes.insert(
        "https://oauth2.googleapis.com/token".to_string(),
        (
            200,
            json!({
                "access_token": "google-access",
                "expires_in": 3600,
                "scope": "openid email",
                "id_token": "unused-for-google-profile",
                "token_type": "Bearer",
            })
            .to_string(),
        ),
    );
    routes.insert(
        "https://openidconnect.googleapis.com/v1/userinfo".to_string(),
        (
            200,
            json!({
                "sub": "g-1", "email": "ada@example.com", "email_verified": true,
                "given_name": "Ada", "family_name": "Lovelace", "picture": "https://img/ada.png"
            })
            .to_string(),
        ),
    );
    routes.insert(
        "https://github.com/login/oauth/access_token".to_string(),
        (
            200,
            json!({
                "access_token": "github-access", "expires_in": 28800,
                "token_type": "bearer", "scope": "read:user,user:email"
            })
            .to_string(),
        ),
    );
    routes.insert(
        "https://api.github.com/user".to_string(),
        (
            200,
            json!({
                "id": 42, "login": "ada", "name": "Ada Lovelace",
                "email": "public@example.com", "avatar_url": "https://img/gh.png"
            })
            .to_string(),
        ),
    );
    routes.insert(
        "https://api.github.com/user/emails".to_string(),
        (
            200,
            json!([
                { "email": "public@example.com", "primary": false, "verified": false },
                { "email": "ada@verified.test", "primary": true, "verified": true }
            ])
            .to_string(),
        ),
    );
    routes.insert(
        "https://api.notion.com/v1/oauth/token".to_string(),
        (
            200,
            json!({ "access_token": "notion-access", "expires_in": 3600, "token_type": "bearer" })
                .to_string(),
        ),
    );
    routes.insert(
        "https://api.notion.com/v1/users/me".to_string(),
        (
            200,
            json!({
                "id": "notion-1", "name": "Ada", "avatar_url": "https://img/n.png",
                "person": { "email": "ada@notion.test" }
            })
            .to_string(),
        ),
    );
    let transport = Arc::new(Canned {
        routes,
        seen: StdMutex::new(Vec::new()),
    });
    set_safe_fetch_transport_for_tests(Some(transport.clone()));

    configure(
        &ctx.state,
        "google",
        json!({ "enabled": true, "clientId": "google-id", "clientSecret": "google-secret" }),
    )
    .await;
    configure(
        &ctx.state,
        "github",
        json!({ "enabled": true, "clientId": "github-id", "clientSecret": "github-secret" }),
    )
    .await;
    configure(
        &ctx.state,
        "notion",
        json!({ "enabled": true, "clientId": "notion-id", "clientSecret": "notion-secret" }),
    )
    .await;

    // Google: PKCE S256, OIDC scopes.
    let google = get_oauth_adapter(&ctx.state, "google")
        .await
        .expect("adapter")
        .expect("configured");
    let url = google
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "state-g",
            code_verifier: "verifier-verifier-verifier-verifier-123",
            scopes: &["openid".into(), "email".into(), "profile".into()],
            nonce: None,
        })
        .await
        .expect("url");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("response_type").map(String::as_str),
        Some("code")
    );
    assert_eq!(
        params.get("client_id").map(String::as_str),
        Some("google-id")
    );
    assert_eq!(
        params.get("scope").map(String::as_str),
        Some("openid email profile")
    );
    assert_eq!(
        params.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert_eq!(
        params.get("redirect_uri").map(String::as_str),
        Some("http://localhost:4000/v1/oauth_callback/google")
    );
    let tokens = google
        .exchange_code(ExchangeInput {
            code: "google-code",
            code_verifier: "verifier-verifier-verifier-verifier-123",
            nonce: None,
        })
        .await
        .expect("exchange");
    assert_eq!(tokens.access_token, "google-access");
    assert_eq!(tokens.scopes.as_deref(), Some("openid email"));
    let profile = google.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.provider_user_id, "g-1");
    assert_eq!(profile.email_verified, Some(true));
    assert_eq!(profile.username.as_deref(), Some("ada"));

    // GitHub: no PKCE, Basic token auth, verified primary email preferred.
    let github = get_oauth_adapter(&ctx.state, "github")
        .await
        .expect("adapter")
        .expect("configured");
    let url = github
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "state-gh",
            code_verifier: "v",
            scopes: &["read:user".into(), "user:email".into()],
            nonce: None,
        })
        .await
        .expect("url");
    assert!(url.query_pairs().all(|(name, _)| name != "code_challenge"));
    let tokens = github
        .exchange_code(ExchangeInput {
            code: "github-code",
            code_verifier: "v",
            nonce: None,
        })
        .await
        .expect("exchange");
    let profile = github.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.provider_user_id, "42");
    assert_eq!(profile.email.as_deref(), Some("ada@verified.test"));
    assert_eq!(profile.email_verified, Some(true));
    assert_eq!(profile.first_name.as_deref(), Some("Ada"));

    // Notion: no scope, owner=user, Basic auth.
    let notion = get_oauth_adapter(&ctx.state, "notion")
        .await
        .expect("adapter")
        .expect("configured");
    let url = notion
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "state-n",
            code_verifier: "v",
            scopes: &[],
            nonce: None,
        })
        .await
        .expect("url");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert!(!params.contains_key("scope"));
    assert_eq!(params.get("owner").map(String::as_str), Some("user"));
    let tokens = notion
        .exchange_code(ExchangeInput {
            code: "notion-code",
            code_verifier: "v",
            nonce: None,
        })
        .await
        .expect("exchange");
    let profile = notion.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.email.as_deref(), Some("ada@notion.test"));

    // Inspect what actually went over the wire.
    let seen = transport.seen.lock().expect("seen");
    let google_token = seen
        .iter()
        .find(|(url, _, _)| url == "https://oauth2.googleapis.com/token")
        .expect("google token request");
    let form = parse_form(google_token.1.as_deref().unwrap_or(""));
    assert_eq!(
        form.get("code_verifier").map(String::as_str),
        Some("verifier-verifier-verifier-verifier-123")
    );
    assert_eq!(
        form.get("grant_type").map(String::as_str),
        Some("authorization_code")
    );
    assert!(!form.contains_key("client_id"));
    assert!(google_token
        .2
        .get("authorization")
        .is_some_and(|value| value.starts_with("Basic ")));
    let github_token = seen
        .iter()
        .find(|(url, _, _)| url == "https://github.com/login/oauth/access_token")
        .expect("github token request");
    let form = parse_form(github_token.1.as_deref().unwrap_or(""));
    assert!(!form.contains_key("code_verifier"));
    assert!(github_token
        .2
        .get("authorization")
        .is_some_and(|value| value.starts_with("Basic ")));

    set_safe_fetch_transport_for_tests(None);
}

#[tokio::test]
async fn twitter_and_atlassian_special_parameters() {
    let _guard = SEAM.lock().await;
    let ctx = test_state().await;
    let transport = Arc::new(Canned::default());
    set_safe_fetch_transport_for_tests(Some(transport));
    configure(
        &ctx.state,
        "twitter",
        json!({ "enabled": true, "clientId": "tw-id", "clientSecret": "tw-secret" }),
    )
    .await;
    configure(
        &ctx.state,
        "atlassian",
        json!({ "enabled": true, "clientId": "at-id", "clientSecret": "at-secret" }),
    )
    .await;
    let twitter = get_oauth_adapter(&ctx.state, "twitter")
        .await
        .expect("adapter")
        .expect("configured");
    let url = twitter
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "s",
            code_verifier: "v",
            scopes: &["users.read".into()],
            nonce: None,
        })
        .await
        .expect("url");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    let atlassian = get_oauth_adapter(&ctx.state, "atlassian")
        .await
        .expect("adapter")
        .expect("configured");
    let url = atlassian
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "s",
            code_verifier: "v",
            scopes: &["read:me".into()],
            nonce: None,
        })
        .await
        .expect("url");
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("audience").map(String::as_str),
        Some("api.atlassian.com")
    );
    assert_eq!(params.get("prompt").map(String::as_str), Some("consent"));
    set_safe_fetch_transport_for_tests(None);
}
