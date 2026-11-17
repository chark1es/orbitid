//! The profile a validated assertion yields, and its attribute mapping.

use std::collections::BTreeMap;

use orbitid_core::models::EnterpriseConnectionRow;
use samael::schema::Assertion;

use crate::error::callback_error;
use crate::profile::ExternalProfile;
use crate::saml::config::saml_config;

/// The profile fields a validated assertion yields.
#[derive(Debug, Clone, Default)]
pub struct SamlProfile {
    pub name_id: Option<String>,
    pub name_id_format: Option<String>,
    pub session_index: Option<String>,
    pub in_response_to: Option<String>,
    pub attributes: BTreeMap<String, Vec<String>>,
    pub email: Option<String>,
}

fn attributes_of(assertion: &Assertion) -> BTreeMap<String, Vec<String>> {
    let mut attributes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for statement in assertion.attribute_statements.iter().flatten() {
        for attribute in &statement.attributes {
            let Some(name) = attribute.name.as_deref().filter(|name| !name.is_empty()) else {
                continue;
            };
            let values = attribute
                .values
                .iter()
                .filter_map(|value| value.value.clone())
                .collect::<Vec<_>>();
            if !values.is_empty() {
                attributes.insert(name.to_string(), values);
            }
        }
    }
    attributes
}

pub(crate) fn profile_from_assertion(
    assertion: &Assertion,
    confirmation: &samael::schema::SubjectConfirmationData,
    response_in_response_to: Option<&str>,
) -> SamlProfile {
    let attributes = attributes_of(assertion);
    let email = attributes
        .get("email")
        .and_then(|values| values.first())
        .cloned()
        .or_else(|| {
            attributes
                .get("mail")
                .and_then(|values| values.first())
                .cloned()
        })
        .or_else(|| {
            attributes
                .get("urn:oid:0.9.2342.19200300.100.1.3")
                .and_then(|values| values.first())
                .cloned()
        });
    let name_id = assertion
        .subject
        .as_ref()
        .and_then(|subject| subject.name_id.as_ref())
        .map(|name_id| name_id.value.clone());
    SamlProfile {
        name_id_format: assertion
            .subject
            .as_ref()
            .and_then(|subject| subject.name_id.as_ref())
            .and_then(|name_id| name_id.format.clone()),
        name_id,
        session_index: assertion
            .authn_statements
            .as_ref()
            .and_then(|statements| statements.first())
            .and_then(|statement| statement.session_index.clone()),
        in_response_to: response_in_response_to
            .map(str::to_string)
            .or_else(|| confirmation.in_response_to.clone()),
        attributes,
        email,
    }
}

fn attribute_value(profile: &SamlProfile, name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if ["nameid", "name_id", "user_id"].contains(&lower.as_str()) {
        return profile.name_id.clone();
    }
    if let Some(values) = profile.attributes.get(name) {
        if let Some(value) = values.first() {
            return Some(value.clone());
        }
    }
    let key = profile
        .attributes
        .keys()
        .find(|key| key.to_lowercase() == lower)?;
    profile
        .attributes
        .get(key)
        .and_then(|values| values.first().cloned())
}

/// Maps a validated SAML profile through the connection's attribute mapping.
pub fn profile_to_external_profile(
    conn: &EnterpriseConnectionRow,
    profile: &SamlProfile,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let mapping = saml_config(conn)?.attribute_mapping;
    let email = attribute_value(profile, &mapping.email).or_else(|| profile.email.clone());
    let provider_user_id = attribute_value(profile, &mapping.user_id)
        .or_else(|| profile.name_id.clone())
        .or_else(|| email.clone())
        .ok_or_else(|| callback_error("SAML assertion did not contain a user identifier"))?;
    let username = profile
        .name_id
        .as_deref()
        .filter(|name_id| name_id.contains('@'))
        .and_then(|name_id| name_id.split('@').next())
        .map(str::to_string)
        .or_else(|| profile.name_id.clone());
    let mut external =
        crate::profile::build_profile(&format!("saml_{}", conn.id), provider_user_id, None);
    external.email = email.clone();
    external.email_verified = Some(email.is_some());
    external.first_name = attribute_value(profile, &mapping.first_name);
    external.last_name = attribute_value(profile, &mapping.last_name);
    external.username = username;
    external.raw = Some(serde_json::json!({
        "nameID": profile.name_id,
        "sessionIndex": profile.session_index,
        "attributes": profile.attributes,
    }));
    Ok(external)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attribute_lookup_is_case_insensitive_and_falls_back_to_name_id() {
        let mut profile = SamlProfile {
            name_id: Some("ada@acme.test".into()),
            ..SamlProfile::default()
        };
        profile
            .attributes
            .insert("EMail".into(), vec!["ada@acme.test".into()]);
        assert_eq!(
            attribute_value(&profile, "email").as_deref(),
            Some("ada@acme.test")
        );
        assert_eq!(
            attribute_value(&profile, "nameID").as_deref(),
            Some("ada@acme.test")
        );
        assert_eq!(attribute_value(&profile, ""), None);
    }
}
