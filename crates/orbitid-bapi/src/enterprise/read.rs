use axum::extract::{Path, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::state::AppState;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::shared::{
    deserialize_bool, deserialize_opt_bool, fetch_all, fetch_count, json_response, paginated,
    to_value, Bind, QueryPairs,
};

use super::serialization::serialize_connection;

pub(super) async fn connection_or_throw(
    state: &AppState,
    id: &str,
) -> Result<EnterpriseConnectionRow> {
    sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Enterprise connection not found",
        )
    })
}

pub(super) async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut filter = crate::shared::Where::new();
    if let Some(protocol) = query.raw("protocol") {
        filter.equal_text("protocol", protocol);
    }
    if let Some(active) = crate::shared::parse_bool_query(query.raw("active")) {
        filter.equal_bool("active", active);
    }
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM enterprise_connections{} ORDER BY created_at DESC LIMIT ${limit_slot} \
         OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<EnterpriseConnectionRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!(
            "SELECT count(*) FROM enterprise_connections{}",
            filter.sql()
        ),
        &filter.binds,
    )
    .await?;
    let data = rows
        .iter()
        .map(|row| serialize_connection(&state, row))
        .map(|result| result.and_then(to_value))
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

pub(super) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row = connection_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_connection(
        &state, &row,
    )?)?))
}

#[derive(Debug, Deserialize)]
pub(super) struct ConnectionBody {
    pub(super) name: String,
    #[serde(default)]
    pub(super) protocol: Option<String>,
    #[serde(default)]
    pub(super) provider: Option<String>,
    #[serde(default)]
    pub(super) domains: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_bool")]
    pub(super) active: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    pub(super) allow_subdomains: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    pub(super) allow_idp_initiated: bool,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    pub(super) sync_user_attributes: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_bool")]
    pub(super) disable_additional_identifications: bool,
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
