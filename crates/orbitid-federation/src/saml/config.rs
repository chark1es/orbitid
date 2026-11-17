//! SAML and enterprise-OIDC connection configuration.
//!
//! Ported from the configuration half of the retired TypeScript server.
//! Connection rows come from [`orbitid_core::models::EnterpriseConnectionRow`];
//! user/account linking is left to the caller.

use std::sync::OnceLock;

use orbitid_core::models::EnterpriseConnectionRow;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{invalid_param, missing_param};
use crate::saml::metadata::IdpMetadata;

/// Attribute names in an assertion, mapped onto local profile fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AttributeMapping {
    pub email: String,
    pub first_name: String,
    pub last_name: String,
    pub user_id: String,
}

impl Default for AttributeMapping {
    fn default() -> Self {
        Self {
            email: "email".to_string(),
            first_name: "firstName".to_string(),
            last_name: "lastName".to_string(),
            user_id: "nameID".to_string(),
        }
    }
}

/// The SAML half of an enterprise connection's `config` JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SamlConfig {
    pub idp_entity_id: String,
    pub idp_sso_url: String,
    pub idp_certificate: String,
    pub attribute_mapping: AttributeMapping,
}

pub(crate) fn config_object(conn: &EnterpriseConnectionRow) -> Map<String, Value> {
    match &conn.config.0 {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

pub fn saml_config(conn: &EnterpriseConnectionRow) -> Result<SamlConfig, orbitid_core::OrbitError> {
    let value = Value::Object(config_object(conn));
    let cfg: SamlConfig = serde_json::from_value(value).unwrap_or_default();
    if cfg.idp_entity_id.is_empty() || cfg.idp_sso_url.is_empty() || cfg.idp_certificate.is_empty()
    {
        return Err(missing_param(
            "SAML connection is missing IdP configuration",
        ));
    }
    Ok(cfg)
}

pub fn sp_entity_id_for(base_url: &str, id: &str) -> String {
    format!("{base_url}/v1/saml/{id}")
}

/// `{baseUrl}/v1/saml/{id}/acs`.
pub fn acs_url_for(base_url: &str, id: &str) -> String {
    format!("{base_url}/v1/saml/{id}/acs")
}

/// `{baseUrl}/v1/saml/{id}/metadata`.
pub fn metadata_url_for(base_url: &str, id: &str) -> String {
    format!("{base_url}/v1/saml/{id}/metadata")
}

/// Rejects anything that is not a parseable PEM X.509 certificate.
pub fn assert_valid_certificate(pem: &str) -> Result<String, orbitid_core::OrbitError> {
    let trimmed = pem.trim();
    if !trimmed.contains("-----BEGIN CERTIFICATE-----")
        || !trimmed.contains("-----END CERTIFICATE-----")
    {
        return Err(invalid_param(
            "idp_certificate",
            "idp_certificate must be a PEM encoded X.509 certificate",
        ));
    }
    match openssl::x509::X509::from_pem(trimmed.as_bytes()) {
        Ok(cert) if cert.public_key().is_ok() => Ok(trimmed.to_string()),
        _ => Err(invalid_param(
            "idp_certificate",
            "idp_certificate is not a valid X.509 certificate",
        )),
    }
}

/// Parses a PEM certificate into DER, as xmlsec needs it.
pub fn certificate_der(pem: &str) -> Result<Vec<u8>, orbitid_core::OrbitError> {
    let cert = openssl::x509::X509::from_pem(pem.trim().as_bytes()).map_err(|_| {
        invalid_param(
            "idp_certificate",
            "idp_certificate is not a valid X.509 certificate",
        )
    })?;
    Ok(cert.to_der().unwrap_or_default())
}

/// Trims, lowercases, drops empties and de-duplicates a domain list.
pub fn normalize_domains(domains: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for domain in domains {
        let normalized = domain.trim().to_lowercase();
        if !normalized.is_empty() && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

fn domain_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        // `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`
        Regex::new(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
            .unwrap_or_else(|_| unreachable!("the domain pattern is valid"))
    })
}

/// Refuses a domain that is not a bare DNS suffix.
pub fn assert_valid_domains(domains: &[String]) -> Result<(), orbitid_core::OrbitError> {
    if let Some(bad) = domains
        .iter()
        .find(|domain| !domain_regex().is_match(domain))
    {
        return Err(invalid_param(
            "domains",
            format!("\"{bad}\" is not a valid domain"),
        ));
    }
    Ok(())
}

/// Active connection matching an email, a bare domain or an identifier.
pub fn connection_matches_domain(
    domains: &[String],
    allow_subdomains: bool,
    identifier: &str,
) -> bool {
    let value = identifier.trim().to_lowercase();
    if value.is_empty() {
        return false;
    }
    let domain = match value.rsplit_once('@') {
        Some((_, domain)) => domain.to_string(),
        None => value,
    };
    let domain = domain
        .strip_prefix("https://")
        .or_else(|| domain.strip_prefix("http://"))
        .unwrap_or(&domain);
    let domain = domain.split(['/', ':']).next().unwrap_or("").to_string();
    normalize_domains(domains).into_iter().any(|candidate| {
        domain == candidate || (allow_subdomains && domain.ends_with(&format!(".{candidate}")))
    })
}

/// Merges parsed IdP metadata with explicit form fields (explicit fields win).
pub fn merge_metadata(
    explicit_entity_id: Option<&str>,
    explicit_sso_url: Option<&str>,
    explicit_certificate: Option<&str>,
    parsed: &IdpMetadata,
) -> (Option<String>, Option<String>, Option<String>) {
    (
        explicit_entity_id
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| parsed.entity_id.clone()),
        explicit_sso_url
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| parsed.sso_url.clone()),
        explicit_certificate
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| parsed.certificate.clone()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_normalized_and_validated() {
        let domains = normalize_domains(&[
            " Acme.Test ".into(),
            "acme.test".into(),
            "".into(),
            "sub.acme.test".into(),
        ]);
        assert_eq!(domains, vec!["acme.test", "sub.acme.test"]);
        assert!(assert_valid_domains(&domains).is_ok());
        assert!(assert_valid_domains(&["-bad.example".into()]).is_err());
        assert!(assert_valid_domains(&["no-dot".into()]).is_err());
    }

    #[test]
    fn domain_matching_honours_subdomains() {
        assert!(connection_matches_domain(
            &["acme.test".into()],
            false,
            "ada@acme.test"
        ));
        assert!(!connection_matches_domain(
            &["acme.test".into()],
            false,
            "ada@sub.acme.test"
        ));
        assert!(connection_matches_domain(
            &["acme.test".into()],
            true,
            "ada@sub.acme.test"
        ));
        assert!(connection_matches_domain(
            &["acme.test".into()],
            false,
            "https://acme.test/x"
        ));
        assert!(!connection_matches_domain(&["acme.test".into()], false, ""));
    }

    #[test]
    fn certificate_validation_rejects_garbage() {
        assert!(assert_valid_certificate("not a cert").is_err());
        assert!(assert_valid_certificate(
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"
        )
        .is_err());
    }

    #[test]
    fn urls_follow_the_route_shape() {
        assert_eq!(
            sp_entity_id_for("https://a", "ent_1"),
            "https://a/v1/saml/ent_1"
        );
        assert_eq!(
            acs_url_for("https://a", "ent_1"),
            "https://a/v1/saml/ent_1/acs"
        );
        assert_eq!(
            metadata_url_for("https://a", "ent_1"),
            "https://a/v1/saml/ent_1/metadata"
        );
    }

    #[test]
    fn explicit_metadata_fields_win() {
        let parsed = IdpMetadata {
            entity_id: Some("https://from-doc".into()),
            sso_url: Some("https://doc/sso".into()),
            certificate: Some("cert".into()),
        };
        let (entity, sso, cert) = merge_metadata(Some("https://explicit"), Some(""), None, &parsed);
        assert_eq!(entity.as_deref(), Some("https://explicit"));
        assert_eq!(sso.as_deref(), Some("https://doc/sso"));
        assert_eq!(cert.as_deref(), Some("cert"));
    }
}
