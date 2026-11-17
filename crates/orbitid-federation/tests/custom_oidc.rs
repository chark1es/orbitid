//! Custom OIDC and OAuth 2.0 adapters driven against a real loopback provider.
//!
//! These cover the protocol path only: discovery, PKCE, nonce, ID-token
//! verification, claim mapping and the negative token cases. Account linking is
//! tested by the Frontend API crates.

#![cfg(feature = "test-util")]

use orbitid_core::testing::test_state;
use orbitid_federation::test_support::{start_oidc_server, OidcServerOptions, OidcTestServer};
use orbitid_federation::{
    bind_browser, create_oauth_authorization, get_oauth_adapter, take_oauth_state, ExchangeInput,
    OAuthFlow,
};
use serde_json::{json, Value};

async fn configure(state: &orbitid_core::AppState, provider: &str, value: Value) {
    state
        .settings
        .update(json!({ "social": { provider: value } }))
        .await
        .expect("settings update");
}

fn custom_oidc(server: &OidcTestServer) -> Value {
    json!({
        "enabled": true,
        "clientId": server.client_id,
        "clientSecret": server.client_secret,
        "discoveryUrl": format!("{}/.well-known/openid-configuration", server.base_url),
        "scopes": ["openid", "profile", "email"],
    })
}

async fn drive(
    state: &orbitid_core::AppState,
    provider: &str,
) -> (
    Box<dyn orbitid_federation::OAuthAdapter>,
    orbitid_federation::StoredOAuthFlow,
) {
    let (_cookie, hash) = bind_browser();
    let flow = OAuthFlow {
        client_id: "cli_test".to_string(),
        kind: "sign_in".to_string(),
        redirect_url: "http://localhost:3000/done".to_string(),
        ..OAuthFlow::default()
    };
    let created = create_oauth_authorization(state, provider, flow, hash)
        .await
        .expect("authorization");
    // The provider records the PKCE challenge and nonce when the browser visits it.
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
        .get(&created.url)
        .send()
        .await
        .expect("authorize");
    assert_eq!(response.status().as_u16(), 302);
    let stored = take_oauth_state(&state.pool, &created.state, provider)
        .await
        .expect("state");
    let adapter = get_oauth_adapter(state, provider)
        .await
        .expect("adapter")
        .expect("configured");
    (adapter, stored)
}

#[tokio::test]
async fn custom_oidc_discovery_pkce_nonce_and_profile() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions {
        user: orbitid_federation::test_support::oidc::OidcUser {
            sub: "idp-user-1".to_string(),
            email: "ada@acme.test".to_string(),
            email_verified: true,
            given_name: "Ada".to_string(),
            family_name: "Lovelace".to_string(),
        },
        ..OidcServerOptions::default()
    })
    .await
    .expect("server");
    configure(&ctx.state, "custom_acme", custom_oidc(&server)).await;

    let (adapter, stored) = drive(&ctx.state, "custom_acme").await;
    assert!(adapter.uses_nonce());
    let url = adapter
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "s",
            code_verifier: "verifier-verifier-verifier-verifier-123",
            scopes: &["openid".to_string()],
            nonce: Some("n"),
        })
        .await
        .expect("url");
    let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        params.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert_eq!(params.get("state").map(String::as_str), Some("s"));
    assert_eq!(params.get("nonce").map(String::as_str), Some("n"));

    let tokens = adapter
        .exchange_code(ExchangeInput {
            code: "test-code",
            code_verifier: &stored.code_verifier,
            nonce: stored.nonce.as_deref(),
        })
        .await
        .expect("exchange");
    assert_eq!(tokens.access_token, "test-access-token");
    assert!(tokens.id_token_claims.is_some());
    let profile = adapter.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.provider, "custom_acme");
    assert_eq!(profile.provider_user_id, "idp-user-1");
    assert_eq!(profile.email.as_deref(), Some("ada@acme.test"));
    assert_eq!(profile.email_verified, Some(true));
    assert_eq!(profile.first_name.as_deref(), Some("Ada"));
    assert!(profile.access_token.is_some());

    let requests = server.token_requests();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .authorization
        .as_deref()
        .unwrap_or("")
        .starts_with("Basic "));
    assert_eq!(
        requests[0].field("code_verifier"),
        Some(stored.code_verifier.as_str())
    );

    server.close().await;
}

#[tokio::test]
async fn custom_oidc_manual_endpoints_without_discovery() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    configure(
        &ctx.state,
        "custom_manual",
        json!({
            "enabled": true,
            "clientId": server.client_id,
            "clientSecret": server.client_secret,
            "protocol": "oidc",
            "issuer": server.issuer,
            "authorizationUrl": format!("{}/authorize", server.base_url),
            "tokenUrl": format!("{}/token", server.base_url),
            "userinfoUrl": format!("{}/userinfo", server.base_url),
            "jwksUrl": format!("{}/jwks", server.base_url),
            "scopes": ["openid", "profile", "email"],
        }),
    )
    .await;
    let (adapter, stored) = drive(&ctx.state, "custom_manual").await;
    let tokens = adapter
        .exchange_code(ExchangeInput {
            code: "test-code",
            code_verifier: &stored.code_verifier,
            nonce: stored.nonce.as_deref(),
        })
        .await
        .expect("exchange");
    let profile = adapter.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.email.as_deref(), Some("ada@acme.test"));
    server.close().await;
}

#[tokio::test]
async fn custom_oauth2_uses_userinfo_client_secret_post_and_nested_claims() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    server.set_userinfo(Some(json!({
        "data": { "profile": {
            "id": "nested-user-1",
            "contact": { "email": "ada@nested.test", "verified": "true" },
            "display_name": "Ada Lovelace",
            "login": "ada",
            "avatar": { "url": "https://img.example/ada.png" }
        }}
    })));
    configure(
        &ctx.state,
        "custom_nested",
        json!({
            "enabled": true,
            "clientId": server.client_id,
            "clientSecret": server.client_secret,
            "protocol": "oauth2",
            "authorizationUrl": format!("{}/authorize", server.base_url),
            "tokenUrl": format!("{}/token", server.base_url),
            "userinfoUrl": format!("{}/userinfo", server.base_url),
            "scopes": ["read"],
            "clientAuthMethod": "client_secret_post",
            "pkce": false,
            "trustEmailVerified": false,
            "claimMapping": {
                "sub": "data.profile.id",
                "email": "data.profile.contact.email",
                "emailVerified": "data.profile.contact.verified",
                "name": "data.profile.display_name",
                "username": "data.profile.login",
                "picture": "data.profile.avatar.url"
            }
        }),
    )
    .await;

    let (adapter, stored) = drive(&ctx.state, "custom_nested").await;
    assert!(!adapter.uses_nonce());
    let auth = adapter
        .create_authorization_url(orbitid_federation::AuthorizationInput {
            state: "s",
            code_verifier: "v",
            scopes: &["read".to_string()],
            nonce: None,
        })
        .await
        .expect("url");
    assert!(auth.query_pairs().all(|(name, _)| name != "code_challenge"));

    let tokens = adapter
        .exchange_code(ExchangeInput {
            code: "test-code",
            code_verifier: &stored.code_verifier,
            nonce: None,
        })
        .await
        .expect("exchange");
    let profile = adapter.fetch_profile(&tokens).await.expect("profile");
    assert_eq!(profile.provider_user_id, "nested-user-1");
    assert_eq!(profile.email.as_deref(), Some("ada@nested.test"));
    assert_eq!(profile.email_verified, Some(true));
    assert_eq!(profile.first_name.as_deref(), Some("Ada"));
    assert_eq!(profile.last_name.as_deref(), Some("Lovelace"));
    assert_eq!(profile.username.as_deref(), Some("ada"));
    assert_eq!(
        profile.image_url.as_deref(),
        Some("https://img.example/ada.png")
    );

    let requests = server.token_requests();
    assert!(requests[0].authorization.is_none());
    assert_eq!(
        requests[0].field("client_id"),
        Some(server.client_id.as_str())
    );
    assert!(requests[0].field("code_verifier").is_none());

    server.close().await;
}

async fn exchange_with_claims(
    server: &OidcTestServer,
    claims: Option<Value>,
) -> orbitid_core::Result<()> {
    server.set_next_claims(claims);
    let ctx = test_state().await;
    configure(&ctx.state, "custom_acme", custom_oidc(server)).await;
    let (adapter, stored) = drive(&ctx.state, "custom_acme").await;
    adapter
        .exchange_code(ExchangeInput {
            code: "test-code",
            code_verifier: &stored.code_verifier,
            nonce: stored.nonce.as_deref(),
        })
        .await
        .map(|_| ())
}

#[tokio::test]
async fn refuses_id_tokens_with_the_wrong_issuer_audience_nonce_expiry_or_signature() {
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let base = json!({ "sub": "u1", "email": "ada@acme.test", "email_verified": true });
    let cases = [
        json!({ "iss": "https://evil.example", "aud": server.client_id }),
        json!({ "iss": server.issuer, "aud": "some-other-client" }),
        json!({ "iss": server.issuer, "aud": server.client_id, "nonce": "replayed-nonce" }),
        json!({ "iss": server.issuer, "aud": server.client_id, "exp": 1 }),
    ];
    for extra in cases {
        let mut claims = base.clone();
        if let (Value::Object(base), Value::Object(extra)) = (&mut claims, &extra) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        let result = exchange_with_claims(&server, Some(claims)).await;
        assert!(result.is_err(), "accepted {extra}");
    }
    // A signature from a key the published JWKS does not contain.
    server.set_signing_key(Some(
        orbitid_federation::test_support::make_key_pair("attacker").expect("key"),
    ));
    let result = exchange_with_claims(
        &server,
        Some(json!({ "iss": server.issuer, "aud": server.client_id })),
    )
    .await;
    assert!(result.is_err());
    // An unsigned (alg=none) token.
    server.set_signing_key(None);
    server.set_raw_id_token(Some(format!(
        "{}.{}.{}",
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            br#"{"alg":"none","typ":"JWT"}"#
        ),
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            br#"{"iss":"x","aud":"y","sub":"u"}"#
        ),
        ""
    )));
    let result = exchange_with_claims(&server, None).await;
    assert!(result.is_err());
    server.close().await;
}

#[tokio::test]
async fn refuses_a_discovery_url_on_a_private_address_when_development_mode_is_off() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .expect("settings");
    configure(&ctx.state, "custom_acme", custom_oidc(&server)).await;
    let error = get_oauth_adapter(&ctx.state, "custom_acme")
        .await
        .err()
        .or_else(|| Some(orbitid_federation::callback_error("no adapter")))
        .expect("adapter error");
    assert_eq!(error.code, "oauth_callback_error");
    assert!(error.message.to_lowercase().contains("refused"));
    server.close().await;
}

#[tokio::test]
async fn discovery_reports_a_complete_document() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let discovery = orbitid_federation::custom::load_discovery(
        &ctx.state,
        &format!("{}/.well-known/openid-configuration", server.base_url),
    )
    .await
    .expect("discovery");
    assert_eq!(discovery.issuer.as_deref(), Some(server.issuer.as_str()));
    assert!(discovery.jwks_uri.is_some());
    assert!(discovery
        .scopes_supported
        .as_ref()
        .is_some_and(|scopes| scopes.iter().any(|scope| scope == "openid")));
    server.close().await;
}
