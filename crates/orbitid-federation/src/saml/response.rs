//! SAML assertion validation.
//!
//! This is the security-critical half of the retired TypeScript server.
//! `@node-saml/node-saml` is replaced by `xmlsec` (through `samael`) for XML-DSig
//! with exclusive canonicalisation, plus explicit structural checks that make
//! signature wrapping impossible: the document must contain exactly one
//! assertion, the assertion itself must be signed (not merely its envelope), and
//! the data consumed is parsed from the xmlsec-verified bytes.

use std::str::FromStr;

use chrono::Duration;
use orbitid_core::models::EnterpriseConnectionRow;
use samael::crypto::{
    AllowedSignatureAlgorithm, CertificateDer, Crypto, CryptoProvider, ReduceMode,
};
use samael::schema::{Assertion, Response};

use crate::error::verification_failed;
use crate::saml::checks::{
    audience_ok, fail, max_time_limit, now, subject_confirmation, timestamps_ok,
    ASSERTION_MAX_AGE_MS, CLOCK_SKEW_MS,
};
use crate::saml::config::{acs_url_for, certificate_der, saml_config, sp_entity_id_for};
use crate::saml::profile::{profile_from_assertion, SamlProfile};
use crate::saml::sp::{validate_in_response_to, ValidateInResponseTo};
use crate::saml::store::SamlCache;
use crate::saml::xml::{same_url, scan, SignatureInfo, XmlScan};

const SUCCESS_STATUS: &str = "urn:oasis:names:tc:SAML:2.0:status:Success";

fn decode_base64(value: &str) -> Result<String, orbitid_core::OrbitError> {
    let compact: String = value.chars().filter(|ch| !ch.is_whitespace()).collect();
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, compact)
        .map_err(|_| fail("the SAMLResponse is not base64"))?;
    String::from_utf8(bytes).map_err(|_| fail("the SAMLResponse is not UTF-8"))
}

/// Reject-only facts read from the still-unverified document.
///
/// Status and Destination are compared the way node-saml does, and a mismatch
/// is fatal. They can only *reject*: a matching `Destination` is never trusted,
/// because the `Response` envelope is often unsigned and an attacker can put
/// any value there. Binding to this SP comes from the signature-verified
/// audience, the verified `Recipient` checked in [`subject_confirmation`], and
/// `InResponseTo` taken from the verified assertion (or a signed Response).
///
/// `Recipient` is deliberately not scanned here any more: it must be read from
/// the one bearer confirmation inside the signature-verified assertion.
fn assert_response_target(xml: &str, acs_url: &str) -> Result<XmlScan, orbitid_core::OrbitError> {
    let scan = scan(xml).map_err(fail)?;
    if let Some(status) = &scan.status_code {
        if status != SUCCESS_STATUS {
            let tail = status.rsplit(':').next().unwrap_or(status);
            return Err(fail(format!("the identity provider reported {tail}")));
        }
    }
    if let Some(destination) = &scan.destination {
        if !same_url(destination, acs_url) {
            return Err(fail(
                "the response is addressed to another assertion consumer service",
            ));
        }
    }
    Ok(scan)
}

fn allowed_algorithms() -> Vec<AllowedSignatureAlgorithm> {
    vec![
        AllowedSignatureAlgorithm::RsaSha256,
        AllowedSignatureAlgorithm::RsaSha384,
        AllowedSignatureAlgorithm::RsaSha512,
        AllowedSignatureAlgorithm::EcdsaSha256,
        AllowedSignatureAlgorithm::EcdsaSha384,
        AllowedSignatureAlgorithm::EcdsaSha512,
    ]
}

fn assertion_signing_uri(assertion_id: &str) -> String {
    format!("#{assertion_id}")
}

/// True when a signature covers the assertion itself.
fn assertion_is_signed(signatures: &[SignatureInfo], assertion_id: &str) -> bool {
    let expected = assertion_signing_uri(assertion_id);
    signatures.iter().any(|signature| {
        signature.parent == "Assertion"
            && signature.reference_uri.as_deref() == Some(expected.as_str())
    })
}

fn response_is_signed(signatures: &[SignatureInfo], response_id: &str) -> bool {
    let expected = assertion_signing_uri(response_id);
    signatures.iter().any(|signature| {
        signature.parent == "Response"
            && signature.reference_uri.as_deref() == Some(expected.as_str())
    })
}

fn structural_checks(scan: &XmlScan) -> Result<(String, bool), orbitid_core::OrbitError> {
    if scan.root_local != "Response" {
        return Err(fail("the SAML response has an unexpected root element"));
    }
    if scan.encrypted_assertion_count > 0 {
        return Err(fail("encrypted assertions are not supported"));
    }
    if scan.assertion_count != 1 || scan.assertion_ids.len() != 1 {
        return Err(fail("the response must contain exactly one assertion"));
    }
    let mut ids = scan.ids.clone();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != scan.ids.len() {
        return Err(fail("the response reuses an XML ID"));
    }
    let assertion_id = scan.assertion_ids[0].clone();
    if !assertion_is_signed(&scan.signatures, &assertion_id) {
        return Err(fail("the assertion itself is not signed"));
    }
    let root_id = scan
        .root_id
        .clone()
        .ok_or_else(|| fail("the response has no ID"))?;
    // Every signature in the document must cover either the response or the assertion.
    for signature in &scan.signatures {
        let covered = signature.reference_uri.as_deref().is_some_and(|uri| {
            uri == assertion_signing_uri(&assertion_id) || uri == assertion_signing_uri(&root_id)
        });
        if !covered {
            return Err(fail(
                "the response contains a signature over an unexpected element",
            ));
        }
    }
    Ok((assertion_id, response_is_signed(&scan.signatures, &root_id)))
}

/// Verifies all XML signatures on the blocking pool and returns the verified
/// document bytes.
async fn verify_signatures(
    xml: &str,
    certificate_pem: &str,
) -> Result<String, orbitid_core::OrbitError> {
    let xml = xml.to_string();
    let certificate_pem = certificate_pem.to_string();
    tokio::task::spawn_blocking(move || {
        let der = certificate_der(&certificate_pem)?;
        let algorithms = allowed_algorithms();
        Crypto::reduce_xml_to_signed_with_allowed_algorithms(
            &xml,
            &[CertificateDer::from(der)],
            ReduceMode::PreDigest,
            Some(&algorithms),
        )
        .map_err(|_| fail("the signature could not be verified"))
    })
    .await
    .map_err(|_| fail("the signature could not be verified"))?
}

fn parse_verified(
    reduced: &str,
    assertion_id: &str,
) -> Result<(Option<Response>, Assertion), orbitid_core::OrbitError> {
    let scan = scan(reduced).map_err(fail)?;
    if scan.root_local == "Assertion" {
        let assertion = Assertion::from_str(reduced)
            .map_err(|_| fail("the verified assertion could not be parsed"))?;
        if assertion.id != assertion_id {
            return Err(fail(
                "the verified assertion does not match the signed element",
            ));
        }
        return Ok((None, assertion));
    }
    if scan.root_local != "Response" {
        return Err(fail("the verified document has an unexpected root element"));
    }
    let response = Response::from_str(reduced)
        .map_err(|_| fail("the verified response could not be parsed"))?;
    let assertion = response
        .assertion
        .clone()
        .ok_or_else(|| fail("the verified response contains no assertion"))?;
    if assertion.id != assertion_id {
        return Err(fail(
            "the verified assertion does not match the signed element",
        ));
    }
    Ok((Some(response), assertion))
}

fn assertion_accepted_until(
    assertion: &Assertion,
    confirmation: &samael::schema::SubjectConfirmationData,
) -> Option<i64> {
    let conditions_limit = assertion
        .conditions
        .as_ref()
        .and_then(|conditions| conditions.not_on_or_after)
        .map(|limit| limit.min(max_time_limit(assertion.issue_instant)))?;
    let mut limit = conditions_limit;
    if let Some(confirmation_limit) = confirmation.not_on_or_after {
        limit = limit.min(confirmation_limit.min(max_time_limit(assertion.issue_instant)));
    }
    Some(limit.timestamp_millis() + CLOCK_SKEW_MS)
}

pub async fn validate_saml_response(
    cache: &SamlCache,
    base_url: &str,
    conn: &EnterpriseConnectionRow,
    saml_response: &str,
) -> Result<SamlProfile, orbitid_core::OrbitError> {
    let cfg = saml_config(conn)?;
    let acs_url = acs_url_for(base_url, &conn.id);
    let sp_entity_id = sp_entity_id_for(base_url, &conn.id);
    if saml_response.is_empty() {
        return Err(verification_failed("SAMLResponse is missing"));
    }
    let xml = decode_base64(saml_response)?;
    let scan = assert_response_target(&xml, &acs_url)?;
    let (assertion_id, response_signed) = structural_checks(&scan)?;
    let reduced = verify_signatures(&xml, &cfg.idp_certificate).await?;
    let (response, assertion) = parse_verified(&reduced, &assertion_id)?;

    let response_in_response_to = response
        .as_ref()
        .filter(|_| response_signed)
        .and_then(|response| response.in_response_to.clone());
    if let Some(issuer) = response
        .as_ref()
        .and_then(|response| response.issuer.as_ref())
    {
        if issuer.value.as_deref() != Some(cfg.idp_entity_id.as_str()) {
            return Err(fail(
                "the response issuer is not the configured identity provider",
            ));
        }
    }

    // Everything below reads the verified assertion (and, when present, the
    // verified Response). Select the single bearer confirmation first: it is the
    // only source of Recipient/NotOnOrAfter/InResponseTo for this login.
    if assertion.issuer.value.as_deref() != Some(cfg.idp_entity_id.as_str()) {
        return Err(fail(
            "the assertion issuer is not the configured identity provider",
        ));
    }
    if assertion.issue_instant + Duration::milliseconds(ASSERTION_MAX_AGE_MS) <= now() {
        return Err(fail("the assertion is too old"));
    }
    let conditions = assertion
        .conditions
        .as_ref()
        .ok_or_else(|| fail("SAML assertion has no AudienceRestriction"))?;
    let conditions_not_on_or_after = conditions
        .not_on_or_after
        .ok_or_else(|| fail("SAML assertion has no NotOnOrAfter"))?;
    if !timestamps_ok(
        conditions.not_before,
        conditions_not_on_or_after,
        max_time_limit(assertion.issue_instant),
        now(),
    ) {
        return Err(fail("the assertion is not valid at this time"));
    }
    if !audience_ok(&assertion, &sp_entity_id) {
        return Err(fail(
            "SAML assertion audience mismatch or missing AudienceRestriction",
        ));
    }
    let confirmation = subject_confirmation(&assertion, &acs_url)?;

    // Retire the request the assertion answers before the replay claim. A
    // signed Response may carry it; otherwise the confirmation must.
    let validation_mode = validate_in_response_to(conn);
    let mut candidates: Vec<String> = Vec::new();
    if let Some(value) = &response_in_response_to {
        candidates.push(value.clone());
    }
    if let Some(value) = &confirmation.in_response_to {
        if !candidates.contains(value) {
            candidates.push(value.clone());
        }
    }
    let had_in_response_to = !candidates.is_empty();
    if validation_mode.applies(had_in_response_to) {
        if candidates.is_empty() {
            return Err(fail("InResponseTo is missing from response"));
        }
        let mut matched = false;
        for candidate in &candidates {
            if cache.consume(candidate).await?.is_some() {
                matched = true;
                break;
            }
        }
        if !matched {
            return Err(fail("InResponseTo is not valid"));
        }
    }
    if validation_mode == ValidateInResponseTo::Always && !had_in_response_to {
        return Err(fail("InResponseTo is missing from response"));
    }
    if let (Some(response_value), Some(subject_value)) =
        (&response_in_response_to, &confirmation.in_response_to)
    {
        if response_value != subject_value {
            return Err(fail("InResponseTo does not match subjectInResponseTo"));
        }
    }
    let accepted_until = assertion_accepted_until(&assertion, &confirmation).ok_or_else(|| {
        fail("the assertion has no NotOnOrAfter, so it would be accepted for ever")
    })?;
    let replay_key = serde_json::to_string(&serde_json::json!([
        "assertion",
        assertion.issuer.value.as_deref().unwrap_or(""),
        assertion.id
    ]))
    .unwrap_or_default();
    if accepted_until > now().timestamp_millis() {
        let claimed = cache
            .save_if_absent(&replay_key, &now().to_rfc3339(), accepted_until)
            .await?;
        if !claimed {
            return Err(fail(format!(
                "the assertion {} has already been received",
                assertion.id
            )));
        }
    }
    Ok(profile_from_assertion(
        &assertion,
        &confirmation,
        response_in_response_to.as_deref(),
    ))
}

#[cfg(test)]
mod tests;
