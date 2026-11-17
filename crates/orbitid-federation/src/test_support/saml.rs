//! A minimal, real SAML 2.0 identity provider for the federation tests.
//!
//! Responses are signed with `xmlsec` (through `samael`), the same verifier the
//! server uses, so a signature the fixture produces is exactly the shape a real
//! deployment emits. The builder can also leave the assertion unsigned, sign the
//! response envelope only, sign with a different key, or move timestamps, which
//! is what the negative tests need.

use std::collections::BTreeMap;
use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use samael::attribute::{Attribute, AttributeValue};
use samael::crypto::{CertificateDer, Crypto, CryptoProvider, ReduceMode};
use samael::schema::{
    Assertion, AttributeStatement, AudienceRestriction, AuthnStatement, Conditions, Issuer,
    Response, Status, StatusCode, Subject, SubjectConfirmation, SubjectConfirmationData,
    SubjectNameID,
};
use samael::signature::{DigestAlgorithm, Signature};
use samael::traits::ToXml;

use super::keys::TestKeyPair;

/// Which element receives the XML-DSig signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignScope {
    Assertion,
    Response,
    None,
}

/// A `SubjectConfirmation` the fixture should emit. Tests use a list of these
/// to model conflicting timing/recipient confirmations.
#[derive(Debug, Clone)]
pub struct ConfirmationSpec {
    pub method: String,
    pub recipient: Option<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub not_on_or_after: Option<DateTime<Utc>>,
    pub in_response_to: Option<String>,
}

impl ConfirmationSpec {
    /// The normal bearer confirmation for `recipient`, valid until `not_on_or_after`.
    pub fn bearer(recipient: impl Into<String>, not_on_or_after: DateTime<Utc>) -> Self {
        Self {
            method: "urn:oasis:names:tc:SAML:2.0:cm:bearer".to_string(),
            recipient: Some(recipient.into()),
            not_before: None,
            not_on_or_after: Some(not_on_or_after),
            in_response_to: None,
        }
    }
}

/// Description of the response a test wants built.
#[derive(Debug, Clone)]
pub struct AssertionOptions {
    pub sp_entity_id: String,
    pub acs_url: String,
    pub destination: Option<String>,
    pub audience: Option<String>,
    /// Defaults to the email address, like the TypeScript fixture.
    pub name_id: Option<String>,
    pub attributes: BTreeMap<String, Vec<String>>,
    pub sign: SignScope,
    /// Overrides the IdP key pair used to sign this response.
    pub key_pair: Option<TestKeyPair>,
    pub in_response_to: Option<String>,
    pub assertion_id: Option<String>,
    pub response_id: Option<String>,
    pub issue_instant: Option<DateTime<Utc>>,
    pub not_before: Option<DateTime<Utc>>,
    pub not_on_or_after: Option<DateTime<Utc>>,
    pub authn_instant: Option<DateTime<Utc>>,
    pub status_failure: bool,
    /// Replaces the default subject confirmation when set.
    pub subject_confirmations: Option<Vec<ConfirmationSpec>>,
}

impl AssertionOptions {
    /// Defaults matching `samlResponse()` in `test/federation/saml-idp.ts`.
    pub fn new(sp_entity_id: impl Into<String>, acs_url: impl Into<String>) -> Self {
        Self {
            sp_entity_id: sp_entity_id.into(),
            acs_url: acs_url.into(),
            destination: None,
            audience: None,
            name_id: None,
            attributes: BTreeMap::new(),
            sign: SignScope::Assertion,
            key_pair: None,
            in_response_to: None,
            assertion_id: None,
            response_id: None,
            issue_instant: None,
            not_before: None,
            not_on_or_after: None,
            authn_instant: None,
            status_failure: false,
            subject_confirmations: None,
        }
    }
}

fn signature_for(id: &str, certificate_der: &[u8]) -> Signature {
    let mut signature = Signature::template(id, &CertificateDer::from(certificate_der.to_vec()));
    if let Some(reference) = signature.signed_info.reference.first_mut() {
        reference.digest_method.algorithm = DigestAlgorithm::Sha256;
    }
    signature
}

fn attributes_xml(attributes: &BTreeMap<String, Vec<String>>) -> AttributeStatement {
    AttributeStatement {
        attributes: attributes
            .iter()
            .map(|(name, values)| Attribute {
                friendly_name: None,
                name: Some(name.clone()),
                name_format: Some("urn:oasis:names:tc:SAML:2.0:attrname-format:basic".to_string()),
                values: values
                    .iter()
                    .map(|value| AttributeValue {
                        attribute_type: Some("xs:string".to_string()),
                        value: Some(value.clone()),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn build_response(
    idp_entity_id: &str,
    key_pair: &TestKeyPair,
    options: &AssertionOptions,
) -> Result<Response, String> {
    let now = options.issue_instant.unwrap_or_else(Utc::now);
    let not_before = options
        .not_before
        .unwrap_or_else(|| now - Duration::seconds(60));
    let not_on_or_after = options
        .not_on_or_after
        .unwrap_or_else(|| now + Duration::seconds(300));
    let name_id = options
        .name_id
        .clone()
        .unwrap_or_else(|| "ada@acme.test".to_string());
    let assertion_id = options
        .assertion_id
        .clone()
        .unwrap_or_else(|| format!("_a{}", orbitid_core::crypto::random_token(12)));
    let response_id = options
        .response_id
        .clone()
        .unwrap_or_else(|| format!("_r{}", orbitid_core::crypto::random_token(12)));
    let audience = options
        .audience
        .clone()
        .unwrap_or_else(|| options.sp_entity_id.clone());
    let mut attributes = options.attributes.clone();
    if attributes.is_empty() {
        attributes.insert("email".to_string(), vec![name_id.clone()]);
        attributes.insert("firstName".to_string(), vec!["Ada".to_string()]);
        attributes.insert("lastName".to_string(), vec!["Lovelace".to_string()]);
    }
    let assertion_signature = (options.sign == SignScope::Assertion)
        .then(|| signature_for(&assertion_id, &key_pair.certificate_der));
    let response_signature = (options.sign == SignScope::Response)
        .then(|| signature_for(&response_id, &key_pair.certificate_der));
    let assertion = Assertion {
        id: assertion_id,
        issue_instant: now,
        version: "2.0".to_string(),
        issuer: Issuer {
            value: Some(idp_entity_id.to_string()),
            ..Issuer::default()
        },
        signature: assertion_signature,
        subject: Some(Subject {
            name_id: Some(SubjectNameID {
                format: Some("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress".to_string()),
                value: name_id,
            }),
            subject_confirmations: Some(match &options.subject_confirmations {
                Some(specs) => specs
                    .iter()
                    .map(|spec| SubjectConfirmation {
                        method: Some(spec.method.clone()),
                        name_id: None,
                        subject_confirmation_data: Some(SubjectConfirmationData {
                            not_before: spec.not_before,
                            not_on_or_after: spec.not_on_or_after,
                            recipient: spec.recipient.clone(),
                            in_response_to: spec.in_response_to.clone(),
                            address: None,
                            content: None,
                        }),
                    })
                    .collect(),
                None => vec![SubjectConfirmation {
                    method: Some("urn:oasis:names:tc:SAML:2.0:cm:bearer".to_string()),
                    name_id: None,
                    subject_confirmation_data: Some(SubjectConfirmationData {
                        not_before: None,
                        not_on_or_after: Some(not_on_or_after),
                        recipient: Some(options.acs_url.clone()),
                        in_response_to: options.in_response_to.clone(),
                        address: None,
                        content: None,
                    }),
                }],
            }),
        }),
        conditions: Some(Conditions {
            not_before: Some(not_before),
            not_on_or_after: Some(not_on_or_after),
            audience_restrictions: Some(vec![AudienceRestriction {
                audience: vec![audience],
            }]),
            one_time_use: None,
            proxy_restriction: None,
        }),
        authn_statements: Some(vec![AuthnStatement {
            authn_instant: Some(options.authn_instant.unwrap_or(now)),
            session_index: Some(format!("_session{}", orbitid_core::crypto::random_token(4))),
            session_not_on_or_after: None,
            subject_locality: None,
            authn_context: None,
        }]),
        attribute_statements: Some(vec![attributes_xml(&attributes)]),
    };
    Ok(Response {
        id: response_id,
        in_response_to: options.in_response_to.clone(),
        version: "2.0".to_string(),
        issue_instant: now,
        destination: Some(
            options
                .destination
                .clone()
                .unwrap_or_else(|| options.acs_url.clone()),
        ),
        consent: None,
        issuer: Some(Issuer {
            value: Some(idp_entity_id.to_string()),
            ..Issuer::default()
        }),
        signature: response_signature,
        status: Some(Status {
            status_code: StatusCode {
                value: Some(if options.status_failure {
                    "urn:oasis:names:tc:SAML:2.0:status:Requester".to_string()
                } else {
                    "urn:oasis:names:tc:SAML:2.0:status:Success".to_string()
                }),
            },
            status_message: None,
            status_detail: None,
        }),
        encrypted_assertion: None,
        assertion: Some(assertion),
    })
}

/// Builds (and, when requested, signs) the response XML.
pub fn response_xml(
    idp_entity_id: &str,
    key_pair: &TestKeyPair,
    options: &AssertionOptions,
) -> Result<String, String> {
    let response = build_response(idp_entity_id, key_pair, options)?;
    let xml = response.to_string().map_err(|error| error.to_string())?;
    if options.sign == SignScope::None {
        return Ok(xml);
    }
    let signer = options.key_pair.as_ref().unwrap_or(key_pair);
    Crypto::sign_xml(&xml, &signer.private_key_der).map_err(|error| error.to_string())
}

/// The base64 body a browser would post to the ACS.
pub fn response_base64(
    idp_entity_id: &str,
    key_pair: &TestKeyPair,
    options: &AssertionOptions,
) -> Result<String, String> {
    let xml = response_xml(idp_entity_id, key_pair, options)?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        xml,
    ))
}

/// The parsed shape of a deflated HTTP-Redirect AuthnRequest.
#[derive(Debug, Clone, Default)]
pub struct CompletedAuthnRequest {
    pub id: String,
    pub acs_url: String,
    pub issuer: String,
    pub destination: Option<String>,
    pub issued_at: Option<String>,
    pub relay_state: Option<String>,
}

/// Parses the `SAMLRequest` parameter of a redirect-binding AuthnRequest.
pub fn parse_authn_request(saml_request: &str) -> Result<CompletedAuthnRequest, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, saml_request)
        .map_err(|error| error.to_string())?;
    let mut decoder = flate2::read::DeflateDecoder::new(bytes.as_slice());
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut decoder, &mut xml).map_err(|error| error.to_string())?;
    let request =
        samael::schema::AuthnRequest::from_str(&xml).map_err(|error| error.to_string())?;
    let issuer = request.issuer_value().unwrap_or_default();
    Ok(CompletedAuthnRequest {
        id: request.id,
        acs_url: request
            .assertion_consumer_service_url
            .clone()
            .unwrap_or_default(),
        issuer,
        destination: request.destination,
        issued_at: Some(request.issue_instant.to_rfc3339()),
        relay_state: None,
    })
}

/// Verifies a fixture against a certificate with the same xmlsec path the SP uses.
/// Exposed so tests can prove the signing helper produces real signatures.
pub fn verify_fixture(xml: &str, certificate_der: &[u8]) -> Result<String, String> {
    Crypto::reduce_xml_to_signed(
        xml,
        &[CertificateDer::from(certificate_der.to_vec())],
        ReduceMode::PreDigest,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::keys::make_key_pair;

    #[test]
    fn signed_assertion_verifies_and_reduces_to_the_assertion() {
        let pair = make_key_pair("idp").expect("key");
        let options = AssertionOptions::new("https://sp.example", "https://sp.example/acs");
        let xml = response_xml("https://idp.example/metadata", &pair, &options).expect("response");
        let reduced = verify_fixture(&xml, &pair.certificate_der).expect("verify");
        assert!(reduced.contains("_a") || reduced.contains("Assertion"));
        assert!(Assertion::from_str(&reduced).is_ok(), "reduced: {reduced}");
    }

    #[test]
    fn unsigned_response_has_no_signature() {
        let pair = make_key_pair("idp").expect("key");
        let mut options = AssertionOptions::new("https://sp", "https://sp/acs");
        options.sign = SignScope::None;
        let xml = response_xml("https://idp", &pair, &options).expect("response");
        assert!(!xml.contains("<ds:Signature"));
        assert!(verify_fixture(&xml, &pair.certificate_der).is_err());
    }

    #[test]
    fn response_only_signature_verifies() {
        let pair = make_key_pair("idp").expect("key");
        let mut options = AssertionOptions::new("https://sp", "https://sp/acs");
        options.sign = SignScope::Response;
        let xml = response_xml("https://idp", &pair, &options).expect("response");
        let reduced = verify_fixture(&xml, &pair.certificate_der).expect("verify");
        assert!(Response::from_str(&reduced).is_ok(), "reduced: {reduced}");
    }

    #[test]
    fn authn_request_round_trips_through_the_redirect_encoding() {
        let xml = crate::saml::sp::authn_request_xml(
            "https://sp",
            "https://sp/acs",
            "https://idp/sso",
            "_req1",
            "2026-01-01T00:00:00.000Z",
        );
        let encoded = crate::saml::sp::encode_redirect_request(&xml).expect("encode");
        let parsed = parse_authn_request(&encoded).expect("parse");
        assert_eq!(parsed.id, "_req1");
        assert_eq!(parsed.acs_url, "https://sp/acs");
        assert_eq!(parsed.issuer, "https://sp");
    }
}
