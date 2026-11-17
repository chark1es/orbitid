//! Structural XML scanning for SAML responses.
//!
//! `xmlsec` proves *which* bytes were signed; this scan proves *which element*
//! the signature covers and rejects ambiguous documents before verification.
//! Speed and nesting are bounded by the caller's 512 KiB body limit.

use quick_xml::events::Event;
use quick_xml::Reader;

/// One `ds:Signature` occurrence and the element that contains it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureInfo {
    /// Local name of the parent element (`Response`, `Assertion`, …).
    pub parent: String,
    /// The `Reference/@URI` the signature covers.
    pub reference_uri: Option<String>,
}

/// Facts read without trusting them; every use is a rejection.
#[derive(Debug, Clone, Default)]
pub struct XmlScan {
    pub root_local: String,
    pub root_id: Option<String>,
    pub destination: Option<String>,
    pub in_response_to: Option<String>,
    pub status_code: Option<String>,
    pub assertion_ids: Vec<String>,
    pub assertion_count: usize,
    pub encrypted_assertion_count: usize,
    pub recipients: Vec<String>,
    pub signatures: Vec<SignatureInfo>,
    /// Every `ID` attribute value in document order (duplicates are ambiguous).
    pub ids: Vec<String>,
}

/// Rejects DTDs, reads the structural facts of a SAML response.
pub fn scan(xml: &str) -> Result<XmlScan, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().check_end_names = true;
    let mut stack: Vec<String> = Vec::new();
    let mut scan = XmlScan::default();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let local = String::from_utf8_lossy(event.local_name().as_ref()).into_owned();
                handle_element(&mut scan, &stack, &event, &local)?;
                stack.push(local);
            }
            Ok(Event::Empty(event)) => {
                let local = String::from_utf8_lossy(event.local_name().as_ref()).into_owned();
                handle_element(&mut scan, &stack, &event, &local)?;
            }
            Ok(Event::End(_)) => {
                stack.pop();
            }
            Ok(Event::DocType(_)) => return Err("DTDs are not allowed in SAML responses".into()),
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("invalid XML: {error}")),
            _ => {}
        }
    }
    if scan.root_local.is_empty() {
        return Err("the SAML response has no root element".into());
    }
    Ok(scan)
}

fn handle_element(
    scan: &mut XmlScan,
    stack: &[String],
    event: &quick_xml::events::BytesStart<'_>,
    local: &str,
) -> Result<(), String> {
    if stack.is_empty() {
        scan.root_local = local.to_string();
    }
    let parent = stack.last().cloned().unwrap_or_default();
    let attr = |name: &str| -> Option<String> {
        event
            .attributes()
            .flatten()
            .find(|candidate| candidate.key.local_name().as_ref() == name.as_bytes())
            .and_then(|candidate| {
                candidate
                    .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .ok()
            })
            .map(|value| value.into_owned())
    };
    if local == "Signature" && parent != "Signature" {
        scan.signatures.push(SignatureInfo {
            parent: parent.clone(),
            reference_uri: None,
        });
    }
    if local == "Reference" {
        if let Some(signature) = scan.signatures.last_mut() {
            signature.reference_uri = attr("URI");
        }
    }
    match local {
        "Response" => {
            let id = attr("ID");
            if let Some(id) = &id {
                scan.ids.push(id.clone());
            }
            scan.root_id = id;
            scan.destination = attr("Destination");
            scan.in_response_to = attr("InResponseTo");
        }
        "Assertion" => {
            scan.assertion_count += 1;
            if let Some(id) = attr("ID") {
                scan.ids.push(id.clone());
                scan.assertion_ids.push(id);
            }
        }
        "EncryptedAssertion" => scan.encrypted_assertion_count += 1,
        "StatusCode" => {
            if scan.status_code.is_none() {
                scan.status_code = attr("Value");
            }
        }
        "SubjectConfirmationData" => {
            if let Some(recipient) = attr("Recipient") {
                scan.recipients.push(recipient);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Compares URLs the way the validator does (`new URL(...).href`), falling back
/// to a literal comparison.
pub fn same_url(received: &str, expected: &str) -> bool {
    match (url::Url::parse(received), url::Url::parse(expected)) {
        (Ok(received), Ok(expected)) => received == expected,
        _ => received == expected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESPONSE: &str = r##"<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1" Destination="https://sp/acs">
  <saml:Issuer>https://idp</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_a1" Version="2.0">
    <saml:Issuer>https://idp</saml:Issuer>
    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:Reference URI="#_a1"/></ds:Signature>
    <saml:Subject><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData Recipient="https://sp/acs"/></saml:SubjectConfirmation></saml:Subject>
  </saml:Assertion>
</samlp:Response>"##;

    #[test]
    fn scans_signature_scope_and_targets() {
        let scan = scan(RESPONSE).expect("scan");
        assert_eq!(scan.root_local, "Response");
        assert_eq!(scan.root_id.as_deref(), Some("_r1"));
        assert_eq!(scan.destination.as_deref(), Some("https://sp/acs"));
        assert_eq!(scan.assertion_count, 1);
        assert_eq!(scan.assertion_ids, vec!["_a1"]);
        assert_eq!(scan.recipients, vec!["https://sp/acs"]);
        assert_eq!(
            scan.status_code.as_deref(),
            Some("urn:oasis:names:tc:SAML:2.0:status:Success")
        );
        assert_eq!(
            scan.signatures,
            vec![SignatureInfo {
                parent: "Assertion".into(),
                reference_uri: Some("#_a1".into())
            }]
        );
    }

    #[test]
    fn refuses_doctypes() {
        assert!(scan("<!DOCTYPE x [<!ENTITY a 'b'>]><x/>").is_err());
    }

    #[test]
    fn url_comparison_normalizes_host_case() {
        assert!(same_url("https://SP.example/acs", "https://sp.example/acs"));
        assert!(!same_url(
            "https://sp.example/other",
            "https://sp.example/acs"
        ));
        assert!(same_url("not a url", "not a url"));
    }
}
