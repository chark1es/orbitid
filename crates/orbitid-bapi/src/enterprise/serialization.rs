use orbitid_core::error::Result;
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::resources::{EnterpriseConnectionJson, OidcConnectionJson, SamlConnectionJson};
use orbitid_core::state::AppState;
use orbitid_federation::saml::{
    acs_url_for, metadata_url_for, normalize_domains, sp_entity_id_for,
};
use serde_json::{Map, Value};

pub(super) const DEFAULT_ATTRIBUTE_MAPPING: [(&str, &str); 4] = [
    ("email", "email"),
    ("first_name", "firstName"),
    ("last_name", "lastName"),
    ("user_id", "nameID"),
];

pub(super) fn config_object(row: &EnterpriseConnectionRow) -> Map<String, Value> {
    match &row.config.0 {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }
}

fn attribute_mapping(config: &Map<String, Value>) -> std::collections::BTreeMap<String, String> {
    let mut mapping: std::collections::BTreeMap<String, String> = DEFAULT_ATTRIBUTE_MAPPING
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    if let Some(stored) = config.get("attributeMapping").and_then(Value::as_object) {
        for (key, value) in stored {
            if let Some(value) = value.as_str() {
                mapping.insert(key.clone(), value.to_string());
            }
        }
    }
    mapping
}

pub(super) fn serialize_connection(
    state: &AppState,
    row: &EnterpriseConnectionRow,
) -> Result<EnterpriseConnectionJson> {
    let config = config_object(row);
    let mut json = EnterpriseConnectionJson {
        object: "enterprise_connection".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        protocol: row.protocol.clone(),
        provider: row.provider.clone(),
        domains: normalize_domains(&row.domains.0),
        active: row.active,
        allow_subdomains: row.allow_subdomains,
        allow_idp_initiated: row.allow_idp_initiated,
        sync_user_attributes: row.sync_user_attributes,
        disable_additional_identifications: row.disable_additional_identifications,
        saml: None,
        oidc: None,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
    if row.protocol == "saml" {
        json.saml = Some(SamlConnectionJson {
            idp_entity_id: config
                .get("idpEntityId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            idp_sso_url: config
                .get("idpSsoUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            idp_certificate: config
                .get("idpCertificate")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            acs_url: acs_url_for(&state.env.base_url, &row.id),
            sp_entity_id: sp_entity_id_for(&state.env.base_url, &row.id),
            sp_metadata_url: metadata_url_for(&state.env.base_url, &row.id),
            attribute_mapping: attribute_mapping(&config),
        });
    } else {
        let discovery = config.get("discovery").and_then(Value::as_object);
        json.oidc = Some(OidcConnectionJson {
            client_id: config
                .get("clientId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            discovery_url: config
                .get("discoveryUrl")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            auth_url: discovery
                .and_then(|value| value.get("authorization_endpoint"))
                .and_then(Value::as_str)
                .map(str::to_string),
            token_url: discovery
                .and_then(|value| value.get("token_endpoint"))
                .and_then(Value::as_str)
                .map(str::to_string),
            user_info_url: discovery
                .and_then(|value| value.get("userinfo_endpoint"))
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    Ok(json)
}
