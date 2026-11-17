//! Backend API waitlist management (`/v1/waitlist_entries`).

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{InvitationRow, WaitlistEntryRow};
use orbitid_core::state::AppState;
use orbitid_identity::restrictions::serialize_invitation;
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::{json, Value};

use super::invitations::CreateInvitationInput;
use crate::invitations::finish_invitation;
use crate::shared::{
    deleted_object, fetch_all, fetch_count, json_response, normalize_email, order_clause,
    paginated, to_value, Bind, QueryPairs, Where,
};

const WAITLIST_ORDER_COLUMNS: &[(&str, &str)] = &[
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
    ("email", "email"),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/waitlist_entries", get(list).post(create))
        .route("/v1/waitlist_entries/{id}", delete(remove))
        .route("/v1/waitlist_entries/{id}/invite", post(invite))
        .route("/v1/waitlist_entries/{id}/reject", post(reject))
}

async fn serialize_entry(state: &AppState, row: &WaitlistEntryRow) -> Result<Value> {
    let invitation = match &row.invitation_id {
        Some(id) => {
            sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    entry_value(row, invitation.as_ref())
}

fn entry_value(row: &WaitlistEntryRow, invitation: Option<&InvitationRow>) -> Result<Value> {
    Ok(json!({
        "object": "waitlist_entry",
        "id": row.id,
        "email_address": row.email,
        "status": row.status,
        "invitation": match invitation {
            Some(invitation) => to_value(serialize_invitation(invitation))?,
            None => Value::Null,
        },
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }))
}

async fn entry_or_throw(state: &AppState, id: &str) -> Result<WaitlistEntryRow> {
    sqlx::query_as::<_, WaitlistEntryRow>("SELECT * FROM waitlist_entries WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Waitlist entry not found.")
        })
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut filter = Where::new();
    if let Some(status) = query.raw("status") {
        filter.equal_text("status", status);
    }
    if let Some(search) = query.raw("query").map(str::trim).filter(|q| !q.is_empty()) {
        let slot = filter.bind_text(orbitid_core::db::helpers::contains_pattern(search));
        filter
            .clauses
            .push(format!("lower(email) LIKE {slot} ESCAPE '\\'"));
    }
    let order = order_clause(
        list.order_by.as_deref(),
        WAITLIST_ORDER_COLUMNS,
        "-created_at",
    );
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM waitlist_entries{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    let rows: Vec<WaitlistEntryRow> = fetch_all(&state.pool, &sql, &binds).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM waitlist_entries{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let mut data = Vec::with_capacity(rows.len());
    for row in &rows {
        data.push(serialize_entry(&state, row).await?);
    }
    Ok(json_response(paginated(Value::Array(data), total)))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    email_address: String,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let email = normalize_email(&body.email_address);
    if !orbitid_identity::users::is_valid_email(&email) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_address must be an email address",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    let (id, value) = {
        let mut tx = state.pool.begin().await?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM waitlist_entries WHERE email = $1")
                .bind(&email)
                .fetch_optional(&mut *tx)
                .await?;
        if existing.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::DUPLICATE_RECORD,
                "This email address is already on the waitlist.",
            )
            .with_meta(json!({ "param_name": "email_address" })));
        }
        let row = orbitid_identity::restrictions::create_waitlist_entry_on(&mut tx, &email).await?;
        let value = entry_value(&row, None)?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "waitlistEntry.created", value.clone())
            .await?;
        tx.commit().await?;
        (row.id, value)
    };
    audit(
        &state,
        AuditInput::new("waitlist_entry.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("waitlist_entry")
            .target_id(id)
            .metadata(json!({ "email_address": email })),
    )
    .await;
    Ok(json_response(value))
}

async fn invite(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    // One transaction: the entry lock, the invitation insert, the status change
    // and both event rows. The e-mail is sent after commit.
    let (row, created, value) = {
        let mut tx = state.pool.begin().await?;
        let row = sqlx::query_as::<_, WaitlistEntryRow>(
            "SELECT * FROM waitlist_entries WHERE id = $1 FOR UPDATE",
        )
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Waitlist entry not found.")
        })?;
        if row.status == "completed" {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                "This waitlist entry has already signed up.",
            ));
        }
        orbitid_identity::lookups_bapi::lock_instance_invitations_on(&mut tx).await?;
        let input = CreateInvitationInput {
            email: row.email.clone(),
            public_metadata: None,
            redirect_url: None,
            notify: true,
            ignore_existing: true,
            expires_in_days: None,
            email_template: Some(orbitid_platform::mail::EmailTemplate::WaitlistInvited),
        };
        let created = crate::invitations::insert_invitation_on(&mut tx, &state, &input, false)
            .await?
            .ok_or_else(|| OrbitError::internal("invitation insert skipped"))?;
        let updated = orbitid_identity::restrictions::set_waitlist_entry_status_on(
            &mut tx,
            &row.id,
            "invited",
            Some(&created.row.id),
        )
        .await?
        .ok_or_else(|| OrbitError::internal("waitlist entry disappeared"))?;
        let mut value = entry_value(&updated, Some(&created.row))?;
        if let Some(invitation) = value.get_mut("invitation").and_then(Value::as_object_mut) {
            invitation.insert("url".into(), json!(created.url));
        }
        orbitid_platform::webhooks::emit_event_on(&mut tx, "waitlistEntry.updated", value.clone())
            .await?;
        tx.commit().await?;
        (row, created, value)
    };
    finish_invitation(
        &state,
        &row.email,
        &created,
        true,
        Some(orbitid_platform::mail::EmailTemplate::WaitlistInvited),
    )
    .await;
    audit(
        &state,
        AuditInput::new("waitlist_entry.invited")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("waitlist_entry")
            .target_id(row.id.clone())
            .metadata(json!({ "invitation_id": created.row.id })),
    )
    .await;
    Ok(json_response(value))
}

async fn reject(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let (row, value) = {
        let mut tx = state.pool.begin().await?;
        let updated = orbitid_identity::restrictions::set_waitlist_entry_status_on(
            &mut tx, &id, "rejected", None,
        )
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Waitlist entry not found.")
        })?;
        let value = entry_value(&updated, None)?;
        orbitid_platform::webhooks::emit_event_on(&mut tx, "waitlistEntry.updated", value.clone())
            .await?;
        tx.commit().await?;
        (updated, value)
    };
    audit(
        &state,
        AuditInput::new("waitlist_entry.rejected")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("waitlist_entry")
            .target_id(row.id.clone()),
    )
    .await;
    Ok(json_response(value))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = entry_or_throw(&state, &id).await?;
    sqlx::query("DELETE FROM waitlist_entries WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("waitlist_entry.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("waitlist_entry")
            .target_id(row.id.clone())
            .metadata(json!({ "email_address": row.email })),
    )
    .await;
    Ok(json_response(deleted_object("waitlist_entry", &row.id)))
}
