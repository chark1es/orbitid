//! Enterprise OIDC connections: discovery caching, authorization URL, code
//! exchange, ID-token verification, userinfo and profile mapping.

#![cfg(feature = "test-util")]

use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::testing::test_state;
use orbitid_federation::saml::{
    decrypt_client_secret, encrypt_client_secret, enterprise_oidc_authorize_url,
    enterprise_oidc_profile, exchange_enterprise_oidc_code, fetch_enterprise_user_info,
    get_oidc_discovery, verify_enterprise_id_token, EnterpriseAuthorizeParams,
};
use orbitid_federation::test_support::{start_oidc_server, OidcServerOptions};
use serde_json::{json, Value};

async fn insert_connection(
    state: &orbitid_core::AppState,
    server: &orbitid_federation::test_support::OidcTestServer,
) -> EnterpriseConnectionRow {
    let secret =
        encrypt_client_secret(&state.env.encryption_key, &server.client_secret).expect("encrypt");
    let now = orbitid_federation::http::now_ms();
    sqlx::query(
        "INSERT INTO enterprise_connections \
         (id, name, protocol, provider, domains, active, allow_subdomains, allow_idp_initiated, \
          sync_user_attributes, disable_additional_identifications, config, created_at, updated_at) \
         VALUES ($1, 'Acme OIDC', 'oidc', 'custom', $2, true, false, false, false, false, $3, $4, $4)",
    )
    .bind("ent_oidc")
    .bind(sqlx::types::Json(json!(["acme.test"])))
    .bind(sqlx::types::Json(json!({
        "clientId": server.client_id,
        "clientSecretEnc": secret,
        "discoveryUrl": format!("{}/.well-known/openid-configuration", server.base_url),
    })))
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("insert");
    sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT id, name, protocol, provider, domains, active, allow_subdomains, \
         allow_idp_initiated, sync_user_attributes, disable_additional_identifications, \
         config, created_at, updated_at FROM enterprise_connections WHERE id = 'ent_oidc'",
    )
    .fetch_one(&state.pool)
    .await
    .expect("row")
}

#[tokio::test]
async fn discovery_is_loaded_persisted_and_used_for_the_flow() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let conn = insert_connection(&ctx.state, &server).await;

    let discovery = get_oidc_discovery(&ctx.state, &conn)
        .await
        .expect("discovery");
    assert_eq!(discovery.issuer, server.issuer);
    assert_eq!(
        discovery.authorization_endpoint,
        format!("{}/authorize", server.base_url)
    );
    assert!(conn.config.0.get("discovery").is_none());
    let reloaded = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT id, name, protocol, provider, domains, active, allow_subdomains, \
         allow_idp_initiated, sync_user_attributes, disable_additional_identifications, \
         config, created_at, updated_at FROM enterprise_connections WHERE id = 'ent_oidc'",
    )
    .fetch_one(&ctx.state.pool)
    .await
    .expect("row");
    assert!(reloaded.config.0.get("discovery").is_some());

    let secret = decrypt_client_secret(&ctx.state.env.encryption_key, &reloaded).expect("decrypt");
    assert_eq!(secret, server.client_secret);

    let verifier = "enterprise-verifier-enterprise-verifier-01";
    let challenge = orbitid_federation::adapters::pkce_challenge(verifier);
    let params = EnterpriseAuthorizeParams {
        redirect_uri: format!(
            "{}/v1/client/enterprise/oidc_callback/ent_oidc",
            "http://localhost:4000"
        ),
        state: "state-1".to_string(),
        nonce: "nonce-1".to_string(),
        code_challenge: challenge,
        scope: None,
    };
    let url = enterprise_oidc_authorize_url(&reloaded, &discovery, &params).expect("url");
    let parsed = url::Url::parse(&url).expect("parse");
    let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    assert_eq!(
        query.get("client_id").map(String::as_str),
        Some(server.client_id.as_str())
    );
    assert_eq!(
        query.get("code_challenge_method").map(String::as_str),
        Some("S256")
    );
    assert_eq!(
        query.get("scope").map(String::as_str),
        Some("openid profile email")
    );
    assert_eq!(query.get("nonce").map(String::as_str), Some("nonce-1"));

    // The browser visits the IdP (records the PKCE challenge and nonce).
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
        .get(&url)
        .send()
        .await
        .expect("authorize");
    assert_eq!(response.status().as_u16(), 302);

    let tokens = exchange_enterprise_oidc_code(
        &ctx.state,
        &reloaded,
        &discovery,
        "test-code",
        &params.redirect_uri,
        Some(verifier),
    )
    .await
    .expect("exchange");
    assert_eq!(tokens.access_token, "test-access-token");
    let id_token = tokens.id_token.as_deref().expect("id token");
    let claims =
        verify_enterprise_id_token(&ctx.state, &reloaded, &discovery, id_token, Some("nonce-1"))
            .await
            .expect("id token");
    assert_eq!(claims["sub"], "user_mock_1");
    let wrong_nonce = verify_enterprise_id_token(
        &ctx.state,
        &reloaded,
        &discovery,
        id_token,
        Some("other-nonce"),
    )
    .await;
    assert_eq!(wrong_nonce.unwrap_err().code, "oauth_callback_error");

    let userinfo = fetch_enterprise_user_info(&ctx.state, &discovery, &tokens.access_token)
        .await
        .expect("userinfo");
    assert_eq!(userinfo["email"], "ada@acme.test");
    let profile = enterprise_oidc_profile(&reloaded, &userinfo, &tokens).expect("profile");
    assert_eq!(profile.provider, "oidc_ent_oidc");
    assert_eq!(profile.provider_user_id, "user_mock_1");
    assert_eq!(profile.email.as_deref(), Some("ada@acme.test"));
    assert_eq!(profile.email_verified, Some(true));
    assert!(profile.access_token.is_some());
    server.close().await;
}

#[tokio::test]
async fn an_incomplete_discovery_document_is_refused() {
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let ctx = test_state().await;
    // A discovery document missing `jwks_uri` must be rejected.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    let app = axum::Router::new().route(
        "/.well-known/openid-configuration",
        axum::routing::get(|| async {
            axum::Json(json!({
                "issuer": "https://idp.example",
                "authorization_endpoint": "https://idp.example/authorize",
                "token_endpoint": "https://idp.example/token",
            }))
        }),
    );
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let now = orbitid_federation::http::now_ms();
    sqlx::query(
        "INSERT INTO enterprise_connections \
         (id, name, protocol, provider, domains, active, allow_subdomains, allow_idp_initiated, \
          sync_user_attributes, disable_additional_identifications, config, created_at, updated_at) \
         VALUES ('ent_bad', 'Bad', 'oidc', 'custom', $1, true, false, false, false, false, $2, $3, $3)",
    )
    .bind(sqlx::types::Json(json!([])))
    .bind(sqlx::types::Json(json!({
        "clientId": "id", "clientSecretEnc": "v1.a.b.c",
        "discoveryUrl": format!("http://127.0.0.1:{}/.well-known/openid-configuration", address.port()),
    })))
    .bind(now)
    .execute(&ctx.state.pool)
    .await
    .expect("insert");
    let row = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT id, name, protocol, provider, domains, active, allow_subdomains, \
         allow_idp_initiated, sync_user_attributes, disable_additional_identifications, \
         config, created_at, updated_at FROM enterprise_connections WHERE id = 'ent_bad'",
    )
    .fetch_one(&ctx.state.pool)
    .await
    .expect("row");
    let error = get_oidc_discovery(&ctx.state, &row).await.unwrap_err();
    assert_eq!(error.code, "oauth_callback_error");
    assert!(error.message.contains("incomplete"));
    join.abort();
    server.close().await;
}

#[tokio::test]
async fn profile_requires_a_subject() {
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let ctx = test_state().await;
    let conn = insert_connection(&ctx.state, &server).await;
    let tokens = orbitid_federation::saml::EnterpriseTokenResponse {
        access_token: "at".to_string(),
        ..Default::default()
    };
    let error =
        enterprise_oidc_profile(&conn, &json!({ "email": "ada@acme.test" }), &tokens).unwrap_err();
    assert_eq!(error.code, "oauth_callback_error");
    assert!(error.message.contains("subject"));
    let _: Value = json!({});
    server.close().await;
}
