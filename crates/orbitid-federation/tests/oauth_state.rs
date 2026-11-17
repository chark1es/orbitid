//! OAuth state lifecycle, browser binding and provider configuration/listing.

#![cfg(feature = "test-util")]

use orbitid_core::testing::test_state;
use orbitid_federation::config::{
    list_enabled_social_providers, provider_config, provider_display_name,
    provider_key_from_strategy, provider_logo_url,
};
use orbitid_federation::{
    bind_browser, browser_matches, create_oauth_authorization, take_oauth_state, OAuthFlow,
};
use serde_json::json;

async fn configure(state: &orbitid_core::AppState, provider: &str, value: serde_json::Value) {
    state
        .settings
        .update(json!({ "social": { provider: value } }))
        .await
        .expect("settings");
}

fn flow() -> OAuthFlow {
    OAuthFlow {
        client_id: "cli_test".to_string(),
        kind: "sign_in".to_string(),
        redirect_url: "http://localhost:3000/done".to_string(),
        ..OAuthFlow::default()
    }
}

#[tokio::test]
async fn state_is_single_use_and_bound_to_the_provider() {
    let ctx = test_state().await;
    configure(
        &ctx.state,
        "google",
        json!({ "enabled": true, "clientId": "id", "clientSecret": "secret" }),
    )
    .await;
    let (cookie, hash) = bind_browser();
    assert!(browser_matches(Some(&cookie), &hash));
    let created = create_oauth_authorization(&ctx.state, "google", flow(), hash.clone())
        .await
        .expect("authorization");
    assert!(created.url.starts_with("https://accounts.google.com/"));

    // A state issued for google is not consumed by another provider.
    let wrong = take_oauth_state(&ctx.state.pool, &created.state, "github").await;
    assert_eq!(wrong.unwrap_err().code, "oauth_callback_error");

    let stored = take_oauth_state(&ctx.state.pool, &created.state, "google")
        .await
        .expect("state");
    assert_eq!(stored.provider, "google");
    assert_eq!(stored.flow.client_id, "cli_test");
    assert_eq!(stored.flow.browser_hash, hash);
    assert!(!stored.code_verifier.is_empty());
    assert!(stored.nonce.is_none());

    let replay = take_oauth_state(&ctx.state.pool, &created.state, "google").await;
    assert_eq!(replay.unwrap_err().code, "oauth_callback_error");
}

#[tokio::test]
async fn expired_states_are_refused_and_removed() {
    let ctx = test_state().await;
    sqlx::query(
        "INSERT INTO oauth_states (state, provider, code_verifier, nonce, flow, expires_at) \
         VALUES ($1, 'google', 'verifier', NULL, $2, $3)",
    )
    .bind("expired-state")
    .bind(sqlx::types::Json(
        json!({ "clientId": "c", "kind": "sign_in", "redirectUrl": "http://x" }),
    ))
    .bind(orbitid_federation::http::now_ms() - 1_000)
    .execute(&ctx.state.pool)
    .await
    .expect("insert");
    let result = take_oauth_state(&ctx.state.pool, "expired-state", "google").await;
    assert_eq!(result.unwrap_err().code, "oauth_callback_error");
    let remaining: Option<(String,)> =
        sqlx::query_as("SELECT state FROM oauth_states WHERE state = $1")
            .bind("expired-state")
            .fetch_optional(&ctx.state.pool)
            .await
            .expect("select");
    assert!(remaining.is_none());
}

#[tokio::test]
async fn rows_that_are_not_oauth_flows_are_never_consumed() {
    let ctx = test_state().await;
    // A SAML-cache row: no `kind`, no code verifier.
    sqlx::query(
        "INSERT INTO oauth_states (state, provider, flow, expires_at) \
         VALUES ('saml:_req', 'saml_cache', $1, $2)",
    )
    .bind(sqlx::types::Json(json!({ "value": "instant" })))
    .bind(orbitid_federation::http::now_ms() + 60_000)
    .execute(&ctx.state.pool)
    .await
    .expect("insert");
    let result = take_oauth_state(&ctx.state.pool, "saml:_req", "saml_cache").await;
    assert_eq!(result.unwrap_err().code, "oauth_callback_error");
    let remaining: Option<(String,)> =
        sqlx::query_as("SELECT state FROM oauth_states WHERE state = 'saml:_req'")
            .fetch_optional(&ctx.state.pool)
            .await
            .expect("select");
    assert!(remaining.is_some());
}

#[tokio::test]
async fn disabled_or_unknown_providers_are_refused() {
    let ctx = test_state().await;
    let not_enabled = create_oauth_authorization(&ctx.state, "github", flow(), "hash".into())
        .await
        .unwrap_err();
    assert_eq!(not_enabled.code, "oauth_provider_not_enabled");
    assert_eq!(not_enabled.meta.as_ref().unwrap()["param_name"], "strategy");

    configure(
        &ctx.state,
        "myspace",
        json!({ "enabled": true, "clientId": "id", "clientSecret": "secret" }),
    )
    .await;
    let unsupported = create_oauth_authorization(&ctx.state, "myspace", flow(), "hash".into())
        .await
        .unwrap_err();
    assert_eq!(unsupported.code, "oauth_provider_not_enabled");
    assert!(unsupported.message.contains("not supported"));
}

#[tokio::test]
async fn provider_listing_uses_names_logos_and_strategies() {
    let ctx = test_state().await;
    configure(
        &ctx.state,
        "google",
        json!({ "enabled": true, "clientId": "id", "clientSecret": "s" }),
    )
    .await;
    configure(
        &ctx.state,
        "custom_branded",
        json!({
            "enabled": true, "clientId": "cid", "clientSecret": "csecret",
            "protocol": "oauth2", "name": "Acme ID",
            "logoUrl": "https://cdn.acme.test/icon.svg",
            "authorizationUrl": "https://idp.example/authorize",
            "tokenUrl": "https://idp.example/token",
            "userinfoUrl": "https://idp.example/userinfo"
        }),
    )
    .await;
    let listing = list_enabled_social_providers(&ctx.state);
    let google = listing
        .iter()
        .find(|entry| entry.key == "google")
        .expect("google");
    assert_eq!(google.strategy, "oauth_google");
    assert_eq!(google.name, "Google");
    assert_eq!(google.logo_url, "https://cdn.simpleicons.org/google");
    let branded = listing
        .iter()
        .find(|entry| entry.key == "custom_branded")
        .expect("custom");
    assert_eq!(branded.strategy, "oauth_custom_branded");
    assert_eq!(branded.name, "Acme ID");
    assert_eq!(branded.logo_url, "https://cdn.acme.test/icon.svg");

    let config = provider_config(&ctx.state, "custom_branded").expect("config");
    assert_eq!(config.scopes, Vec::<String>::new());
    assert_eq!(provider_display_name("custom_x", None), "x");
    assert_eq!(
        provider_logo_url("custom_x"),
        "https://cdn.simpleicons.org/openid"
    );
    assert_eq!(provider_key_from_strategy("oauth_custom_x"), "custom_x");
}
