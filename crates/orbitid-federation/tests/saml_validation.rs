//! SAML response validation against real xmlsec signatures.
//!
//! The fixture signs with the same library the server verifies with, so these
//! tests exercise exclusive canonicalisation, the signature scope, timestamps,
//! audience, recipient, InResponseTo and replay protection for real.

#![cfg(feature = "test-util")]

use std::collections::BTreeMap;

use chrono::{Duration, Utc};
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::testing::test_state;
use orbitid_federation::saml::{
    profile_to_external_profile, saml_authorize_url, validate_saml_response, SamlCache,
};
use orbitid_federation::test_support::{
    make_key_pair, response_base64, response_xml, AssertionOptions, ConfirmationSpec, SignScope,
    TestKeyPair,
};
use serde_json::json;

struct Fixture {
    conn: EnterpriseConnectionRow,
    idp_keys: TestKeyPair,
    attacker_keys: TestKeyPair,
    base_url: String,
    sp_entity: String,
    acs_url: String,
}

async fn fixture(allow_idp_initiated: bool) -> Fixture {
    let idp_keys = make_key_pair("idp").expect("idp key");
    let attacker_keys = make_key_pair("attacker").expect("attacker key");
    let base_url = "http://localhost:4000".to_string();
    let entity = "https://idp.acme.test/metadata".to_string();
    let conn = connection(
        "ent_test",
        &entity,
        "https://idp.acme.test/sso",
        &idp_keys.certificate_pem,
        allow_idp_initiated,
    );
    let sp_entity = format!("{base_url}/v1/saml/ent_test");
    let acs_url = format!("{base_url}/v1/saml/ent_test/acs");
    Fixture {
        conn,
        idp_keys,
        attacker_keys,
        base_url,
        sp_entity,
        acs_url,
    }
}

fn connection(
    id: &str,
    entity: &str,
    sso: &str,
    cert: &str,
    allow_idp_initiated: bool,
) -> EnterpriseConnectionRow {
    let now = orbitid_federation::http::now_ms();
    EnterpriseConnectionRow {
        id: id.to_string(),
        name: "Acme SAML".to_string(),
        protocol: "saml".to_string(),
        provider: "saml".to_string(),
        domains: sqlx::types::Json(vec!["acme.test".to_string()]),
        active: true,
        allow_subdomains: false,
        allow_idp_initiated,
        sync_user_attributes: false,
        disable_additional_identifications: false,
        config: sqlx::types::Json(json!({
            "idpEntityId": entity,
            "idpSsoUrl": sso,
            "idpCertificate": cert,
        })),
        created_at: now,
        updated_at: now,
    }
}

fn options(fixture: &Fixture, in_response_to: Option<&str>) -> AssertionOptions {
    let mut options = AssertionOptions::new(fixture.sp_entity.clone(), fixture.acs_url.clone());
    options.in_response_to = in_response_to.map(str::to_string);
    options.name_id = Some("ada@acme.test".to_string());
    options
}

async fn validate(
    fixture: &Fixture,
    cache: &SamlCache,
    body: &str,
) -> orbitid_core::Result<orbitid_federation::saml::SamlProfile> {
    validate_saml_response(cache, &fixture.base_url, &fixture.conn, body).await
}

async fn request_id(fixture: &Fixture, cache: &SamlCache) -> String {
    saml_authorize_url(cache, &fixture.base_url, &fixture.conn, "relay")
        .await
        .expect("authorize url")
        .request_id
}

#[tokio::test]
async fn accepts_a_correctly_signed_assertion_and_maps_attributes() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &options(&fixture, Some(&id)),
    )
    .expect("response");
    let profile = validate(&fixture, &cache, &body).await.expect("valid");
    assert_eq!(profile.name_id.as_deref(), Some("ada@acme.test"));
    assert_eq!(profile.email.as_deref(), Some("ada@acme.test"));
    let external = profile_to_external_profile(&fixture.conn, &profile).expect("external");
    assert_eq!(external.provider, "saml_ent_test");
    assert_eq!(external.provider_user_id, "ada@acme.test");
    assert_eq!(external.first_name.as_deref(), Some("Ada"));
    assert_eq!(external.last_name.as_deref(), Some("Lovelace"));
    assert_eq!(external.email_verified, Some(true));
}

#[tokio::test]
async fn refuses_an_unsigned_response() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.sign = SignScope::None;
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
    assert!(!error.message.contains("BEGIN CERTIFICATE"));
}

#[tokio::test]
async fn refuses_a_response_whose_envelope_is_signed_but_the_assertion_is_not() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.sign = SignScope::Response;
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
    assert!(error.message.contains("not signed"));
}

#[tokio::test]
async fn refuses_a_signature_from_an_untrusted_key() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.key_pair = Some(fixture.attacker_keys.clone());
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
}

#[tokio::test]
async fn refuses_a_tampered_assertion() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let xml = response_xml(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &options(&fixture, Some(&id)),
    )
    .expect("response");
    let tampered = xml.replace(">ada@acme.test<", ">mallory@acme.test<");
    assert_ne!(xml, tampered);
    let body = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, tampered);
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
}

#[tokio::test]
async fn refuses_signature_wrapping_with_a_forged_assertion() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let xml = response_xml(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &options(&fixture, Some(&id)),
    )
    .expect("response");
    let forged = format!(
        r#"<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_forged" Version="2.0" IssueInstant="{}"><saml:Issuer>https://idp.acme.test/metadata</saml:Issuer><saml:Subject><saml:NameID>mallory@acme.test</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="{}" Recipient="{}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="{}" NotOnOrAfter="{}"><saml:AudienceRestriction><saml:Audience>{}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion>"#,
        Utc::now().to_rfc3339(),
        (Utc::now() + Duration::minutes(5)).to_rfc3339(),
        fixture.acs_url,
        (Utc::now() - Duration::minutes(1)).to_rfc3339(),
        (Utc::now() + Duration::minutes(5)).to_rfc3339(),
        fixture.sp_entity,
    );
    let wrapped = xml.replacen("<saml2:Assertion", &format!("{forged}<saml2:Assertion"), 1);
    assert_ne!(xml, wrapped);
    let body = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wrapped);
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
}

#[tokio::test]
async fn refuses_expired_and_not_yet_valid_assertions() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());

    let id = request_id(&fixture, &cache).await;
    let mut expired = options(&fixture, Some(&id));
    expired.not_before = Some(Utc::now() - Duration::hours(1));
    expired.not_on_or_after = Some(Utc::now() - Duration::minutes(30));
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &expired,
    )
    .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );

    let id = request_id(&fixture, &cache).await;
    let mut future = options(&fixture, Some(&id));
    future.not_before = Some(Utc::now() + Duration::hours(1));
    future.not_on_or_after = Some(Utc::now() + Duration::hours(2));
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &future)
        .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );
}

#[tokio::test]
async fn refuses_wrong_audience_destination_and_acs() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());

    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.audience = Some("https://other-sp.example".to_string());
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );

    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.destination = Some("https://other-sp.example/acs".to_string());
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );
}

#[tokio::test]
async fn refuses_unsolicited_responses_unless_idp_initiated_is_allowed() {
    let ctx = test_state().await;
    let strict = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &strict.idp_keys,
        &options(&strict, None),
    )
    .expect("response");
    assert_eq!(
        validate(&strict, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );

    let permissive = fixture(true).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &permissive.idp_keys,
        &options(&permissive, None),
    )
    .expect("response");
    assert!(validate(&permissive, &cache, &body).await.is_ok());
}

#[tokio::test]
async fn refuses_a_response_that_answers_another_request() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let _ = request_id(&fixture, &cache).await;
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &options(&fixture, Some("_never-issued")),
    )
    .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );
}

#[tokio::test]
async fn refuses_replayed_assertions_even_when_unsolicited() {
    let ctx = test_state().await;
    let fixture = fixture(true).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let body = response_base64(
        "https://idp.acme.test/metadata",
        &fixture.idp_keys,
        &options(&fixture, None),
    )
    .expect("response");
    assert!(validate(&fixture, &cache, &body).await.is_ok());
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
    assert!(error.message.contains("already been received"));
}

#[tokio::test]
async fn refuses_a_failure_status_response() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.status_failure = true;
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    assert_eq!(
        validate(&fixture, &cache, &body).await.unwrap_err().code,
        "verification_failed"
    );
}

#[tokio::test]
async fn honours_a_custom_attribute_mapping() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let mut conn = fixture.conn.clone();
    conn.config = sqlx::types::Json(json!({
        "idpEntityId": "https://idp.acme.test/metadata",
        "idpSsoUrl": "https://idp.acme.test/sso",
        "idpCertificate": fixture.idp_keys.certificate_pem,
        "attributeMapping": {
            "email": "mail", "firstName": "givenName", "lastName": "sn", "userId": "uid"
        }
    }));
    let id = request_id(&fixture, &cache).await;
    let mut opts = options(&fixture, Some(&id));
    opts.name_id = Some("ada-army-id".to_string());
    let mut attributes = BTreeMap::new();
    attributes.insert("mail".to_string(), vec!["ada@acme.test".to_string()]);
    attributes.insert("givenName".to_string(), vec!["Ada".to_string()]);
    attributes.insert("sn".to_string(), vec!["Byron".to_string()]);
    attributes.insert("uid".to_string(), vec!["army-1".to_string()]);
    opts.attributes = attributes;
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    let profile = validate_saml_response(&cache, &fixture.base_url, &conn, &body)
        .await
        .expect("valid");
    let external = profile_to_external_profile(&conn, &profile).expect("external");
    assert_eq!(external.email.as_deref(), Some("ada@acme.test"));
    assert_eq!(external.first_name.as_deref(), Some("Ada"));
    assert_eq!(external.last_name.as_deref(), Some("Byron"));
    assert_eq!(external.provider_user_id, "army-1");
}

#[tokio::test]
async fn generated_authn_request_is_remembered_and_names_the_acs() {
    let ctx = test_state().await;
    let fixture = fixture(false).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let generated = saml_authorize_url(&cache, &fixture.base_url, &fixture.conn, "relay-1")
        .await
        .expect("url");
    assert!(generated.url.starts_with("https://idp.acme.test/sso?"));
    assert!(generated.url.contains("RelayState=relay-1"));
    assert!(cache
        .get(&generated.request_id)
        .await
        .expect("cache")
        .is_some());
    let url = url::Url::parse(&generated.url).expect("url");
    let encoded = url
        .query_pairs()
        .find(|(name, _)| name == "SAMLRequest")
        .map(|(_, value)| value.into_owned())
        .expect("SAMLRequest");
    let request = orbitid_federation::test_support::parse_authn_request(&encoded).expect("request");
    assert_eq!(request.id, generated.request_id);
    assert_eq!(request.acs_url, fixture.acs_url);
    assert_eq!(request.issuer, fixture.sp_entity);
    assert_eq!(
        request.destination.as_deref(),
        Some("https://idp.acme.test/sso")
    );
}

#[tokio::test]
async fn refuses_a_recipient_that_only_the_unsigned_document_names() {
    let ctx = test_state().await;
    // IdP-initiated is allowed so the test isolates the Recipient check.
    let fixture = fixture(true).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let mut opts = options(&fixture, None);
    // The signed assertion is addressed to another ACS ...
    opts.subject_confirmations = Some(vec![ConfirmationSpec::bearer(
        "https://other-sp.example/acs",
        Utc::now() + Duration::minutes(5),
    )]);
    let signed =
        response_xml("https://idp.acme.test/metadata", &fixture.idp_keys, &opts).expect("response");
    // ... while an unsigned sibling inside the Response names ours.
    let decoy = format!(
        r#"<x:SubjectConfirmationData xmlns:x="urn:oasis:names:tc:SAML:2.0:assertion" Recipient="{}" NotOnOrAfter="{}"/>"#,
        fixture.acs_url,
        (Utc::now() + Duration::minutes(5)).to_rfc3339(),
    );
    let wrapped = signed.replacen(
        "</saml2:Assertion>",
        &format!("</saml2:Assertion>{decoy}"),
        1,
    );
    assert_ne!(signed, wrapped);
    let body = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wrapped);
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
    assert!(
        error
            .message
            .contains("no valid bearer subject confirmation"),
        "unexpected error: {}",
        error.message
    );
}

#[tokio::test]
async fn refuses_confirmations_that_only_jointly_satisfy_the_checks() {
    let ctx = test_state().await;
    let fixture = fixture(true).await;
    let cache = SamlCache::new(ctx.state.pool.clone());
    let mut opts = options(&fixture, None);
    // One confirmation has the right Recipient but is expired; the other is
    // timely but addressed to a different ACS. Neither is acceptable alone.
    opts.subject_confirmations = Some(vec![
        ConfirmationSpec {
            not_on_or_after: Some(Utc::now() - Duration::minutes(5)),
            ..ConfirmationSpec::bearer(&fixture.acs_url, Utc::now() + Duration::minutes(5))
        },
        ConfirmationSpec::bearer(
            "https://other-sp.example/acs",
            Utc::now() + Duration::minutes(5),
        ),
    ]);
    let body = response_base64("https://idp.acme.test/metadata", &fixture.idp_keys, &opts)
        .expect("response");
    let error = validate(&fixture, &cache, &body).await.unwrap_err();
    assert_eq!(error.code, "verification_failed");
    assert!(
        error
            .message
            .contains("no valid bearer subject confirmation"),
        "unexpected error: {}",
        error.message
    );
}
