//! SAML service-provider side: AuthnRequest generation (HTTP-Redirect binding)
//! and SP metadata.

use std::io::Write;

use base64::Engine;
use chrono::Utc;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use orbitid_core::models::EnterpriseConnectionRow;
use url::Url;

use crate::error::callback_invalid;
use crate::saml::config::{acs_url_for, saml_config, sp_entity_id_for};
use crate::saml::store::SamlCache;

/// Request IDs must be remembered for this long so a response can answer one.
pub use crate::saml::store::SAML_CACHE_TTL_MS as REQUEST_ID_EXPIRATION_MS;

/// Whether an `InResponseTo` must be checked against a request we issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidateInResponseTo {
    /// IdP-initiated logins are allowed: an absent `InResponseTo` is fine, a
    /// present one must still name a request we issued.
    IfPresent,
    /// Every response must answer a request we issued (the TS default).
    Always,
}

impl ValidateInResponseTo {
    /// Whether a response with (or without) `InResponseTo` is validated.
    pub fn applies(self, has_in_response_to: bool) -> bool {
        match self {
            Self::Always => true,
            Self::IfPresent => has_in_response_to,
        }
    }
}

/// The InResponseTo policy a connection asks for.
pub fn validate_in_response_to(conn: &EnterpriseConnectionRow) -> ValidateInResponseTo {
    if conn.allow_idp_initiated {
        ValidateInResponseTo::IfPresent
    } else {
        ValidateInResponseTo::Always
    }
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

fn new_request_id() -> String {
    format!("_{}", orbitid_core::crypto::random_token(16))
}

/// The SP EntityDescriptor an operator hands to the IdP.
pub fn service_provider_metadata(base_url: &str, connection_id: &str) -> String {
    let entity_id = sp_entity_id_for(base_url, connection_id);
    let acs = acs_url_for(base_url, connection_id);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <md:EntityDescriptor xmlns:md=\"urn:oasis:names:tc:SAML:2.0:metadata\" entityID=\"{entity}\">\n\
         \x20 <md:SPSSODescriptor AuthnRequestsSigned=\"false\" WantAssertionsSigned=\"true\" protocolSupportEnumeration=\"urn:oasis:names:tc:SAML:2.0:protocol\">\n\
         \x20   <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\n\
         \x20   <md:AssertionConsumerService Binding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\" Location=\"{acs}\" index=\"0\"/>\n\
         \x20 </md:SPSSODescriptor>\n\
         </md:EntityDescriptor>\n",
        entity = escape(&entity_id),
        acs = escape(&acs),
    )
}

/// Builds the AuthnRequest XML (uncompressed).
pub fn authn_request_xml(
    sp_entity_id: &str,
    acs_url: &str,
    destination: &str,
    request_id: &str,
    issue_instant: &str,
) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <samlp:AuthnRequest xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" \
         xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" \
         ID=\"{id}\" Version=\"2.0\" IssueInstant=\"{instant}\" \
         ProtocolBinding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\" \
         Destination=\"{destination}\" AssertionConsumerServiceURL=\"{acs}\">\
         <saml:Issuer>{issuer}</saml:Issuer>\
         <samlp:NameIDPolicy Format=\"urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress\" AllowCreate=\"true\"/>\
         </samlp:AuthnRequest>",
        id = escape(request_id),
        instant = escape(issue_instant),
        destination = escape(destination),
        acs = escape(acs_url),
        issuer = escape(sp_entity_id),
    )
}

fn deflate_raw(xml: &str) -> Result<Vec<u8>, orbitid_core::OrbitError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(xml.as_bytes())
        .map_err(|_| callback_invalid("Could not encode the SAML request"))?;
    encoder
        .finish()
        .map_err(|_| callback_invalid("Could not encode the SAML request"))
}

/// The deflated, base64 SAMLRequest parameter.
pub fn encode_redirect_request(xml: &str) -> Result<String, orbitid_core::OrbitError> {
    Ok(base64::engine::general_purpose::STANDARD.encode(deflate_raw(xml)?))
}

/// A generated AuthnRequest: the browser URL and the ID to expect back.
#[derive(Debug, Clone)]
pub struct GeneratedAuthnRequest {
    pub url: String,
    pub request_id: String,
}

/// Builds the IdP redirect URL and remembers the request ID in Postgres.
pub async fn saml_authorize_url(
    cache: &SamlCache,
    base_url: &str,
    conn: &EnterpriseConnectionRow,
    relay_state: &str,
) -> Result<GeneratedAuthnRequest, orbitid_core::OrbitError> {
    let cfg = saml_config(conn)?;
    let sp_entity_id = sp_entity_id_for(base_url, &conn.id);
    let acs_url = acs_url_for(base_url, &conn.id);
    let request_id = new_request_id();
    let instant = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let xml = authn_request_xml(
        &sp_entity_id,
        &acs_url,
        &cfg.idp_sso_url,
        &request_id,
        &instant,
    );
    let encoded = encode_redirect_request(&xml)?;

    if validate_in_response_to(conn).applies(true) {
        cache.save(&request_id, &instant).await?;
    }

    let mut url = Url::parse(&cfg.idp_sso_url)
        .map_err(|_| callback_invalid("The IdP SSO URL is not a valid URL"))?;
    url.query_pairs_mut()
        .append_pair("SAMLRequest", &encoded)
        .append_pair("RelayState", relay_state);
    Ok(GeneratedAuthnRequest {
        url: url.to_string(),
        request_id,
    })
}

/// Is the SP's own issuer/ACS configuration complete?
pub fn sp_configuration_ok(conn: &EnterpriseConnectionRow, base_url: &str) -> bool {
    saml_config(conn).is_ok() && !sp_entity_id_for(base_url, &conn.id).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authn_request_carries_the_required_shape() {
        let xml = authn_request_xml(
            "https://sp.example/v1/saml/ent_1",
            "https://sp.example/v1/saml/ent_1/acs",
            "https://idp.example/sso",
            "_req1",
            "2026-01-01T00:00:00.000Z",
        );
        assert!(xml.contains("ID=\"_req1\""));
        assert!(xml.contains("Destination=\"https://idp.example/sso\""));
        assert!(
            xml.contains("AssertionConsumerServiceURL=\"https://sp.example/v1/saml/ent_1/acs\"")
        );
        assert!(xml.contains("<saml:Issuer>https://sp.example/v1/saml/ent_1</saml:Issuer>"));
        assert!(xml.contains("AllowCreate=\"true\""));
        assert!(xml.contains("ProtocolBinding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\""));
    }

    #[test]
    fn metadata_names_the_acs_and_entity() {
        let metadata = service_provider_metadata("https://sp.example", "ent_1");
        assert!(metadata.contains("entityID=\"https://sp.example/v1/saml/ent_1\""));
        assert!(metadata.contains("Location=\"https://sp.example/v1/saml/ent_1/acs\""));
        assert!(metadata.contains("WantAssertionsSigned=\"true\""));
        assert!(metadata.contains("HTTP-POST"));
    }

    #[test]
    fn redirect_encoding_is_raw_deflate_then_base64() {
        let xml = "<x>hello</x>";
        let encoded = encode_redirect_request(xml).expect("encode");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("base64");
        // Raw deflate has no zlib header; inflateRaw recovers the document.
        let mut decoder = flate2::read::DeflateDecoder::new(bytes.as_slice());
        let mut out = String::new();
        std::io::Read::read_to_string(&mut decoder, &mut out).expect("inflate");
        assert_eq!(out, xml);
    }

    #[test]
    fn in_response_to_policy_follows_allow_idp_initiated() {
        assert!(ValidateInResponseTo::Always.applies(false));
        assert!(!ValidateInResponseTo::IfPresent.applies(false));
        assert!(ValidateInResponseTo::IfPresent.applies(true));
    }
}
