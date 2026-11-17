//! Ported from `test/enterprise-domains.test.ts`,
//! `test/machine/enterprise-{oidc,saml}.test.ts` (config parts) and
//! `test/federation/enterprise-metadata.test.ts` (pasted XML path).

mod common;

use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

const DISCOVERY: &str = "https://idp.example.com/.well-known/openid-configuration";

fn oidc_connection(domains: &[&str], extra: Value) -> Value {
    let mut body = json!({
        "name": format!("Conn {}", domains.join(",")),
        "protocol": "oidc",
        "provider": "custom",
        "domains": domains,
        "active": false,
        "client_id": "cid",
        "client_secret": "secret",
        "discovery_url": DISCOVERY,
    });
    if let (Some(target), Some(source)) = (body.as_object_mut(), extra.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    body
}

fn self_signed_certificate() -> &'static str {
    static CERT: OnceLock<String> = OnceLock::new();
    CERT.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("orbitid-bapi-cert-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("cert dir");
        let key = dir.join("key.pem");
        let cert = dir.join("cert.pem");
        let status = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "2",
                "-subj",
                "/CN=bapi-test",
                "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .stderr(std::process::Stdio::null())
            .status()
            .expect("openssl");
        assert!(status.success(), "openssl failed");
        std::fs::read_to_string(&cert).expect("certificate")
    })
}

fn metadata_xml(entity_id: &str, sso_url: &str) -> String {
    let certificate: String = self_signed_certificate()
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="{entity_id}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>{certificate}</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="{sso_url}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"#
    )
}

async fn create(harness: &Harness, body: Value) -> (StatusCode, Value) {
    let response = harness.post("/v1/enterprise_connections", body).await;
    (response.status, response.value())
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn gives_each_domain_to_exactly_one_connection() {
    let harness = setup().await;
    assert_eq!(
        create(&harness, oidc_connection(&["acme.test"], json!({})))
            .await
            .0,
        StatusCode::CREATED
    );
    let clash = create(&harness, oidc_connection(&["acme.test"], json!({}))).await;
    assert_eq!(clash.0, StatusCode::CONFLICT);
    assert_eq!(clash.1["errors"][0]["code"], json!("duplicate_record"));
    assert_eq!(
        create(&harness, oidc_connection(&["other.test"], json!({})))
            .await
            .0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn treats_subdomains_as_taken_when_the_owner_allows_them() {
    let harness = setup().await;
    create(
        &harness,
        oidc_connection(&["acme.test"], json!({ "allow_subdomains": true })),
    )
    .await;
    assert_eq!(
        create(&harness, oidc_connection(&["eu.acme.test"], json!({})))
            .await
            .0,
        StatusCode::CONFLICT
    );
    create(&harness, oidc_connection(&["x.beta.test"], json!({}))).await;
    assert_eq!(
        create(
            &harness,
            oidc_connection(&["beta.test"], json!({ "allow_subdomains": true })),
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn applies_the_domain_rule_on_update_and_lets_a_connection_keep_its_own_domains() {
    let harness = setup().await;
    let first = create(&harness, oidc_connection(&["one.test"], json!({})))
        .await
        .1;
    let second = create(&harness, oidc_connection(&["two.test"], json!({})))
        .await
        .1;

    let steal = harness
        .patch(
            &format!("/v1/enterprise_connections/{}", id_of(&second)),
            json!({ "domains": ["one.test"] }),
        )
        .await;
    assert_eq!(steal.status, StatusCode::CONFLICT);
    let keep = harness
        .patch(
            &format!("/v1/enterprise_connections/{}", id_of(&first)),
            json!({ "domains": ["one.test", "uno.test"] }),
        )
        .await;
    assert_eq!(keep.status, StatusCode::OK, "{}", keep.text());
    assert_eq!(keep.value()["domains"], json!(["one.test", "uno.test"]));
}

#[tokio::test]
async fn creates_serializes_updates_and_deletes_saml_connections() {
    let harness = setup().await;
    let certificate = self_signed_certificate().to_string();
    let (status, connection) = create(
        &harness,
        json!({
            "name": "Acme SAML",
            "protocol": "saml",
            "domains": ["acme.com"],
            "active": true,
            "idp_entity_id": "https://idp.example/entity",
            "idp_sso_url": "https://idp.example/sso",
            "idp_certificate": certificate,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{connection}");
    assert_eq!(connection["protocol"], json!("saml"));
    assert_eq!(connection["domains"], json!(["acme.com"]));
    assert_eq!(
        connection["saml"]["idp_entity_id"],
        json!("https://idp.example/entity")
    );
    assert_eq!(
        connection["saml"]["idp_sso_url"],
        json!("https://idp.example/sso")
    );
    assert!(connection["saml"]["idp_certificate"]
        .as_str()
        .unwrap_or_default()
        .contains("BEGIN CERTIFICATE"));
    let id = id_of(&connection);
    assert_eq!(
        connection["saml"]["sp_entity_id"],
        json!(format!("http://localhost:4000/v1/saml/{id}"))
    );
    assert_eq!(
        connection["saml"]["sp_metadata_url"],
        json!(format!("http://localhost:4000/v1/saml/{id}/metadata"))
    );
    assert_eq!(
        connection["saml"]["attribute_mapping"],
        json!({ "email": "email", "first_name": "firstName", "last_name": "lastName", "user_id": "nameID" })
    );

    let list = harness
        .get("/v1/enterprise_connections?protocol=saml&active=true")
        .await;
    assert_eq!(list.value()["total_count"], json!(1));

    let patched = harness
        .patch(
            &format!("/v1/enterprise_connections/{id}"),
            json!({ "domains": ["acme.com", "acme.test"], "active": false, "allow_subdomains": true }),
        )
        .await;
    assert_eq!(patched.status, StatusCode::OK, "{}", patched.text());
    assert_eq!(patched.value()["domains"], json!(["acme.com", "acme.test"]));
    assert_eq!(patched.value()["allow_subdomains"], json!(true));
    assert_eq!(patched.value()["active"], json!(false));

    assert_eq!(
        harness
            .delete(&format!("/v1/enterprise_connections/{id}"))
            .await
            .value()["deleted"],
        json!(true)
    );
    assert_eq!(
        harness
            .get(&format!("/v1/enterprise_connections/{id}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn validates_certificates_domains_and_required_protocol_fields() {
    let harness = setup().await;
    let bad_cert = create(
        &harness,
        json!({
            "name": "x",
            "protocol": "saml",
            "idp_entity_id": "e",
            "idp_sso_url": "https://idp.example/sso",
            "idp_certificate": "not a cert",
        }),
    )
    .await;
    assert_eq!(bad_cert.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(
            &(harness
                .post(
                    "/v1/enterprise_connections",
                    json!({
                        "name": "x",
                        "protocol": "saml",
                        "idp_entity_id": "e",
                        "idp_sso_url": "https://idp.example/sso",
                        "idp_certificate": "not a cert",
                    }),
                )
                .await)
        )
        .as_deref(),
        Some("form_param_format_invalid")
    );

    let missing_saml = create(&harness, json!({ "name": "x", "protocol": "saml" })).await;
    assert_eq!(missing_saml.0, StatusCode::UNPROCESSABLE_ENTITY);
    let missing_oidc = create(&harness, json!({ "name": "x", "protocol": "oidc" })).await;
    assert_eq!(missing_oidc.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        missing_oidc.1["errors"][0]["meta"]["param_name"],
        json!("client_id")
    );

    let bad_domain = create(
        &harness,
        json!({
            "name": "x",
            "protocol": "saml",
            "domains": ["not a domain"],
            "idp_entity_id": "e",
            "idp_sso_url": "https://idp.example/sso",
            "idp_certificate": self_signed_certificate(),
        }),
    )
    .await;
    assert_eq!(bad_domain.0, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn creates_a_saml_connection_from_pasted_metadata() {
    let harness = setup().await;
    let (status, connection) = create(
        &harness,
        json!({
            "name": "Acme from metadata",
            "protocol": "saml",
            "domains": ["metadata.test"],
            "active": true,
            "idp_metadata_xml": metadata_xml("https://metadata.example/entity", "https://metadata.example/sso"),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{connection}");
    assert_eq!(
        connection["saml"]["idp_entity_id"],
        json!("https://metadata.example/entity")
    );
    assert_eq!(
        connection["saml"]["idp_sso_url"],
        json!("https://metadata.example/sso")
    );
    assert!(connection["saml"]["idp_certificate"]
        .as_str()
        .unwrap_or_default()
        .contains("BEGIN CERTIFICATE"));

    let (overridden, connection) = create(
        &harness,
        json!({
            "name": "Acme override",
            "protocol": "saml",
            "domains": ["metadata-override.test"],
            "idp_entity_id": "https://explicit.example/entity",
            "idp_metadata_xml": metadata_xml("https://metadata.example/entity", "https://metadata.example/sso"),
        }),
    )
    .await;
    assert_eq!(overridden, StatusCode::CREATED, "{connection}");
    assert_eq!(
        connection["saml"]["idp_entity_id"],
        json!("https://explicit.example/entity")
    );

    let not_metadata = harness
        .post(
            "/v1/enterprise_connections",
            json!({
                "name": "Not metadata",
                "protocol": "saml",
                "domains": ["not-metadata.test"],
                "idp_metadata_xml": "<html><body>Hello</body></html>",
            }),
        )
        .await;
    assert_eq!(not_metadata.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(not_metadata
        .text()
        .to_ascii_lowercase()
        .contains("does not look like saml"));
}
