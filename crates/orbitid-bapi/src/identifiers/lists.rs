use axum::extract::{Path, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{AllowlistIdentifierRow, BlocklistIdentifierRow};
use orbitid_core::resources::{AllowlistIdentifierJson, BlocklistIdentifierJson, Metadata};
use orbitid_core::state::AppState;
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{
    deleted_object, deserialize_bool, fetch_all, fetch_count, identifier_type, json_response,
    normalize_email, paginated, to_value, validate_metadata, Bind, QueryPairs,
};

fn allowlist_json(row: &AllowlistIdentifierRow) -> AllowlistIdentifierJson {
    AllowlistIdentifierJson {
        object: "allowlist_identifier".into(),
        id: row.id.clone(),
        identifier: row.identifier.clone(),
        identifier_type: row.identifier_type.clone(),
        invitation_id: row.invitation_id.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn blocklist_json(row: &BlocklistIdentifierRow) -> BlocklistIdentifierJson {
    BlocklistIdentifierJson {
        object: "blocklist_identifier".into(),
        id: row.id.clone(),
        identifier: row.identifier.clone(),
        identifier_type: row.identifier_type.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) async fn list_allowlist(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let rows: Vec<AllowlistIdentifierRow> = fetch_all(
        &state.pool,
        "SELECT * FROM allowlist_identifiers LIMIT $1 OFFSET $2",
        &[Bind::Int(list.limit), Bind::Int(list.offset)],
    )
    .await?;
    let total = fetch_count(
        &state.pool,
        "SELECT count(*) FROM allowlist_identifiers",
        &[],
    )
    .await?;
    let data = rows
        .iter()
        .map(allowlist_json)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

#[derive(Debug, Deserialize)]
pub(super) struct AllowlistBody {
    identifier: String,
    #[serde(default, deserialize_with = "deserialize_bool")]
    notify: bool,
    public_metadata: Option<Metadata>,
}

pub(super) async fn create_allowlist(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<AllowlistBody>,
) -> Result<Response> {
    if body.identifier.trim().is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "identifier must not be empty",
        )
        .with_meta(json!({ "param_name": "identifier" })));
    }
    if let Some(metadata) = &body.public_metadata {
        validate_metadata(metadata)?;
    }
    let identifier = normalize_email(&body.identifier);
    let kind = identifier_type(&identifier);
    // Settings are their own store transaction and cannot join this one.
    if !state.settings.get().restrictions.allowlist_enabled {
        state
            .settings
            .update(json!({ "restrictions": { "allowlistEnabled": true } }))
            .await?;
    }
    let (row, invitation) = {
        let mut tx = state.pool.begin().await?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM allowlist_identifiers WHERE identifier = $1")
                .bind(&identifier)
                .fetch_optional(&mut *tx)
                .await?;
        if existing.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::DUPLICATE_RECORD,
                "This identifier is already allowlisted.",
            )
            .with_meta(json!({ "param_name": "identifier" })));
        }
        let mut created_invitation = None;
        if body.notify && kind == "email_address" {
            orbitid_identity::lookups_bapi::lock_instance_invitations_on(&mut tx).await?;
            let input = crate::invitations::CreateInvitationInput {
                email: identifier.clone(),
                public_metadata: body.public_metadata.clone(),
                redirect_url: None,
                notify: true,
                ignore_existing: true,
                expires_in_days: None,
                email_template: None,
            };
            created_invitation =
                crate::invitations::insert_invitation_on(&mut tx, &state, &input, false).await?;
        }
        let invitation_id = created_invitation
            .as_ref()
            .map(|created| created.row.id.clone());
        let row = orbitid_identity::lookups_bapi::create_allowlist_identifier_typed_on(
            &mut tx,
            &identifier,
            kind,
            invitation_id.as_deref(),
        )
        .await?;
        tx.commit().await?;
        (row, created_invitation)
    };
    if let Some(created) = &invitation {
        crate::invitations::finish_invitation(&state, &identifier, created, true, None).await;
    }
    audit(
        &state,
        AuditInput::new("allowlist_identifier.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("allowlist_identifier")
            .target_id(row.id.clone())
            .metadata(json!({ "identifier": identifier })),
    )
    .await;
    Ok(json_response(to_value(allowlist_json(&row))?))
}

pub(super) async fn delete_allowlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row: Option<AllowlistIdentifierRow> =
        sqlx::query_as("SELECT * FROM allowlist_identifiers WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Allowlist identifier not found.",
        ));
    };
    sqlx::query("DELETE FROM allowlist_identifiers WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("allowlist_identifier.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("allowlist_identifier")
            .target_id(row.id.clone())
            .metadata(json!({ "identifier": row.identifier })),
    )
    .await;
    Ok(json_response(deleted_object(
        "allowlist_identifier",
        &row.id,
    )))
}

// ───────────── blocklist ─────────────

pub(super) async fn list_blocklist(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let rows: Vec<BlocklistIdentifierRow> = fetch_all(
        &state.pool,
        "SELECT * FROM blocklist_identifiers LIMIT $1 OFFSET $2",
        &[Bind::Int(list.limit), Bind::Int(list.offset)],
    )
    .await?;
    let total = fetch_count(
        &state.pool,
        "SELECT count(*) FROM blocklist_identifiers",
        &[],
    )
    .await?;
    let data = rows
        .iter()
        .map(blocklist_json)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

#[derive(Debug, Deserialize)]
pub(super) struct BlocklistBody {
    identifier: String,
}

pub(super) async fn create_blocklist(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<BlocklistBody>,
) -> Result<Response> {
    if body.identifier.trim().is_empty() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "identifier must not be empty",
        )
        .with_meta(json!({ "param_name": "identifier" })));
    }
    let identifier = normalize_email(&body.identifier);
    // Settings are their own store transaction and cannot join this one.
    if !state.settings.get().restrictions.blocklist_enabled {
        state
            .settings
            .update(json!({ "restrictions": { "blocklistEnabled": true } }))
            .await?;
    }
    let row = {
        let mut tx = state.pool.begin().await?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM blocklist_identifiers WHERE identifier = $1")
                .bind(&identifier)
                .fetch_optional(&mut *tx)
                .await?;
        if existing.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::DUPLICATE_RECORD,
                "This identifier is already blocklisted.",
            )
            .with_meta(json!({ "param_name": "identifier" })));
        }
        let row = orbitid_identity::lookups_bapi::create_blocklist_identifier_typed_on(
            &mut tx,
            &identifier,
            identifier_type(&identifier),
        )
        .await?;
        tx.commit().await?;
        row
    };
    audit(
        &state,
        AuditInput::new("blocklist_identifier.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("blocklist_identifier")
            .target_id(row.id.clone())
            .metadata(json!({ "identifier": identifier })),
    )
    .await;
    Ok(json_response(to_value(blocklist_json(&row))?))
}

pub(super) async fn delete_blocklist(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row: Option<BlocklistIdentifierRow> =
        sqlx::query_as("SELECT * FROM blocklist_identifiers WHERE id = $1")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Blocklist identifier not found.",
        ));
    };
    sqlx::query("DELETE FROM blocklist_identifiers WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("blocklist_identifier.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("blocklist_identifier")
            .target_id(row.id.clone())
            .metadata(json!({ "identifier": row.identifier })),
    )
    .await;
    Ok(json_response(deleted_object(
        "blocklist_identifier",
        &row.id,
    )))
}
