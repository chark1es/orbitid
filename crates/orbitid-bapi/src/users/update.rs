//! User read, update and metadata routes.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::admin::refuse_user_credential_mutation;
use orbitid_identity::org_shared::merge_metadata;
use orbitid_identity::serializers::{serialize_user, UserSerializeOptions};
use orbitid_identity::users::guards::{assert_required_profile_field, ProfileField};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;
use sqlx::QueryBuilder;

use crate::shared::{
    deserialize_opt_bool, deserialize_opt_int, deserialize_opt_nullable_string,
    deserialize_opt_nullable_string_list, get_user_or_throw, json_response, to_value,
    validate_metadata,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/users/{id}", get(read).patch(update))
        .route("/v1/users/{id}/metadata", patch(update_metadata))
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let user = get_user_or_throw(&state, &id).await?;
    let json =
        to_value(serialize_user(&state, &user, UserSerializeOptions { backend: true }).await?)?;
    Ok(json_response(json))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string")]
    external_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string")]
    username: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string")]
    first_name: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string")]
    last_name: Option<Option<String>>,
    primary_email_address_id: Option<Option<String>>,
    primary_phone_number_id: Option<Option<String>>,
    password: Option<String>,
    password_digest: Option<String>,
    password_hasher: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    #[allow(dead_code)]
    skip_password_checks: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    sign_out_of_other_sessions: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string")]
    totp_secret: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_nullable_string_list")]
    backup_codes: Option<Option<Vec<String>>>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    unsafe_metadata: Option<Metadata>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    delete_self_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    create_organization_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    create_organizations_limit: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    legal_accepted_at: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    if body.password.is_some() || body.password_digest.is_some() || body.password_hasher.is_some() {
        return Err(refuse_user_credential_mutation(
            "set, replace or remove the user's password",
            "change_password / remove_password",
        ));
    }
    if body.totp_secret.is_some() || body.backup_codes.is_some() {
        return Err(refuse_user_credential_mutation(
            "install, replace or remove the user's authenticator or backup codes",
            "POST /totp, /totp/attempt_verification and /backup_codes",
        ));
    }
    if body.primary_email_address_id.is_some() || body.primary_phone_number_id.is_some() {
        return Err(refuse_user_credential_mutation(
            "move the user's primary sign-in identifier",
            "PATCH /me with primary_email_address_id / primary_phone_number_id after verifying the identifier",
        ));
    }
    for metadata in [
        &body.public_metadata,
        &body.private_metadata,
        &body.unsafe_metadata,
    ]
    .into_iter()
    .flatten()
    {
        validate_metadata(metadata)?;
    }

    let now_ms = now();
    let mut fields: Vec<&str> = Vec::new();
    let mut builder: QueryBuilder<sqlx::Postgres> =
        QueryBuilder::new("UPDATE users SET updated_at = ");
    builder.push_bind(now_ms);

    if let Some(external_id) = &body.external_id {
        if let Some(value) = external_id {
            let taken: Option<String> =
                sqlx::query_scalar("SELECT id FROM users WHERE external_id = $1")
                    .bind(value)
                    .fetch_optional(&state.pool)
                    .await?;
            if taken.as_deref().is_some_and(|taken| taken != existing.id) {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_IDENTIFIER_EXISTS,
                    "This external_id is already in use.",
                )
                .with_meta(json!({ "param_name": "external_id" })));
            }
        }
        builder.push(", external_id = ");
        builder.push_bind(external_id.clone());
        fields.push("external_id");
    }
    if let Some(username) = &body.username {
        let normalized = username
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);
        assert_required_profile_field(&state, ProfileField::Username, Some(normalized.as_deref()))?;
        if let Some(name) = &normalized {
            let taken: Option<String> =
                sqlx::query_scalar("SELECT id FROM users WHERE username_lower = $1")
                    .bind(name.to_lowercase())
                    .fetch_optional(&state.pool)
                    .await?;
            if taken.as_deref().is_some_and(|taken| taken != existing.id) {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_IDENTIFIER_EXISTS,
                    "This username is already taken.",
                )
                .with_meta(json!({ "param_name": "username" })));
            }
        }
        builder.push(", username = ");
        builder.push_bind(normalized.clone());
        builder.push(", username_lower = ");
        builder.push_bind(normalized.as_ref().map(|name| name.to_lowercase()));
        fields.push("username");
    }
    if let Some(first_name) = &body.first_name {
        assert_required_profile_field(
            &state,
            ProfileField::FirstName,
            Some(first_name.as_deref()),
        )?;
        builder.push(", first_name = ");
        builder.push_bind(first_name.clone());
        fields.push("first_name");
    }
    if let Some(last_name) = &body.last_name {
        assert_required_profile_field(&state, ProfileField::LastName, Some(last_name.as_deref()))?;
        builder.push(", last_name = ");
        builder.push_bind(last_name.clone());
        fields.push("last_name");
    }
    if let Some(metadata) = &body.public_metadata {
        builder.push(", public_metadata = ");
        builder.push_bind(sqlx::types::Json(metadata.clone()));
        fields.push("public_metadata");
    }
    if let Some(metadata) = &body.private_metadata {
        builder.push(", private_metadata = ");
        builder.push_bind(sqlx::types::Json(metadata.clone()));
        fields.push("private_metadata");
    }
    if let Some(metadata) = &body.unsafe_metadata {
        builder.push(", unsafe_metadata = ");
        builder.push_bind(sqlx::types::Json(metadata.clone()));
        fields.push("unsafe_metadata");
    }
    if let Some(enabled) = body.delete_self_enabled {
        builder.push(", delete_self_enabled = ");
        builder.push_bind(enabled);
        fields.push("delete_self_enabled");
    }
    if let Some(enabled) = body.create_organization_enabled {
        builder.push(", create_organization_enabled = ");
        builder.push_bind(enabled);
        fields.push("create_organization_enabled");
    }
    if let Some(limit) = body.create_organizations_limit {
        builder.push(", create_organizations_limit = ");
        builder.push_bind(limit);
        fields.push("create_organizations_limit");
    }
    if let Some(accepted) = body.legal_accepted_at {
        builder.push(", legal_accepted_at = ");
        builder.push_bind(accepted);
        fields.push("legal_accepted_at");
    }
    builder.push(" WHERE id = ");
    builder.push_bind(&existing.id);
    let mut tx = state.pool.begin().await?;
    builder.build().execute(&mut *tx).await?;

    let user = orbitid_identity::users::require_user_on(&mut tx, &existing.id).await?;
    let value = to_value(
        &orbitid_identity::serializers::serialize_user_on(
            &mut tx,
            &state,
            &user,
            UserSerializeOptions { backend: true },
        )
        .await?,
    )?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value.clone()).await?;
    if body.sign_out_of_other_sessions == Some(true) {
        orbitid_identity::sessions::end_sessions_for_user_on(
            &mut tx,
            &state,
            &existing.id,
            "revoked",
            None,
        )
        .await?;
    }
    tx.commit().await?;
    audit(
        &state,
        AuditInput::new("user.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id.clone())
            .metadata(json!({ "fields": fields })),
    )
    .await;
    Ok(json_response(value))
}

#[derive(Debug, Deserialize)]
struct MetadataBody {
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    unsafe_metadata: Option<Metadata>,
}

async fn update_metadata(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<MetadataBody>,
) -> Result<Response> {
    let existing = get_user_or_throw(&state, &id).await?;
    for metadata in [
        &body.public_metadata,
        &body.private_metadata,
        &body.unsafe_metadata,
    ]
    .into_iter()
    .flatten()
    {
        validate_metadata(metadata)?;
    }
    let mut tx = state.pool.begin().await?;
    // Merge from the row read under the lock: two concurrent metadata PATCHes
    // must keep both keys.
    let current = sqlx::query_as::<_, orbitid_core::models::UserRow>(
        "SELECT * FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(&existing.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
    let public = match &body.public_metadata {
        Some(patch) => merge_metadata(Some(&current.public_metadata.0), Some(patch)),
        None => current.public_metadata.0.clone(),
    };
    let private = match &body.private_metadata {
        Some(patch) => merge_metadata(Some(&current.private_metadata.0), Some(patch)),
        None => current.private_metadata.0.clone(),
    };
    let unsafe_metadata = match &body.unsafe_metadata {
        Some(patch) => merge_metadata(Some(&current.unsafe_metadata.0), Some(patch)),
        None => current.unsafe_metadata.0.clone(),
    };
    sqlx::query(
        "UPDATE users SET public_metadata = $1, private_metadata = $2, unsafe_metadata = $3, \
         updated_at = $4 WHERE id = $5",
    )
    .bind(sqlx::types::Json(public))
    .bind(sqlx::types::Json(private))
    .bind(sqlx::types::Json(unsafe_metadata))
    .bind(now())
    .bind(&existing.id)
    .execute(&mut *tx)
    .await?;
    let user = orbitid_identity::users::require_user_on(&mut tx, &existing.id).await?;
    let value = to_value(
        &orbitid_identity::serializers::serialize_user_on(
            &mut tx,
            &state,
            &user,
            UserSerializeOptions { backend: true },
        )
        .await?,
    )?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "user.updated", value.clone()).await?;
    tx.commit().await?;
    audit(
        &state,
        AuditInput::new("user.metadata.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(existing.id),
    )
    .await;
    Ok(json_response(value))
}
