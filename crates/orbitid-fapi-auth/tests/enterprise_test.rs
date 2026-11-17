//! Ported from `test/machine/enterprise-{oidc,saml}.test.ts` (the Frontend
//! API / SAML SP halves) and the enterprise routing cases of
//! `test/core/auth.test.ts`.

mod common;

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode};
use common::{harness, seed_user, Harness};
use orbitid_federation::test_support::saml::{
    parse_authn_request, response_base64, AssertionOptions, SignScope,
};
use orbitid_federation::test_support::{make_key_pair, TestKeyPair};
use tower::ServiceExt;

const BASE: &str = "http://localhost:4000";
const AFTER: &str = "http://localhost:3000/after";

async fn insert_connection(
    h: &Harness,
    id: &str,
    protocol: &str,
    domains: &[&str],
    active: bool,
    allow_idp_initiated: bool,
    config: serde_json::Value,
) {
    let now = orbitid_core::http::now();
    sqlx::query(
        "INSERT INTO enterprise_connections (id, name, protocol, provider, domains, active, \
         allow_subdomains, allow_idp_initiated, sync_user_attributes, \
         disable_additional_identifications, config, created_at, updated_at) \
         VALUES ($1, $1, $2, 'custom', $3, $4, true, $5, true, false, $6, $7, $7)",
    )
    .bind(id)
    .bind(protocol)
    .bind(sqlx::types::Json(serde_json::json!(domains)))
    .bind(active)
    .bind(allow_idp_initiated)
    .bind(sqlx::types::Json(config))
    .bind(now)
    .execute(&h.state().pool)
    .await
    .unwrap();
}

fn saml_config(key: &TestKeyPair) -> serde_json::Value {
    serde_json::json!({
        "idpEntityId": "https://idp.example/metadata",
        "idpSsoUrl": "https://idp.example/sso",
        "idpCertificate": key.certificate_pem,
    })
}

async fn insert_saml(h: &Harness, id: &str, key: &TestKeyPair, active: bool) -> String {
    insert_connection(
        h,
        id,
        "saml",
        &["acme.test"],
        active,
        false,
        saml_config(key),
    )
    .await;
    format!("{BASE}/v1/saml/{id}")
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let url = url::Url::parse(url).unwrap();
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

async fn post_form(
    h: &Harness,
    path: &str,
    cookie: Option<&str>,
    form: &[(&str, &str)],
) -> (StatusCode, HeaderMap, String) {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in form {
        serializer.append_pair(key, value);
    }
    let mut builder = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let request = builder
        .body(Body::from(serializer.finish()))
        .expect("request");
    let response = common::build(h.state().clone())
        .oneshot(request)
        .await
        .expect("router");
    let status = response.status();
    let headers = response.headers().clone();
    let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

fn location(headers: &HeaderMap) -> String {
    headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn sign_in_routes_an_enterprise_domain_to_its_connection() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    insert_saml(&h, "ent_saml", &key, true).await;

    let response = h
        .client
        .post(
            "/v1/client/sign_ins",
            Some(serde_json::json!({ "identifier": "ada@acme.test" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let sign_in = &response.value()["response"];
    assert_eq!(sign_in["status"], "needs_first_factor");
    assert_eq!(
        sign_in["first_factor_verification"]["strategy"],
        "enterprise_sso"
    );
    let url = sign_in["first_factor_verification"]["external_verification_redirect_url"]
        .as_str()
        .unwrap_or_else(|| panic!("{}", response.text()));
    assert!(url.contains("/v1/client/enterprise/start"), "{url}");
    assert!(url.contains("connection_id=ent_saml"), "{url}");
    // The account may not exist yet: domain routing hands the browser to the
    // IdP without resolving (or exposing) a local user.
    assert!(sign_in["supported_first_factors"].is_null());
}

#[tokio::test]
async fn enterprise_start_uses_the_browser_client_and_routes_domains() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    insert_saml(&h, "ent_saml", &key, true).await;

    // Without a client cookie the flow cannot be bound to a browser.
    let anonymous = h.other_browser();
    let refused = anonymous
        .get(
            &format!("/v1/client/enterprise/start?identifier=ada%40acme.test&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(refused.error_codes(), vec!["client_state_invalid"]);

    // Bootstrap the browser's own client.
    h.client.get("/v1/client", &[]).await;

    for query in [
        "identifier=ada%40acme.test",
        "domain=acme.test",
        "domain=https%3A%2F%2Facme.test%2Flogin",
        "email_address=ada%40dept.acme.test",
    ] {
        let response = h
            .client
            .get(
                &format!("/v1/client/enterprise/start?{query}&redirect_url={AFTER}"),
                &[],
            )
            .await;
        assert_eq!(response.status, StatusCode::FOUND, "{query}");
        let location = location(&response.headers);
        assert!(
            location.starts_with("https://idp.example/sso?"),
            "{location}"
        );
        assert!(location.contains("SAMLRequest="), "{location}");
        assert!(location.contains("RelayState="), "{location}");
        let cookies = response
            .headers
            .get_all("set-cookie")
            .iter()
            .map(|value| value.to_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(cookies.contains("__orbit_oauth="), "{cookies}");
    }

    let unknown_domain = h
        .client
        .get(
            &format!("/v1/client/enterprise/start?domain=other.test&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(unknown_domain.status, StatusCode::NOT_FOUND);
    assert_eq!(unknown_domain.error_codes(), vec!["resource_not_found"]);

    let unknown_id = h
        .client
        .get(
            &format!("/v1/client/enterprise/start?connection_id=nope&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(unknown_id.status, StatusCode::NOT_FOUND);

    let foreign_client = h
        .client
        .get(
            &format!(
                "/v1/client/enterprise/start?connection_id=ent_saml&client_id=cli_someoneelse&redirect_url={AFTER}"
            ),
            &[],
        )
        .await;
    assert_eq!(foreign_client.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(foreign_client.error_codes(), vec!["client_state_invalid"]);

    let bad_redirect = h
        .client
        .get(
            "/v1/client/enterprise/start?identification=acme.test&connection_id=ent_saml&redirect_url=https%3A%2F%2Fevil.example%2F",
            &[],
        )
        .await;
    assert_eq!(bad_redirect.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(bad_redirect.error_codes(), vec!["form_param_value_invalid"]);
}

#[tokio::test]
async fn sp_initiated_saml_login_completes_a_session_once() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    let sp_entity_id = insert_saml(&h, "ent_saml", &key, true).await;
    let acs_url = format!("{sp_entity_id}/acs");
    let user = seed_user(&h, "ada@acme.test", "Sup3r-secret!").await;

    h.client.get("/v1/client", &[]).await;
    let start = h
        .client
        .get(
            &format!("/v1/client/enterprise/start?identifier=ada%40acme.test&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(start.status, StatusCode::FOUND, "{}", start.text());
    let sso_url = location(&start.headers);
    let saml_request = query_param(&sso_url, "SAMLRequest").expect("SAMLRequest");
    let relay_state = query_param(&sso_url, "RelayState").expect("RelayState");
    let request = parse_authn_request(&saml_request).unwrap();
    assert!(request.acs_url.ends_with("/v1/saml/ent_saml/acs"));

    let mut options = AssertionOptions::new(&sp_entity_id, &acs_url);
    options.in_response_to = Some(request.id.clone());
    options.name_id = Some("ada@acme.test".into());
    let response = response_base64("https://idp.example/metadata", &key, &options).unwrap();

    let cookie = h.client.cookie_header();
    let (status, headers, body) = post_form(
        &h,
        "/v1/saml/ent_saml/acs",
        cookie.as_deref(),
        &[("SAMLResponse", &response), ("RelayState", &relay_state)],
    )
    .await;
    assert_eq!(status, StatusCode::FOUND, "{body}");
    let target = location(&headers);
    assert!(
        target.starts_with("http://localhost:3000/after"),
        "{target}"
    );
    assert!(target.contains("__orbit_status=complete"), "{target}");

    let client = h.client.get("/v1/client", &[]).await.value();
    let sessions = client["response"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["user"]["id"], user.user.id);
    assert_eq!(
        sessions[0]["user"]["email_addresses"][0]["email_address"],
        "ada@acme.test"
    );
    assert_eq!(
        sessions[0]["user"]["external_accounts"][0]["provider"],
        "saml_ent_saml"
    );

    // The AuthnRequest is single-use: replaying the same assertion is refused.
    let (status, _, body) = post_form(
        &h,
        "/v1/saml/ent_saml/acs",
        cookie.as_deref(),
        &[("SAMLResponse", &response), ("RelayState", &relay_state)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("verification_failed"), "{body}");
}

#[tokio::test]
async fn saml_acs_refuses_unsigned_and_foreign_assertions() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    let sp_entity_id = insert_saml(&h, "ent_saml", &key, true).await;
    let acs_url = format!("{sp_entity_id}/acs");
    h.client.get("/v1/client", &[]).await;
    let start = h
        .client
        .get(
            &format!("/v1/client/enterprise/start?identifier=ada%40acme.test&redirect_url={AFTER}"),
            &[],
        )
        .await;
    let sso_url = location(&start.headers);
    let relay_state = query_param(&sso_url, "RelayState").expect("RelayState");
    let request = parse_authn_request(&query_param(&sso_url, "SAMLRequest").unwrap()).unwrap();
    let cookie = h.client.cookie_header();

    let mut unsigned = AssertionOptions::new(&sp_entity_id, &acs_url);
    unsigned.in_response_to = Some(request.id.clone());
    unsigned.sign = SignScope::None;
    let response = response_base64("https://idp.example/metadata", &key, &unsigned).unwrap();
    let (status, _, body) = post_form(
        &h,
        "/v1/saml/ent_saml/acs",
        cookie.as_deref(),
        &[("SAMLResponse", &response), ("RelayState", &relay_state)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("verification_failed"), "{body}");

    let foreign = make_key_pair("foreign").unwrap();
    let mut forged = AssertionOptions::new(&sp_entity_id, &acs_url);
    forged.in_response_to = Some(request.id.clone());
    let response = response_base64("https://idp.example/metadata", &foreign, &forged).unwrap();
    let (status, _, body) = post_form(
        &h,
        "/v1/saml/ent_saml/acs",
        cookie.as_deref(),
        &[("SAMLResponse", &response), ("RelayState", &relay_state)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("verification_failed"), "{body}");
}

#[tokio::test]
async fn saml_endpoints_distinguish_protocol_and_active_state() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    insert_connection(
        &h,
        "ent_oidc",
        "oidc",
        &["oidc.test"],
        true,
        false,
        serde_json::json!({ "discoveryUrl": "http://127.0.0.1:9/x" }),
    )
    .await;
    insert_saml(&h, "ent_off", &key, false).await;
    insert_saml(&h, "ent_on", &key, true).await;

    for path in ["/v1/saml/ent_oidc/metadata", "/v1/saml/ent_oidc/sso"] {
        let response = h.client.get(path, &[]).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(response.error_codes(), vec!["resource_not_found"]);
    }

    h.client.get("/v1/client", &[]).await;
    let inactive_sso = h
        .client
        .get(
            &format!("/v1/saml/ent_off/sso?redirect_url={AFTER}&flow=whatever"),
            &[],
        )
        .await;
    assert_eq!(inactive_sso.status, StatusCode::FORBIDDEN);
    assert_eq!(inactive_sso.error_codes(), vec!["not_allowed_access"]);

    let (status, _, body) = post_form(&h, "/v1/saml/ent_off/acs", None, &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Metadata is public even for an inactive connection (the IdP may need it).
    let metadata = h.client.get("/v1/saml/ent_off/metadata", &[]).await;
    assert_eq!(metadata.status, StatusCode::OK);

    let unknown_flow = h
        .client
        .get(
            &format!("/v1/saml/ent_on/sso?flow=bogus&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(unknown_flow.status, StatusCode::BAD_REQUEST);
    assert_eq!(unknown_flow.error_codes(), vec!["verification_failed"]);
}

#[tokio::test]
async fn oidc_callback_reports_provider_errors_and_rejects_bad_state() {
    let h = harness().await;
    insert_connection(
        &h,
        "ent_oidc",
        "oidc",
        &["oidc.test"],
        true,
        false,
        serde_json::json!({ "discoveryUrl": "http://127.0.0.1:9/x" }),
    )
    .await;
    let key = make_key_pair("acme-idp").unwrap();
    insert_saml(&h, "ent_saml", &key, true).await;

    let provider_error = h
        .client
        .get(
            "/v1/client/enterprise/oidc_callback/ent_oidc?error=access_denied&error_description=nope",
            &[],
        )
        .await;
    assert_eq!(provider_error.status, StatusCode::BAD_REQUEST);
    assert_eq!(provider_error.error_codes(), vec!["oauth_callback_error"]);
    assert!(provider_error.text().contains("nope"));

    let bad_state = h
        .client
        .get(
            "/v1/client/enterprise/oidc_callback/ent_oidc?code=abc&state=bogus",
            &[],
        )
        .await;
    assert_eq!(bad_state.status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_state.error_codes(), vec!["verification_failed"]);

    let wrong_protocol = h
        .client
        .get(
            "/v1/client/enterprise/oidc_callback/ent_saml?code=abc&state=x",
            &[],
        )
        .await;
    assert_eq!(wrong_protocol.status, StatusCode::NOT_FOUND);

    sqlx::query("UPDATE enterprise_connections SET active = false WHERE id = 'ent_oidc'")
        .execute(&h.state().pool)
        .await
        .unwrap();
    let inactive = h
        .client
        .get(
            "/v1/client/enterprise/oidc_callback/ent_oidc?code=abc&state=x",
            &[],
        )
        .await;
    assert_eq!(inactive.status, StatusCode::FORBIDDEN);
    assert_eq!(inactive.error_codes(), vec!["not_allowed_access"]);
}

#[tokio::test]
async fn unsolicited_saml_responses_are_refused() {
    let h = harness().await;
    let key = make_key_pair("acme-idp").unwrap();
    let sp_entity_id = insert_saml(&h, "ent_saml", &key, true).await;
    let acs_url = format!("{sp_entity_id}/acs");

    let options = AssertionOptions::new(&sp_entity_id, &acs_url);
    let response = response_base64("https://idp.example/metadata", &key, &options).unwrap();
    let (status, _, body) = post_form(
        &h,
        "/v1/saml/ent_saml/acs",
        None,
        &[("SAMLResponse", &response)],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("verification_failed"), "{body}");
}

async fn oidc_connection(
    h: &Harness,
    id: &str,
    discovery_url: &str,
    client_id: &str,
    secret: &str,
) {
    let encrypted = orbitid_core::crypto::encrypt(&h.state().env.encryption_key, secret).unwrap();
    insert_connection(
        h,
        id,
        "oidc",
        &["acme.test"],
        true,
        false,
        serde_json::json!({
            "clientId": client_id,
            "clientSecretEnc": encrypted,
            "discoveryUrl": discovery_url,
        }),
    )
    .await;
}

async fn run_authorize(url: &str) -> (String, String) {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client.get(url).send().await.unwrap();
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
    let parsed = url::Url::parse(&location).unwrap();
    let mut code = None;
    let mut state = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            _ => {}
        }
    }
    (code.expect("code"), state.expect("state"))
}

#[tokio::test]
async fn enterprise_oidc_login_completes_a_session() {
    use orbitid_core::config::EnvOverrides;
    use orbitid_federation::test_support::oidc::OidcUser;
    use orbitid_federation::test_support::{start_oidc_server, OidcServerOptions};

    let server = start_oidc_server(OidcServerOptions {
        client_id: "ent-client".into(),
        client_secret: "ent-secret".into(),
        user: OidcUser {
            email: "ada@acme.test".into(),
            email_verified: true,
            ..Default::default()
        },
        code: "ent-code".into(),
    })
    .await
    .expect("oidc server");
    let h = common::harness_with(EnvOverrides {
        allow_private_networks: Some(true),
        ..Default::default()
    })
    .await;
    oidc_connection(
        &h,
        "ent_oidc",
        &format!("{}/.well-known/openid-configuration", server.issuer),
        "ent-client",
        "ent-secret",
    )
    .await;
    let user = seed_user(&h, "ada@acme.test", "Sup3r-secret!").await;
    h.client.get("/v1/client", &[]).await;

    let start = h
        .client
        .get(
            &format!("/v1/client/enterprise/start?connection_id=ent_oidc&redirect_url={AFTER}"),
            &[],
        )
        .await;
    assert_eq!(start.status, StatusCode::FOUND, "{}", start.text());
    let authorize_url = location(&start.headers);
    assert!(
        authorize_url.starts_with(&format!("{}/authorize", server.issuer)),
        "{authorize_url}"
    );
    let (code, state) = run_authorize(&authorize_url).await;

    let callback = h
        .client
        .get(
            &format!("/v1/client/enterprise/oidc_callback/ent_oidc?code={code}&state={state}"),
            &[],
        )
        .await;
    assert_eq!(callback.status, StatusCode::FOUND, "{}", callback.text());
    let target = location(&callback.headers);
    assert!(target.contains("__orbit_status=complete"), "{target}");

    let client = h.client.get("/v1/client", &[]).await.value();
    let sessions = client["response"]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["user"]["id"], user.user.id);
    assert_eq!(
        sessions[0]["user"]["external_accounts"][0]["provider"],
        "oidc_ent_oidc"
    );

    // The state is single-use.
    let replay = h
        .client
        .get(
            &format!("/v1/client/enterprise/oidc_callback/ent_oidc?code={code}&state={state}"),
            &[],
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST);
    assert_eq!(replay.error_codes(), vec!["verification_failed"]);
}
