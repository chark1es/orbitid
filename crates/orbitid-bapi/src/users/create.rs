//! Backend API user creation.

use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use orbitid_core::crypto::encrypt;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::http::OrbitJson;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::UserRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::hash_backup_code;
use orbitid_credentials::passwords::{
    assert_password_digest, assert_password_policy, hash_password,
};
use orbitid_identity::serializers::UserSerializeOptions;
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{
    deserialize_bool, deserialize_opt_bool, deserialize_opt_int, deserialize_opt_string_list,
    json_response, normalize_email, to_value, validate_metadata,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/v1/users", post(create))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    #[serde(default, deserialize_with = "deserialize_opt_string_list")]
    email_address: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_string_list")]
    phone_number: Option<Vec<String>>,
    username: Option<String>,
    password: Option<String>,
    password_digest: Option<String>,
    password_hasher: Option<String>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    skip_password_checks: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    skip_password_requirement: Option<bool>,
    external_id: Option<String>,
    first_name: Option<Option<String>>,
    last_name: Option<Option<String>>,
    public_metadata: Option<Metadata>,
    private_metadata: Option<Metadata>,
    unsafe_metadata: Option<Metadata>,
    totp_secret: Option<String>,
    backup_codes: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    created_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    delete_self_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    create_organization_enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    legal_accepted_at: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_bool")]
    _ignored: bool,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let settings = state.settings.get();
    if body.password.is_some() && body.password_digest.is_some() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "Provide either password or password_digest, not both.",
        ));
    }
    if body.password_digest.is_some() && body.password_hasher.is_none() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "password_hasher is required with password_digest.",
        )
        .with_meta(json!({ "param_name": "password_hasher" })));
    }
    if let Some(password) = body.password.as_deref() {
        if body.skip_password_checks != Some(true) {
            assert_password_policy(&settings, password, "password")?;
        }
    }
    let password_hash = match (body.password.as_deref(), body.password_digest.as_deref()) {
        (Some(password), _) => Some(hash_password(password).await?),
        (None, Some(digest)) => {
            assert_password_digest(digest, body.password_hasher.as_deref().unwrap_or(""))?;
            Some(digest.to_string())
        }
        (None, None) => None,
    };
    if password_hash.is_none()
        && body.skip_password_requirement != Some(true)
        && settings.attributes.password.enabled
        && settings.attributes.password.required
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "password is required.",
        )
        .with_meta(json!({ "param_name": "password" })));
    }

    let username = body
        .username
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    if let Some(name) = &username {
        if name.chars().count() > 64 {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "username must be at most 64 characters",
            )
            .with_meta(json!({ "param_name": "username" })));
        }
        let taken: Option<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE username_lower = $1")
                .bind(name.to_lowercase())
                .fetch_optional(&state.pool)
                .await?;
        if taken.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "This username is already taken.",
            )
            .with_meta(json!({ "param_name": "username" })));
        }
    }
    if let Some(external_id) = &body.external_id {
        let taken: Option<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE external_id = $1")
                .bind(external_id)
                .fetch_optional(&state.pool)
                .await?;
        if taken.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "This external_id is already in use.",
            )
            .with_meta(json!({ "param_name": "external_id" })));
        }
    }

    let emails: Vec<String> = body
        .email_address
        .unwrap_or_default()
        .iter()
        .map(|email| normalize_email(email))
        .collect();
    let phones: Vec<String> = body
        .phone_number
        .unwrap_or_default()
        .iter()
        .map(|phone| phone.trim().to_string())
        .collect();
    if body.skip_password_requirement != Some(true) {
        let attrs = &settings.attributes;
        if attrs.email_address.enabled && attrs.email_address.required && emails.is_empty() {
            return Err(missing_attr("email_address"));
        }
        if attrs.phone_number.enabled && attrs.phone_number.required && phones.is_empty() {
            return Err(missing_attr("phone_number"));
        }
        if attrs.username.enabled && attrs.username.required && username.is_none() {
            return Err(missing_attr("username"));
        }
        let first_name = body.first_name.clone().flatten().unwrap_or_default();
        if attrs.first_name.enabled && attrs.first_name.required && first_name.trim().is_empty() {
            return Err(missing_attr("first_name"));
        }
        let last_name = body.last_name.clone().flatten().unwrap_or_default();
        if attrs.last_name.enabled && attrs.last_name.required && last_name.trim().is_empty() {
            return Err(missing_attr("last_name"));
        }
    }
    if has_duplicates(&emails) {
        return Err(OrbitError::unprocessable(
            error_codes::DUPLICATE_RECORD,
            "email_address contains the same address twice.",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    for email in &emails {
        let taken: Option<String> =
            sqlx::query_scalar("SELECT id FROM email_addresses WHERE email = $1")
                .bind(email)
                .fetch_optional(&state.pool)
                .await?;
        if taken.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                format!("{email} is already in use."),
            )
            .with_meta(json!({ "param_name": "email_address" })));
        }
    }
    if has_duplicates(&phones) {
        return Err(OrbitError::unprocessable(
            error_codes::DUPLICATE_RECORD,
            "phone_number contains the same number twice.",
        )
        .with_meta(json!({ "param_name": "phone_number" })));
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
    let created = body.created_at.unwrap_or(now_ms);
    let id = new_id(id_prefix::USER);
    let totp_secret_enc = match body.totp_secret.as_deref() {
        Some(secret) => Some(
            encrypt(&state.env.encryption_key, secret)
                .map_err(|_| OrbitError::internal("Could not encrypt TOTP secret"))?,
        ),
        None => None,
    };
    let backup_codes: Option<Vec<String>> = body
        .backup_codes
        .as_ref()
        .map(|codes| codes.iter().map(|code| hash_backup_code(code)).collect());
    // User row, every identifier, the primary pointers and the `user.created`
    // event commit together. A failure half-way leaves no partial user and no
    // event announcing one.
    let mut tx = state.pool.begin().await?;
    let _: UserRow = sqlx::query_as(
        "INSERT INTO users (id, external_id, username, username_lower, first_name, last_name, \
         password_hash, password_updated_at, public_metadata, private_metadata, unsafe_metadata, \
         totp_secret_enc, totp_verified, backup_codes, delete_self_enabled, \
         create_organization_enabled, legal_accepted_at, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) \
         RETURNING *",
    )
    .bind(&id)
    .bind(&body.external_id)
    .bind(&username)
    .bind(username.as_ref().map(|name| name.to_lowercase()))
    .bind(body.first_name.clone().flatten())
    .bind(body.last_name.clone().flatten())
    .bind(&password_hash)
    .bind(password_hash.as_ref().map(|_| now_ms))
    .bind(sqlx::types::Json(
        body.public_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        body.private_metadata.clone().unwrap_or_default(),
    ))
    .bind(sqlx::types::Json(
        body.unsafe_metadata.clone().unwrap_or_default(),
    ))
    .bind(&totp_secret_enc)
    .bind(body.totp_secret.is_some())
    .bind(backup_codes.map(sqlx::types::Json))
    .bind(body.delete_self_enabled.unwrap_or(true))
    .bind(body.create_organization_enabled.unwrap_or(true))
    .bind(body.legal_accepted_at)
    .bind(created)
    .fetch_one(&mut *tx)
    .await?;

    let mut primary_email: Option<String> = None;
    for email in &emails {
        let email_id = new_id(id_prefix::EMAIL);
        sqlx::query(
            "INSERT INTO email_addresses (id, user_id, email, verified, verified_at, \
             verified_strategy, created_at, updated_at) \
             VALUES ($1,$2,$3,true,$4,'email_code',$4,$4)",
        )
        .bind(&email_id)
        .bind(&id)
        .bind(email)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        if primary_email.is_none() {
            primary_email = Some(email_id);
        }
    }
    let mut primary_phone: Option<String> = None;
    for phone in &phones {
        let phone_id = new_id(id_prefix::PHONE);
        sqlx::query(
            "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, created_at, \
             updated_at) VALUES ($1,$2,$3,true,$4,$4,$4)",
        )
        .bind(&phone_id)
        .bind(&id)
        .bind(phone)
        .bind(now_ms)
        .execute(&mut *tx)
        .await?;
        if primary_phone.is_none() {
            primary_phone = Some(phone_id);
        }
    }
    if primary_email.is_some() || primary_phone.is_some() {
        sqlx::query(
            "UPDATE users SET primary_email_address_id = $1, primary_phone_number_id = $2, \
             updated_at = $3 WHERE id = $4",
        )
        .bind(&primary_email)
        .bind(&primary_phone)
        .bind(now_ms)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }

    let user = orbitid_identity::users::require_user_on(&mut tx, &id).await?;
    let json = orbitid_identity::serializers::serialize_user_on(
        &mut tx,
        &state,
        &user,
        UserSerializeOptions { backend: true },
    )
    .await?;
    let value = to_value(&json)?;
    orbitid_platform::webhooks::emit_event_on(&mut tx, "user.created", value.clone()).await?;
    tx.commit().await?;
    // Every address is created verified: accept pending invitations and apply
    // verified-domain enrollment exactly as a self-service verification would
    // (retried and logged inside; a failure never fails the create).
    for email in &emails {
        let _ = orbitid_identity::orgs::on_user_email_verified(&state, &id, email).await;
    }
    audit(
        &state,
        AuditInput::new("user.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("user")
            .target_id(id.clone())
            .metadata(json!({ "email_addresses": emails, "username": username })),
    )
    .await;
    Ok(json_response(value))
}

fn missing_attr(field: &str) -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_PARAM_MISSING,
        format!("{field} is required on this instance."),
    )
    .with_meta(json!({ "param_name": field }))
}

fn has_duplicates(values: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    values.iter().any(|value| !seen.insert(value))
}
