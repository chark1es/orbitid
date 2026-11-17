//! Dashboard "Test connection" preview and IdP metadata import over real HTTP.

#![cfg(feature = "test-util")]

use axum::routing::get;
use axum::Router;
use orbitid_core::testing::test_state;
use orbitid_federation::preview::{preview_provider, ProviderPreviewInput};
use orbitid_federation::saml::fetch_idp_metadata;
use orbitid_federation::test_support::{make_key_pair, start_oidc_server, OidcServerOptions};
use serde_json::json;

#[tokio::test]
async fn preview_checks_a_real_discovery_document() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let preview = preview_provider(
        &ctx.state,
        &ProviderPreviewInput {
            discovery_url: Some(format!(
                "{}/.well-known/openid-configuration",
                server.base_url
            )),
            ..ProviderPreviewInput::default()
        },
    )
    .await;
    assert!(
        preview.ok,
        "errors: {:?} warnings: {:?}",
        preview.errors, preview.warnings
    );
    assert_eq!(preview.issuer.as_deref(), Some(server.issuer.as_str()));
    assert!(preview.checks.len() >= 2);
    assert!(preview.checks.iter().all(|check| check.reachable));
    assert_eq!(preview.pkce_supported, Some(true));
    assert_eq!(
        preview.endpoints.authorization,
        format!("{}/authorize", server.base_url)
    );
    server.close().await;
}

#[tokio::test]
async fn preview_reports_bad_manual_endpoints_without_saving() {
    let ctx = test_state().await;
    let preview = preview_provider(
        &ctx.state,
        &ProviderPreviewInput {
            protocol: None,
            discovery_url: None,
            issuer: None,
            authorization_url: Some("not-a-url".to_string()),
            token_url: Some("https://idp.example/token".to_string()),
            userinfo_url: None,
            jwks_url: None,
        },
    )
    .await;
    assert!(!preview.ok);
    assert!(preview.errors.join(" ").to_lowercase().contains("url"));
    assert!(!ctx
        .state
        .settings
        .get()
        .social
        .contains_key("custom_nothing"));
}

#[tokio::test]
async fn preview_accepts_valid_manual_endpoints_and_probes_them() {
    let ctx = test_state().await;
    let server = start_oidc_server(OidcServerOptions::default())
        .await
        .expect("server");
    let preview = preview_provider(
        &ctx.state,
        &ProviderPreviewInput {
            protocol: Some(orbitid_core::settings::types::SocialProtocol::Oidc),
            discovery_url: None,
            issuer: Some(server.issuer.clone()),
            authorization_url: Some(format!("{}/authorize", server.base_url)),
            token_url: Some(format!("{}/token", server.base_url)),
            userinfo_url: Some(format!("{}/userinfo", server.base_url)),
            jwks_url: Some(format!("{}/jwks", server.base_url)),
        },
    )
    .await;
    assert!(preview.ok, "errors: {:?}", preview.errors);
    assert_eq!(preview.issuer.as_deref(), Some(server.issuer.as_str()));
    assert_eq!(preview.checks.len(), 4);
    server.close().await;
}

#[tokio::test]
async fn fetches_and_parses_idp_metadata_through_the_ssrf_guard() {
    let ctx = test_state().await;
    let keys = make_key_pair("metadata").expect("key");
    let certificate = keys
        .certificate_pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    let xml = format!(
        r#"<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.test/metadata">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>{certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.test/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"#
    );
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let body = xml.clone();
    let app = Router::new().route(
        "/metadata",
        get(move || {
            let body = body.clone();
            async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/xml")],
                    body,
                )
            }
        }),
    );
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let parsed = fetch_idp_metadata(
        &ctx.state,
        &format!("http://127.0.0.1:{}/metadata", address.port()),
    )
    .await
    .expect("metadata");
    assert_eq!(
        parsed.entity_id.as_deref(),
        Some("https://idp.test/metadata")
    );
    assert_eq!(parsed.sso_url.as_deref(), Some("https://idp.test/sso"));
    assert!(parsed
        .certificate
        .as_deref()
        .is_some_and(|value| value.contains("BEGIN CERTIFICATE")));

    // With development mode off the loopback URL is refused before any connection.
    ctx.state
        .settings
        .update(json!({ "application": { "developmentMode": false } }))
        .await
        .expect("settings");
    let refused = fetch_idp_metadata(
        &ctx.state,
        &format!("http://127.0.0.1:{}/metadata", address.port()),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, "form_param_format_invalid");
    assert_eq!(
        refused.meta.as_ref().unwrap()["param_name"],
        "idp_metadata_url"
    );
    join.abort();
}
