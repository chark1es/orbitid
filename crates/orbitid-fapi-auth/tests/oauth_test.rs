//! Ported from `test/federation/oauth.test.ts` and
//! `test/security/provider-email-trust.test.ts` (flow level).

mod common;

use axum::http::StatusCode;
use common::{harness_with, seed_user};
use orbitid_core::config::EnvOverrides;
use orbitid_federation::test_support::oidc::OidcUser;
use orbitid_federation::test_support::{start_oidc_server, OidcServerOptions};

struct Provider {
    server: orbitid_federation::test_support::OidcTestServer,
    harness: common::Harness,
}

async fn provider(user: OidcUser) -> Provider {
    let server = start_oidc_server(OidcServerOptions {
        client_id: "test-client".into(),
        client_secret: "test-secret".into(),
        user,
        code: "test-code".into(),
    })
    .await
    .expect("oidc server");
    let harness = harness_with(EnvOverrides {
        allow_private_networks: Some(true),
        ..Default::default()
    })
    .await;
    harness
        .state()
        .settings
        .update(serde_json::json!({
            "social": {
                "custom_mock": {
                    "enabled": true,
                    "clientId": "test-client",
                    "clientSecret": "test-secret",
                    "protocol": "oidc",
                    "discoveryUrl": format!("{}/.well-known/openid-configuration", server.issuer),
                    "pkce": true,
                    "authenticatableAtSignIn": true,
                }
            }
        }))
        .await
        .expect("configure provider");
    Provider { server, harness }
}

/// Runs the IdP's authorization endpoint (PKCE/nonce binding) and returns the
/// `code`/`state` the callback would receive.
async fn authorize(provider: &Provider, authorization_url: &str) -> (String, String) {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client.get(authorization_url).send().await.unwrap();
    assert!(
        response.status().is_redirection(),
        "authorize returned {}",
        response.status()
    );
    let location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let url = url::Url::parse(&location).unwrap();
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        if key == "code" {
            code = Some(value.into_owned());
        } else if key == "state" {
            state = Some(value.into_owned());
        }
    }
    let _ = &provider.server;
    (code.expect("code"), state.expect("state"))
}

#[tokio::test]
async fn oauth_sign_in_links_an_existing_verified_account() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    seed_user(h, "ada@acme.test", "Sup3r-secret!").await;

    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "strategy": "oauth_custom_mock",
                "redirect_url": "http://localhost:3000/after",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let value = created.value();
    let authorization_url = value["response"]["first_factor_verification"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(authorization_url.contains("code_challenge="));

    let (code, state) = authorize(&provider, &authorization_url).await;
    let callback = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={state}"),
            &[],
        )
        .await;
    assert_eq!(callback.status, StatusCode::FOUND, "{}", callback.text());
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_status=complete"),
        "location: {location}"
    );

    let client = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
    let user = &client["response"]["sessions"][0]["user"];
    assert_eq!(user["email_addresses"][0]["email_address"], "ada@acme.test");
    assert_eq!(user["external_accounts"][0]["provider"], "custom_mock");
}

#[tokio::test]
async fn oauth_callback_requires_the_browser_that_started_the_flow() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    seed_user(h, "ada@acme.test", "Sup3r-secret!").await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "strategy": "oauth_custom_mock" })),
            &[],
        )
        .await;
    let authorization_url = created.value()["response"]["first_factor_verification"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, state) = authorize(&provider, &authorization_url).await;
    let other = h.other_browser();
    let callback = other
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={state}"),
            &[],
        )
        .await;
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    assert!(location.contains("__orbit_error=oauth_callback_error"));
    assert!(location.to_lowercase().contains("different"));
}

#[tokio::test]
async fn an_unverified_provider_email_never_links_to_an_existing_account() {
    let provider = provider(OidcUser {
        email: "ada@acme.test".into(),
        email_verified: false,
        ..Default::default()
    })
    .await;
    let h = &provider.harness;
    seed_user(h, "ada@acme.test", "Sup3r-secret!").await;
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "strategy": "oauth_custom_mock",
                "redirect_url": "http://localhost:3000/after",
            })),
            &[],
        )
        .await;
    let authorization_url = created.value()["response"]["first_factor_verification"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, state) = authorize(&provider, &authorization_url).await;
    let callback = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={state}"),
            &[],
        )
        .await;
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_status=transferable"),
        "location: {location}"
    );
    let client = h.client.get("/v1/client", &[]).await.value();
    assert!(client["response"]["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        client["response"]["sign_in"]["status"],
        "needs_first_factor"
    );
}

async fn start_custom_flow(h: &common::Harness) -> (String, String) {
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "strategy": "oauth_custom_mock",
                "redirect_url": "http://localhost:3000/after",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let authorization_url = created.value()["response"]["first_factor_verification"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();
    let state = url::Url::parse(&authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .expect("state");
    (authorization_url, state)
}

#[tokio::test]
async fn unknown_or_replayed_callback_state_returns_to_the_home_page() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    h.state()
        .settings
        .update(serde_json::json!({
            "application": { "homeUrl": "http://localhost:3000" }
        }))
        .await
        .unwrap();

    let unknown = h
        .client
        .get("/v1/oauth_callback/custom_mock?code=x&state=bogus", &[])
        .await;
    assert_eq!(unknown.status, StatusCode::FOUND);
    let location = unknown.headers.get("location").unwrap().to_str().unwrap();
    assert!(location.starts_with("http://localhost:3000/"), "{location}");
    assert!(
        location.contains("__orbit_error=oauth_callback_error"),
        "{location}"
    );
    assert!(location.contains("__orbit_error_message="), "{location}");

    let (authorization_url, state) = start_custom_flow(h).await;
    let (code, callback_state) = authorize(&provider, &authorization_url).await;
    let first = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={callback_state}"),
            &[],
        )
        .await;
    assert_eq!(first.status, StatusCode::FOUND);
    let set_cookie = first
        .headers
        .get_all("set-cookie")
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(set_cookie.contains("__orbit_oauth=;"), "{set_cookie}");

    // The state is single-use.
    let replay = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={callback_state}"),
            &[],
        )
        .await;
    let location = replay.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_error=oauth_callback_error"),
        "{location}"
    );
    let _ = state;
}

#[tokio::test]
async fn callback_reports_provider_errors_and_missing_codes() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    let (_, state) = start_custom_flow(h).await;

    let denied = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?error=access_denied&state={state}"),
            &[],
        )
        .await;
    assert_eq!(denied.status, StatusCode::FOUND);
    let location = denied.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.starts_with("http://localhost:3000/after?"),
        "{location}"
    );
    assert!(
        location.contains("__orbit_error_message=access_denied"),
        "{location}"
    );

    let (_, state) = start_custom_flow(h).await;
    let missing = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?state={state}"),
            &[],
        )
        .await;
    let location = missing.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_error_message=Missing"),
        "{location}"
    );
}

#[tokio::test]
async fn form_post_callbacks_accept_a_json_body() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    seed_user(h, "ada@acme.test", "Sup3r-secret!").await;
    let (authorization_url, _) = start_custom_flow(h).await;
    let (code, state) = authorize(&provider, &authorization_url).await;

    let callback = h
        .client
        .post(
            "/v1/oauth_callback/custom_mock",
            Some(serde_json::json!({ "code": code, "state": state })),
            &[],
        )
        .await;
    assert_eq!(callback.status, StatusCode::FOUND, "{}", callback.text());
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    assert!(location.contains("__orbit_status=complete"), "{location}");
}

#[tokio::test]
async fn oauth_sign_up_completes_from_the_callback() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    let created = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({
                "strategy": "oauth_custom_mock",
                "redirect_url": "http://localhost:3000/after",
            })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let value = created.value();
    assert_eq!(
        value["response"]["verifications"]["external_account"]["status"],
        "unverified"
    );
    let authorization_url = value["response"]["verifications"]["external_account"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();

    let (code, state) = authorize(&provider, &authorization_url).await;
    let callback = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={state}"),
            &[],
        )
        .await;
    assert_eq!(callback.status, StatusCode::FOUND, "{}", callback.text());
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    // The verified provider address satisfies the email requirement; the
    // instance still requires a password, so the sign-up stays open.
    assert!(
        location.contains("__orbit_status=missing_requirements"),
        "{location}"
    );

    let state = h.client.get("/v1/client", &[]).await.value();
    let sign_up = &state["response"]["sign_up"];
    assert_eq!(sign_up["status"], "missing_requirements");
    assert_eq!(sign_up["email_address"], "ada@acme.test");
    assert_eq!(
        sign_up["verifications"]["email_address"]["status"],
        "verified"
    );
    assert_eq!(
        sign_up["verifications"]["external_account"]["status"],
        "verified"
    );
    assert!(sign_up["missing_fields"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "password"));

    let id = sign_up["id"].as_str().unwrap().to_string();
    let completed = h
        .client
        .patch(
            &format!("/v1/client/sign_ups/{id}"),
            Some(serde_json::json!({ "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_eq!(completed.status, StatusCode::OK, "{}", completed.text());
    assert_eq!(completed.value()["response"]["status"], "complete");
    let client = h.client.get("/v1/client", &[]).await.value();
    let sessions = client["response"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let user = &sessions[0]["user"];
    assert_eq!(user["email_addresses"][0]["email_address"], "ada@acme.test");
    assert_eq!(user["external_accounts"][0]["provider"], "custom_mock");
}

#[tokio::test]
async fn a_transferable_oauth_sign_in_feeds_the_transfer_sign_up() {
    let provider = provider(OidcUser::default()).await;
    let h = &provider.harness;
    let created = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({
                "strategy": "oauth_custom_mock",
                "redirect_url": "http://localhost:3000/after",
            })),
            &[],
        )
        .await;
    let authorization_url = created.value()["response"]["first_factor_verification"]
        ["external_verification_redirect_url"]
        .as_str()
        .unwrap()
        .to_string();
    let (code, state) = authorize(&provider, &authorization_url).await;
    let callback = h
        .client
        .get(
            &format!("/v1/oauth_callback/custom_mock?code={code}&state={state}"),
            &[],
        )
        .await;
    let location = callback.headers.get("location").unwrap().to_str().unwrap();
    assert!(
        location.contains("__orbit_status=transferable"),
        "{location}"
    );

    let state = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(state["response"]["sign_in"]["status"], "needs_first_factor");
    assert_eq!(
        state["response"]["sign_in"]["first_factor_verification"]["status"],
        "transferable"
    );

    let transferred = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "transfer": true })),
            &[],
        )
        .await;
    assert_eq!(transferred.status, StatusCode::OK, "{}", transferred.text());
    let response = &transferred.value()["response"];
    assert_eq!(response["email_address"], "ada@acme.test");
    assert_eq!(response["status"], "missing_requirements");
    assert_eq!(
        response["verifications"]["email_address"]["status"],
        "verified"
    );
    // The transfer profile was consumed from the pending sign-in.
    let pending = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(
        pending["response"]["sign_in"]["first_factor_verification"],
        serde_json::Value::Null
    );

    let id = response["id"].as_str().unwrap().to_string();
    let completed = h
        .client
        .patch(
            &format!("/v1/client/sign_ups/{id}"),
            Some(serde_json::json!({ "password": "Sup3r-secret!" })),
            &[],
        )
        .await;
    assert_eq!(completed.status, StatusCode::OK, "{}", completed.text());
    assert_eq!(completed.value()["response"]["status"], "complete");
    let client = h.client.get("/v1/client", &[]).await.value();
    assert_eq!(client["response"]["sessions"].as_array().unwrap().len(), 1);
    // Completing the sign-up abandons the sign-in it was transferred from.
    assert!(client["response"]["sign_in"].is_null());
}

#[tokio::test]
async fn transfer_without_a_pending_flow_is_refused() {
    let h = common::harness().await;
    let response = h
        .client
        .post(
            "/v1/client/sign_ups",
            Some(serde_json::json!({ "transfer": true })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(response.error_codes(), vec!["client_state_invalid"]);
}
