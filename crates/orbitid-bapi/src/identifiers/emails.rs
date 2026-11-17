use axum::extract::{Path, State};
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow};
use orbitid_core::state::AppState;
use orbitid_identity::admin::refuse_user_credential_mutation;
use orbitid_identity::serializers::{serialize_email, serialize_phone};
use serde::Deserialize;

use crate::shared::{
    deserialize_bool, fetch_all, fetch_count, get_user_or_throw, json_response, normalize_email,
    paginated, to_value, Bind, QueryPairs,
};

pub(super) async fn list_emails(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let mut filter = crate::shared::Where::new();
    if let Some(user_id) = query.raw("user_id") {
        filter.equal_text("user_id", user_id);
    }
    if let Some(email) = query.raw("email_address") {
        filter.equal_text("email", &normalize_email(email));
    }
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM email_addresses{} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<EmailAddressRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM email_addresses{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let data = rows
        .iter()
        .map(serialize_email)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

pub(super) async fn read_email(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row = email_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_email(&row))?))
}

#[derive(Debug, Deserialize)]
pub(super) struct CreateEmailBody {
    user_id: String,
    email_address: String,
    #[serde(default, deserialize_with = "deserialize_bool")]
    verified: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    primary: bool,
}

pub(super) async fn create_email(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateEmailBody>,
) -> Result<Response> {
    let _ = (body.verified, body.primary, &body.email_address);
    get_user_or_throw(&state, &body.user_id).await?;
    Err(refuse_identifier_write(
        "attach an email address to an existing user (verified or not)",
    ))
}

pub(super) async fn patch_email(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    email_or_throw(&state, &id).await?;
    Err(refuse_identifier_write(
        "verify, unverify or promote an email address as the primary sign-in identifier",
    ))
}

pub(super) async fn delete_email(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    email_or_throw(&state, &id).await?;
    Err(refuse_identifier_write(
        "delete one of the user's email addresses",
    ))
}

fn refuse_identifier_write(what: &str) -> OrbitError {
    refuse_user_credential_mutation(
        what,
        "the /email_addresses and /phone_numbers routes of the Frontend API (/me)",
    )
}

async fn email_or_throw(state: &AppState, id: &str) -> Result<EmailAddressRow> {
    sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Email address not found.")
        })
}

// ───────────── phone numbers ─────────────

pub(super) async fn list_phones(
    State(state): State<AppState>,
    query: QueryPairs,
) -> Result<Response> {
    let list = query.list()?;
    let mut filter = crate::shared::Where::new();
    if let Some(user_id) = query.raw("user_id") {
        filter.equal_text("user_id", user_id);
    }
    if let Some(phone) = query.raw("phone_number") {
        filter.equal_text("phone", phone.trim());
    }
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM phone_numbers{} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<PhoneNumberRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM phone_numbers{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let data = rows
        .iter()
        .map(serialize_phone)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

pub(super) async fn read_phone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    let row = phone_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_phone(&row))?))
}

#[derive(Debug, Deserialize)]
pub(super) struct CreatePhoneBody {
    user_id: String,
    phone_number: String,
    #[serde(default, deserialize_with = "deserialize_bool")]
    verified: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    primary: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    reserved_for_second_factor: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    default_second_factor: bool,
}

pub(super) async fn create_phone(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreatePhoneBody>,
) -> Result<Response> {
    let _ = (
        body.verified,
        body.primary,
        body.reserved_for_second_factor,
        body.default_second_factor,
        &body.phone_number,
    );
    get_user_or_throw(&state, &body.user_id).await?;
    Err(refuse_identifier_write(
        "attach a phone number to an existing user, including as a second factor",
    ))
}

pub(super) async fn patch_phone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    phone_or_throw(&state, &id).await?;
    Err(refuse_identifier_write(
        "verify, promote or turn a phone number into the user's second factor",
    ))
}

pub(super) async fn delete_phone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response> {
    phone_or_throw(&state, &id).await?;
    Err(refuse_identifier_write(
        "delete one of the user's phone numbers",
    ))
}

async fn phone_or_throw(state: &AppState, id: &str) -> Result<PhoneNumberRow> {
    sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found.")
        })
}

// ───────────── allowlist ─────────────
