use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::safe_fetch::assert_public_url;
use orbitid_core::state::AppState;
use orbitid_federation::saml::{
    assert_valid_certificate, assert_valid_domains, encrypt_client_secret, normalize_domains,
    resolve_saml_metadata,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::shared::{deserialize_opt_bool, json_response, to_value};

use super::domains::assert_domains_unclaimed_on;
use super::read::*;
use super::serialization::*;

pub(super) fn protocol_of(value: Option<&str>) -> Result<String> {
    let protocol = value.unwrap_or("saml");
    if protocol != "saml" && protocol != "oidc" {
        return Err(invalid_param("protocol", "protocol must be saml or oidc"));
    }
    Ok(protocol.to_string())
}

pub(super) fn require_field<'a>(
    value: Option<&'a str>,
    param: &str,
    protocol: &str,
) -> Result<&'a str> {
    match value.filter(|value| !value.is_empty()) {
        Some(value) => Ok(value),
        None => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            format!("{param} is required for {protocol} connections"),
        )
        .with_meta(json!({ "param_name": param }))),
    }
}

pub(super) fn invalid_param(param: &str, message: impl Into<String>) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

pub(super) async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<ConnectionBody>,
) -> Result<Response> {
    if body.name.is_empty() {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "name is required")
                .with_meta(json!({ "param_name": "name" })),
        );
    }
    if body.name.chars().count() > 256 {
        return Err(invalid_param("name", "name must be at most 256 characters"));
    }
    let protocol = protocol_of(body.protocol.as_deref())?;
    let provider = body
        .provider
        .clone()
        .unwrap_or_else(|| "custom".to_string());
    if provider.is_empty() || provider.chars().count() > 64 {
        return Err(invalid_param(
            "provider",
            "provider must be 1-64 characters",
        ));
    }
    if body.domains.as_ref().map(Vec::len).unwrap_or(0) > 50 {
        return Err(invalid_param(
            "domains",
            "domains must contain at most 50 entries",
        ));
    }
    let domains = normalize_domains(&body.domains.clone().unwrap_or_default());
    assert_valid_domains(&domains)?;
    if let Some(sso) = &body.idp_sso_url {
        if protocol == "saml" {
            assert_public_url(Some(&state), sso, "idp_sso_url").await?;
        }
    }
    if let Some(discovery) = &body.discovery_url {
        assert_public_url(Some(&state), discovery, "discovery_url").await?;
    }
    let config = if protocol == "saml" {
        let metadata = resolve_saml_metadata(
            &state,
            body.idp_metadata_url.as_deref(),
            body.idp_metadata_xml.as_deref(),
        )
        .await?;
        let entity_id = require_field(
            body.idp_entity_id
                .as_deref()
                .or(metadata.entity_id.as_deref()),
            "idp_entity_id",
            "SAML",
        )?;
        let sso_url = require_field(
            body.idp_sso_url.as_deref().or(metadata.sso_url.as_deref()),
            "idp_sso_url",
            "SAML",
        )?;
        let certificate = require_field(
            body.idp_certificate
                .as_deref()
                .or(metadata.certificate.as_deref()),
            "idp_certificate",
            "SAML",
        )?;
        let certificate = assert_valid_certificate(certificate)?;
        let mut mapping: Map<String, Value> = DEFAULT_ATTRIBUTE_MAPPING
            .iter()
            .map(|(key, value)| ((*key).to_string(), json!(value)))
            .collect();
        if let Some(extra) = &body.attribute_mapping {
            for (key, value) in extra {
                mapping.insert(key.clone(), value.clone());
            }
        }
        json!({
            "idpEntityId": entity_id,
            "idpSsoUrl": sso_url,
            "idpCertificate": certificate,
            "attributeMapping": mapping,
        })
    } else {
        let client_id = require_field(body.client_id.as_deref(), "client_id", "OIDC")?;
        let client_secret = require_field(body.client_secret.as_deref(), "client_secret", "OIDC")?;
        let discovery_url = require_field(body.discovery_url.as_deref(), "discovery_url", "OIDC")?;
        json!({
            "clientId": client_id,
            "clientSecretEnc": encrypt_client_secret(&state.env.encryption_key, client_secret)?,
            "discoveryUrl": discovery_url,
        })
    };
    let now_ms = now();
    let row = EnterpriseConnectionRow {
        id: new_id(id_prefix::ENTERPRISE),
        name: body.name.clone(),
        protocol,
        provider,
        domains: sqlx::types::Json(domains),
        active: body.active,
        allow_subdomains: body.allow_subdomains,
        allow_idp_initiated: body.allow_idp_initiated,
        sync_user_attributes: body.sync_user_attributes.unwrap_or(true),
        disable_additional_identifications: body.disable_additional_identifications,
        config: sqlx::types::Json(config),
        created_at: now_ms,
        updated_at: now_ms,
    };
    {
        // The domain-claim check and the insert share one transaction; the
        // advisory lock serializes them across replicas.
        let mut tx = state.pool.begin().await?;
        orbitid_identity::lookups_bapi::lock_enterprise_domains_on(&mut tx).await?;
        assert_domains_unclaimed_on(&mut tx, &row.domains.0, row.allow_subdomains, None).await?;
        sqlx::query(
            "INSERT INTO enterprise_connections (id, name, protocol, provider, domains, active, \
             allow_subdomains, allow_idp_initiated, sync_user_attributes, \
             disable_additional_identifications, config, created_at, updated_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)",
        )
        .bind(&row.id)
        .bind(&row.name)
        .bind(&row.protocol)
        .bind(&row.provider)
        .bind(sqlx::types::Json(row.domains.0.clone()))
        .bind(row.active)
        .bind(row.allow_subdomains)
        .bind(row.allow_idp_initiated)
        .bind(row.sync_user_attributes)
        .bind(row.disable_additional_identifications)
        .bind(sqlx::types::Json(row.config.0.clone()))
        .bind(row.created_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok((
        axum::http::StatusCode::CREATED,
        axum::Json(to_value(serialize_connection(&state, &row)?)?),
    )
        .into_response())
}

#[derive(Debug, Deserialize)]
pub(super) struct ConnectionPatch {
    pub(super) name: Option<String>,
    pub(super) provider: Option<String>,
    pub(super) domains: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) active: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) allow_subdomains: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) allow_idp_initiated: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) sync_user_attributes: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) disable_additional_identifications: Option<bool>,
    pub(super) idp_entity_id: Option<String>,
    pub(super) idp_sso_url: Option<String>,
    pub(super) idp_certificate: Option<String>,
    pub(super) idp_metadata_url: Option<String>,
    pub(super) idp_metadata_xml: Option<String>,
    pub(super) attribute_mapping: Option<Map<String, Value>>,
    pub(super) client_id: Option<String>,
    pub(super) client_secret: Option<String>,
    pub(super) discovery_url: Option<String>,
}

pub(super) async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<ConnectionPatch>,
) -> Result<Response> {
    let row = connection_or_throw(&state, &id).await?;
    if body.name.is_none()
        && body.provider.is_none()
        && body.domains.is_none()
        && body.active.is_none()
        && body.allow_subdomains.is_none()
        && body.allow_idp_initiated.is_none()
        && body.sync_user_attributes.is_none()
        && body.disable_additional_identifications.is_none()
        && body.idp_entity_id.is_none()
        && body.idp_sso_url.is_none()
        && body.idp_certificate.is_none()
        && body.idp_metadata_url.is_none()
        && body.idp_metadata_xml.is_none()
        && body.attribute_mapping.is_none()
        && body.client_id.is_none()
        && body.client_secret.is_none()
        && body.discovery_url.is_none()
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "at least one field is required",
        ));
    }
    if body.name.as_ref().is_some_and(|name| name.is_empty()) {
        return Err(
            OrbitError::unprocessable(error_codes::FORM_PARAM_MISSING, "name is required")
                .with_meta(json!({ "param_name": "name" })),
        );
    }
    if body
        .name
        .as_ref()
        .is_some_and(|name| name.chars().count() > 256)
    {
        return Err(invalid_param("name", "name must be at most 256 characters"));
    }
    if body
        .provider
        .as_ref()
        .is_some_and(|provider| provider.is_empty() || provider.chars().count() > 64)
    {
        return Err(invalid_param(
            "provider",
            "provider must be 1-64 characters",
        ));
    }
    if body.domains.as_ref().map(Vec::len).unwrap_or(0) > 50 {
        return Err(invalid_param(
            "domains",
            "domains must contain at most 50 entries",
        ));
    }
    let domains = match &body.domains {
        Some(domains) => {
            let domains = normalize_domains(domains);
            assert_valid_domains(&domains)?;
            Some(domains)
        }
        None => None,
    };
    let mut config = config_object(&row);
    if row.protocol == "saml" {
        let metadata = resolve_saml_metadata(
            &state,
            body.idp_metadata_url.as_deref(),
            body.idp_metadata_xml.as_deref(),
        )
        .await?;
        if let (Some(entity_id), true) = (metadata.entity_id, body.idp_entity_id.is_none()) {
            config.insert("idpEntityId".into(), json!(entity_id));
        }
        if let (Some(sso_url), true) = (metadata.sso_url, body.idp_sso_url.is_none()) {
            assert_public_url(Some(&state), &sso_url, "idp_sso_url").await?;
            config.insert("idpSsoUrl".into(), json!(sso_url));
        }
        if let (Some(certificate), true) = (metadata.certificate, body.idp_certificate.is_none()) {
            config.insert(
                "idpCertificate".into(),
                json!(assert_valid_certificate(&certificate)?),
            );
        }
        if let Some(entity_id) = &body.idp_entity_id {
            config.insert("idpEntityId".into(), json!(entity_id));
        }
        if let Some(sso_url) = &body.idp_sso_url {
            assert_public_url(Some(&state), sso_url, "idp_sso_url").await?;
            config.insert("idpSsoUrl".into(), json!(sso_url));
        }
        if let Some(certificate) = &body.idp_certificate {
            config.insert(
                "idpCertificate".into(),
                json!(assert_valid_certificate(certificate)?),
            );
        }
        if let Some(mapping) = &body.attribute_mapping {
            let mut merged: Map<String, Value> = DEFAULT_ATTRIBUTE_MAPPING
                .iter()
                .map(|(key, value)| ((*key).to_string(), json!(value)))
                .collect();
            if let Some(current) = config.get("attributeMapping").and_then(Value::as_object) {
                for (key, value) in current {
                    merged.insert(key.clone(), value.clone());
                }
            }
            for (key, value) in mapping {
                merged.insert(key.clone(), value.clone());
            }
            config.insert("attributeMapping".into(), Value::Object(merged));
        }
    } else {
        if let Some(client_id) = &body.client_id {
            config.insert("clientId".into(), json!(client_id));
        }
        if let Some(secret) = &body.client_secret {
            config.insert(
                "clientSecretEnc".into(),
                json!(encrypt_client_secret(&state.env.encryption_key, secret)?),
            );
        }
        if let Some(discovery_url) = &body.discovery_url {
            assert_public_url(Some(&state), discovery_url, "discovery_url").await?;
            config.insert("discoveryUrl".into(), json!(discovery_url));
            config.remove("discovery");
        }
    }
    let updated = {
        // The domain-claim check, the update and the re-read share one
        // transaction under the domain advisory lock.
        let mut tx = state.pool.begin().await?;
        orbitid_identity::lookups_bapi::lock_enterprise_domains_on(&mut tx).await?;
        let current = sqlx::query_as::<_, EnterpriseConnectionRow>(
            "SELECT * FROM enterprise_connections WHERE id = $1 FOR UPDATE",
        )
        .bind(&row.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Enterprise connection not found.",
            )
        })?;
        let next_domains = domains.clone().unwrap_or_else(|| current.domains.0.clone());
        let next_subdomains = body.allow_subdomains.unwrap_or(current.allow_subdomains);
        if body.domains.is_some() || body.allow_subdomains.is_some() {
            assert_domains_unclaimed_on(&mut tx, &next_domains, next_subdomains, Some(&current.id))
                .await?;
        }
        sqlx::query(
            "UPDATE enterprise_connections SET name = $1, provider = $2, domains = $3, active = $4, \
             allow_subdomains = $5, allow_idp_initiated = $6, sync_user_attributes = $7, \
             disable_additional_identifications = $8, config = $9, updated_at = $10 WHERE id = $11",
        )
        .bind(body.name.as_deref().unwrap_or(&current.name))
        .bind(body.provider.as_deref().unwrap_or(&current.provider))
        .bind(sqlx::types::Json(next_domains))
        .bind(body.active.unwrap_or(current.active))
        .bind(next_subdomains)
        .bind(body.allow_idp_initiated.unwrap_or(current.allow_idp_initiated))
        .bind(
            body.sync_user_attributes
                .unwrap_or(current.sync_user_attributes),
        )
        .bind(
            body.disable_additional_identifications
                .unwrap_or(current.disable_additional_identifications),
        )
        .bind(sqlx::types::Json(Value::Object(config)))
        .bind(now())
        .bind(&current.id)
        .execute(&mut *tx)
        .await?;
        let updated = sqlx::query_as::<_, EnterpriseConnectionRow>(
            "SELECT * FROM enterprise_connections WHERE id = $1",
        )
        .bind(&current.id)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        updated
    };
    Ok(json_response(to_value(serialize_connection(
        &state, &updated,
    )?)?))
}

pub(super) async fn remove(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row = connection_or_throw(&state, &id).await?;
    sqlx::query("DELETE FROM enterprise_connections WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    Ok(json_response(json!({
        "object": "enterprise_connection",
        "id": row.id,
        "deleted": true,
    })))
}
