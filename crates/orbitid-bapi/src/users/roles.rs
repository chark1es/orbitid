//! User instance roles, memberships, trusted devices and OAuth-token refusal.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::OrganizationMembershipRow;
use orbitid_core::resources::UserRolesJson;
use orbitid_core::state::AppState;
use orbitid_identity::serializers::{
    serialize_memberships, serialize_trusted_device, UserSerializeOptions,
};
use orbitid_identity::trusted_devices::{list_trusted_devices, revoke_trusted_device};
use orbitid_identity::user_roles::{
    configured_default_role, reset_user_roles_on, role_claims_for_user, set_user_roles_on,
};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{
    deleted_object, fetch_all, fetch_count, get_user_or_throw, json_response, to_value, Bind,
    QueryPairs,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/users/{id}/roles",
            get(read_roles).put(update_roles).delete(reset_roles),
        )
        .route("/v1/users/{id}/organization_memberships", get(memberships))
        .route("/v1/users/{id}/trusted_devices", get(trusted_devices))
        .route(
            "/v1/users/{id}/trusted_devices/{device_id}",
            delete(revoke_device),
        )
}

/// `UserRolesJSON`: the effective roles, where they come from, and the
/// configured instance default for reference.
async fn user_roles_json(state: &AppState, user_id: &str) -> Result<serde_json::Value> {
    let claims = role_claims_for_user(state, user_id).await?;
    to_value(UserRolesJson {
        object: "user_roles".into(),
        user_id: user_id.to_string(),
        roles: claims.roles,
        role_permissions: claims.permissions,
        source: claims.source.as_str().into(),
        default_role: configured_default_role(state),
    })
}

async fn read_roles(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let user = get_user_or_throw(&state, &id).await?;
    Ok(json_response(user_roles_json(&state, &user.id).await?))
}

/// Drops the explicit assignment so the user inherits the instance default
/// role again (`source: "default"`).
async fn reset_roles(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    {
        let mut tx = state.pool.begin().await?;
        reset_user_roles_on(&mut tx, &existing.id).await?;
        let user = orbitid_identity::users::require_user_on(&mut tx, &existing.id).await?;
        let value = to_value(
            orbitid_identity::serializers::serialize_user_on(
                &mut tx,
                &state,
                &user,
                UserSerializeOptions { backend: true },
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value).await?;
        tx.commit().await?;
    }
    // Safety net: reset keeps `app:sys_*` rows, so this should find nothing to
    // revoke. It stays so a future change to reset can't leave a console
    // session alive without console access.
    orbitid_identity::operator_session::revoke_console_sessions_without_access(
        &state,
        &existing.id,
    )
    .await?;
    audit(
        &state,
        AuditInput::new("user.roles.reset")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id.clone()),
    )
    .await;
    Ok(json_response(user_roles_json(&state, &existing.id).await?))
}

#[derive(Debug, Deserialize)]
struct RolesBody {
    roles: Vec<String>,
}

async fn update_roles(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<RolesBody>,
) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    if body.roles.len() > 50 || body.roles.iter().any(|role| role.is_empty()) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "roles must be a list of at most 50 non-empty role keys",
        )
        .with_meta(json!({ "param_name": "roles" })));
    }
    let roles = {
        let mut tx = state.pool.begin().await?;
        let roles = set_user_roles_on(&mut tx, &state, &existing.id, &body.roles).await?;
        let user = orbitid_identity::users::require_user_on(&mut tx, &existing.id).await?;
        let value = to_value(
            orbitid_identity::serializers::serialize_user_on(
                &mut tx,
                &state,
                &user,
                UserSerializeOptions { backend: true },
            )
            .await?,
        )?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value).await?;
        tx.commit().await?;
        roles
    };
    // Losing console access ends the account's console sessions for good.
    orbitid_identity::operator_session::revoke_console_sessions_without_access(
        &state,
        &existing.id,
    )
    .await?;
    audit(
        &state,
        AuditInput::new("user.roles.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id.clone())
            .metadata(json!({ "roles": roles })),
    )
    .await;
    Ok(json_response(user_roles_json(&state, &existing.id).await?))
}

async fn memberships(
    State(state): State<AppState>,
    Path(id): Path<String>,
    query: QueryPairs,
) -> Result<Response> {
    let user = get_user_or_throw(&state, &id).await?;
    let list = query.list()?;
    let mut binds = vec![Bind::Text(user.id.clone()), Bind::Int(list.limit)];
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM organization_memberships WHERE user_id = $1 \
         ORDER BY created_at DESC LIMIT ${limit_slot} OFFSET ${offset_slot}"
    );
    let rows: Vec<OrganizationMembershipRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        "SELECT count(*) FROM organization_memberships WHERE user_id = $1",
        &[Bind::Text(user.id.clone())],
    )
    .await?;
    let data = serialize_memberships(&state, &rows, true).await?;
    Ok(json_response(crate::shared::paginated(
        to_value(data)?,
        total,
    )))
}

async fn trusted_devices(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let user = get_user_or_throw(&state, &id).await?;
    let rows = list_trusted_devices(&state, &user.id).await?;
    Ok(json_response(to_value(
        rows.iter()
            .map(serialize_trusted_device)
            .collect::<Vec<_>>(),
    )?))
}

async fn revoke_device(
    State(state): State<AppState>,
    Path((id, device_id)): Path<(String, String)>,
) -> Result<Response> {
    let user = get_user_or_throw(&state, &id).await?;
    let row = revoke_trusted_device(&state, &user.id, &device_id).await?;
    let Some(row) = row else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Trusted device not found.",
        ));
    };
    audit(
        &state,
        AuditInput::new("user.trusted_device.revoked")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(user.id)
            .metadata(json!({ "trusted_device_id": row.id })),
    )
    .await;
    Ok(json_response(deleted_object("trusted_device", &row.id)))
}
