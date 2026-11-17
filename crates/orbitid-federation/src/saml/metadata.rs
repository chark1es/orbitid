//! SAML identity-provider metadata import.
//!
//! Ported from the retired TypeScript server: operators paste
//! metadata XML or give a URL, and the entity id, SSO endpoint and signing
//! certificate are read from it. Both paths go through the SSRF guard.

use orbitid_core::safe_fetch::{assert_public_url, safe_fetch, SafeFetchOptions};
use orbitid_core::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::invalid_param;

/// What a metadata document contributes to a connection.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdpMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sso_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate: Option<String>,
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn attr(xml: &str, tag: &str, name: &str) -> Option<String> {
    let element_pattern = Regex::new(&format!(r"<[^>]*{tag}\b[^>]*>")).ok()?;
    let element = element_pattern.find(xml)?.as_str();
    let attribute_pattern = Regex::new(&format!(r#"{name}\s*=\s*("([^"]*)"|'([^']*)')"#)).ok()?;
    let captures = attribute_pattern.captures(element)?;
    captures
        .get(2)
        .or_else(|| captures.get(3))
        .map(|value| value.as_str().to_string())
}

/// The Redirect binding is what OrbitID sends, so it is preferred.
fn single_sign_on_url(xml: &str) -> Option<String> {
    let pattern = Regex::new(r"(?i)<[^>]*SingleSignOnService\b[^>]*>").ok()?;
    let services: Vec<&str> = pattern.find_iter(xml).map(|found| found.as_str()).collect();
    let chosen = services
        .iter()
        .find(|element| {
            attr(element, "SingleSignOnService", "Binding")
                .is_some_and(|binding| binding.to_ascii_lowercase().contains("http-redirect"))
        })
        .or_else(|| services.first())?;
    attr(chosen, "SingleSignOnService", "Location")
}

fn signing_certificate(xml: &str) -> Option<String> {
    let descriptor =
        Regex::new(r#"(?is)<[^>]*KeyDescriptor\b[^>]*use\s*=\s*["']signing["'][^>]*>(.*?)</[^>]*KeyDescriptor>"#)
            .ok()?;
    let certificate =
        Regex::new(r"(?is)<(?:\w+:)?X509Certificate>(.*?)</(?:\w+:)?X509Certificate>").ok()?;
    let signing_block = descriptor
        .captures(xml)
        .and_then(|captures| captures.get(1).map(|block| block.as_str()));
    let raw = signing_block
        .and_then(|block| certificate.captures(block))
        .or_else(|| certificate.captures(xml))
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().replace(char::is_whitespace, ""))?;
    if raw.is_empty() {
        return None;
    }
    let lines: Vec<&str> = raw
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect();
    Some(format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        lines.join("\n")
    ))
}

/// Parses an IdP metadata document. Only what it finds is returned; the caller
/// decides what is still required.
pub fn parse_idp_metadata(xml: &str) -> Result<IdpMetadata, orbitid_core::OrbitError> {
    if xml.trim().is_empty() {
        return Err(invalid_param(
            "idp_metadata_xml",
            "The SAML metadata document is empty",
        ));
    }
    let entity_id = attr(xml, "EntityDescriptor", "entityID")
        .or_else(|| attr(xml, "EntitiesDescriptor", "entityID"));
    let sso_url = single_sign_on_url(xml);
    let certificate = signing_certificate(xml);
    if entity_id.is_none() && sso_url.is_none() && certificate.is_none() {
        return Err(invalid_param(
            "idp_metadata_xml",
            "That document does not look like SAML identity-provider metadata: no entity id, SSO URL or signing certificate was found",
        ));
    }
    Ok(IdpMetadata {
        entity_id: entity_id.map(|value| decode_xml_entities(&value)),
        sso_url: sso_url.map(|value| decode_xml_entities(&value)),
        certificate,
    })
}

/// Fetches metadata from an operator URL through the SSRF guard and parses it.
pub async fn fetch_idp_metadata(
    state: &AppState,
    url: &str,
) -> Result<IdpMetadata, orbitid_core::OrbitError> {
    assert_public_url(Some(state), url, "idp_metadata_url").await?;
    let response = safe_fetch(
        Some(state),
        url,
        SafeFetchOptions {
            timeout_ms: Some(10_000),
            max_bytes: Some(512 * 1024),
            headers: orbitid_core::safe_fetch::headers(&[(
                "accept",
                "application/xml, text/xml, */*",
            )]),
            ..SafeFetchOptions::default()
        },
    )
    .await
    .map_err(|error| {
        if error.code == orbitid_core::error::error_codes::FORM_PARAM_FORMAT_INVALID {
            error
        } else {
            invalid_param(
                "idp_metadata_url",
                format!("Could not fetch the metadata URL: {}", error.message),
            )
        }
    })?;
    if !response.ok() {
        return Err(invalid_param(
            "idp_metadata_url",
            format!("Metadata request failed ({})", response.status),
        ));
    }
    parse_idp_metadata(&response.body)
}

/// Resolves metadata inputs into connection fields. Explicit form fields win.
pub async fn resolve_saml_metadata(
    state: &AppState,
    metadata_url: Option<&str>,
    metadata_xml: Option<&str>,
) -> Result<IdpMetadata, orbitid_core::OrbitError> {
    let url = metadata_url
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let xml = metadata_xml
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if url.is_none() && xml.is_none() {
        return Ok(IdpMetadata::default());
    }
    match url {
        Some(url) => fetch_idp_metadata(state, url).await,
        None => parse_idp_metadata(xml.unwrap_or("")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const METADATA: &str = r#"<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.acme.test/metadata">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIID</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp/redirect?a=1&amp;b=2"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"#;

    #[test]
    fn parses_entity_sso_and_certificate() {
        let parsed = parse_idp_metadata(METADATA).expect("metadata");
        assert_eq!(
            parsed.entity_id.as_deref(),
            Some("https://idp.acme.test/metadata")
        );
        assert_eq!(
            parsed.sso_url.as_deref(),
            Some("https://idp/redirect?a=1&b=2")
        );
        let cert = parsed.certificate.expect("cert");
        assert!(cert.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(cert.contains("MIID"));
        assert!(cert.ends_with("-----END CERTIFICATE-----\n"));
    }

    #[test]
    fn rejects_non_metadata_documents() {
        let error = parse_idp_metadata("<html><body>Hello</body></html>").unwrap_err();
        assert_eq!(error.code, "form_param_format_invalid");
        assert!(error.message.contains("does not look like SAML"));
    }

    #[test]
    fn rejects_empty_documents() {
        assert!(parse_idp_metadata("   ")
            .unwrap_err()
            .message
            .contains("empty"));
    }

    #[test]
    fn falls_back_to_the_first_sso_service_when_no_redirect_binding() {
        let xml = r#"<EntityDescriptor entityID="x"><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp/post"/></EntityDescriptor>"#;
        assert_eq!(
            parse_idp_metadata(xml).unwrap().sso_url.as_deref(),
            Some("https://idp/post")
        );
    }

    #[test]
    fn certificate_wrapping_pads_to_64_columns() {
        let long = "A".repeat(130);
        let xml = format!("<EntityDescriptor entityID=\"x\"><KeyDescriptor use=\"signing\"><X509Certificate>   {long} </X509Certificate></KeyDescriptor></EntityDescriptor>");
        let cert = parse_idp_metadata(&xml).unwrap().certificate.unwrap();
        let body = cert
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<Vec<_>>();
        assert_eq!(body[0].len(), 64);
        assert_eq!(body[1].len(), 64);
        assert_eq!(body[2].len(), 2);
    }
}
