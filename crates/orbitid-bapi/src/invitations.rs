//! Backend API instance invitations (`/v1/invitations`), including the shared
//! `createInvitation` helper used by waitlist invites and allowlist notices.

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::InvitationRow;
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_identity::restrictions::serialize_invitation;
use orbitid_platform::audit::{audit, AuditInput};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde::Deserialize;
use serde_json::json;

use crate::shared::{
    deserialize_bool, deserialize_opt_int, fetch_all, fetch_count, json_response, normalize_email,
    order_clause, paginated, ticket_url, to_value, validate_metadata, Bind, ListQuery, QueryPairs,
    Where,
};

const INVITATION_ORDER_COLUMNS: &[(&str, &str)] = &[
    ("created_at", "created_at"),
    ("updated_at", "updated_at"),
    ("email", "email"),
];

/// Input for [`create_invitation`].
#[derive(Debug, Clone)]
pub struct CreateInvitationInput {
    pub email: String,
    pub public_metadata: Option<Metadata>,
    pub redirect_url: Option<String>,
    pub notify: bool,
    pub ignore_existing: bool,
    pub expires_in_days: Option<i64>,
    pub email_template: Option<EmailTemplate>,
}

/// A created invitation plus its one-time ticket URL.
#[derive(Debug, Clone)]
pub struct CreatedInvitation {
    pub row: InvitationRow,
    pub url: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/invitations", get(list).post(create))
        .route("/v1/invitations/bulk", post(bulk))
        .route("/v1/invitations/{id}", get(read))
        .route("/v1/invitations/{id}/revoke", post(revoke))
}

/// Creates an instance invitation (also used by waitlist invites and allowlist
/// notifications).
///
/// The pending-invitation check and the insert share one transaction guarded by
/// an advisory lock (the table has no unique `(email, status)` constraint), and
/// the `invitation.created` event commits with the row. The e-mail and audit
/// entry are post-commit best-effort.
pub async fn create_invitation(
    state: &AppState,
    input: CreateInvitationInput,
) -> Result<CreatedInvitation> {
    let email = normalize_email(&input.email);
    let created = {
        let mut tx = state.pool.begin().await?;
        orbitid_identity::lookups_bapi::lock_instance_invitations_on(&mut tx).await?;
        let created = insert_invitation_on(&mut tx, state, &input, false).await?;
        tx.commit().await?;
        created
    };
    let Some(created) = created else {
        return Err(OrbitError::unprocessable(
            error_codes::DUPLICATE_RECORD,
            format!("There is already a pending invitation for {email}."),
        )
        .with_meta(json!({ "param_name": "email_address" })));
    };
    finish_invitation(state, &email, &created, input.notify, input.email_template).await;
    Ok(created)
}

/// Inserts one invitation on the caller's connection. Returns `Ok(None)` when
/// `skip_existing` is set and a pending invitation already exists.
pub(crate) async fn insert_invitation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    input: &CreateInvitationInput,
    skip_existing: bool,
) -> Result<Option<CreatedInvitation>> {
    let email = normalize_email(&input.email);
    if orbitid_identity::lookups_bapi::pending_invitation_on(conn, &email)
        .await?
        .is_some()
    {
        if skip_existing {
            return Ok(None);
        }
        if !input.ignore_existing {
            return Err(OrbitError::unprocessable(
                error_codes::DUPLICATE_RECORD,
                format!("There is already a pending invitation for {email}."),
            )
            .with_meta(json!({ "param_name": "email_address" })));
        }
    }
    let (row, ticket) = orbitid_identity::restrictions::create_invitation_on(
        conn,
        state,
        &email,
        input.public_metadata.clone(),
        input.redirect_url.as_deref(),
        input.expires_in_days,
    )
    .await?;
    let sign_up_url = ticket_url(state, "/sign-up", &ticket);
    let url = match &row.redirect_url {
        Some(redirect) => format!(
            "{sign_up_url}&redirect_url={}",
            percent_encoding::utf8_percent_encode(redirect, percent_encoding::NON_ALPHANUMERIC)
        ),
        None => sign_up_url,
    };
    Ok(Some(CreatedInvitation { row, url }))
}

/// Post-commit e-mail and audit entry for a created invitation.
pub(crate) async fn finish_invitation(
    state: &AppState,
    email: &str,
    created: &CreatedInvitation,
    notify: bool,
    template: Option<EmailTemplate>,
) {
    if notify {
        let mut vars = serde_json::Map::new();
        vars.insert("invitation_url".into(), json!(created.url));
        vars.insert(
            "app_name".into(),
            json!(state.settings.get().application.name),
        );
        send_email(
            state,
            SendEmailInput {
                to: email.to_string(),
                template: template.unwrap_or(EmailTemplate::Invitation),
                vars,
            },
        )
        .await;
    }
    audit(
        state,
        AuditInput::new("invitation.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("invitation")
            .target_id(created.row.id.clone())
            .metadata(json!({ "email_address": email })),
    )
    .await;
}

fn invitation_json(created: &CreatedInvitation) -> Result<serde_json::Value> {
    let mut value = to_value(serialize_invitation(&created.row))?;
    if let Some(object) = value.as_object_mut() {
        object.insert("url".into(), json!(created.url));
    }
    Ok(value)
}

fn validate_email(value: &str, param: &str) -> Result<String> {
    let trimmed = value.trim();
    if !orbitid_identity::users::is_valid_email(trimmed) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must be an email address"),
        )
        .with_meta(json!({ "param_name": param })));
    }
    Ok(normalize_email(trimmed))
}

fn validate_url(value: &str, param: &str) -> Result<String> {
    match url::Url::parse(value) {
        Ok(parsed) if parsed.scheme() == "http" || parsed.scheme() == "https" => {
            Ok(value.to_string())
        }
        _ => Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("{param} must be a URL"),
        )
        .with_meta(json!({ "param_name": param }))),
    }
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    email_address: String,
    public_metadata: Option<Metadata>,
    redirect_url: Option<String>,
    #[serde(default = "default_true", deserialize_with = "deserialize_bool")]
    notify: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    ignore_existing: bool,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_in_days: Option<i64>,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let email = validate_email(&body.email_address, "email_address")?;
    if let Some(metadata) = &body.public_metadata {
        validate_metadata(metadata)?;
    }
    let redirect_url = body
        .redirect_url
        .as_deref()
        .map(|url| validate_url(url, "redirect_url"))
        .transpose()?;
    if let Some(days) = body.expires_in_days {
        check_days(days)?;
    }
    let created = create_invitation(
        &state,
        CreateInvitationInput {
            email,
            public_metadata: body.public_metadata,
            redirect_url,
            notify: body.notify,
            ignore_existing: body.ignore_existing,
            expires_in_days: body.expires_in_days,
            email_template: None,
        },
    )
    .await?;
    Ok(json_response(invitation_json(&created)?))
}

#[derive(Debug, Deserialize)]
struct BulkBody {
    email_addresses: Vec<String>,
    public_metadata: Option<Metadata>,
    redirect_url: Option<String>,
    #[serde(default = "default_true", deserialize_with = "deserialize_bool")]
    notify: bool,
    #[serde(default, deserialize_with = "deserialize_bool")]
    ignore_existing: bool,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    expires_in_days: Option<i64>,
}

async fn bulk(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<BulkBody>,
) -> Result<Response> {
    if body.email_addresses.is_empty() || body.email_addresses.len() > 100 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_addresses must contain between 1 and 100 addresses",
        )
        .with_meta(json!({ "param_name": "email_addresses" })));
    }
    let emails: Vec<String> = body
        .email_addresses
        .iter()
        .map(|email| validate_email(email, "email_addresses"))
        .collect::<Result<Vec<_>>>()?;
    if let Some(metadata) = &body.public_metadata {
        validate_metadata(metadata)?;
    }
    let redirect_url = body
        .redirect_url
        .as_deref()
        .map(|url| validate_url(url, "redirect_url"))
        .transpose()?;
    if let Some(days) = body.expires_in_days {
        check_days(days)?;
    }
    let created = {
        let mut tx = state.pool.begin().await?;
        orbitid_identity::lookups_bapi::lock_instance_invitations_on(&mut tx).await?;
        let mut pending = Vec::new();
        for email in emails {
            let input = CreateInvitationInput {
                email,
                public_metadata: body.public_metadata.clone(),
                redirect_url: redirect_url.clone(),
                notify: body.notify,
                ignore_existing: body.ignore_existing,
                expires_in_days: body.expires_in_days,
                email_template: None,
            };
            if let Some(inserted) = insert_invitation_on(&mut tx, &state, &input, true).await? {
                pending.push((normalize_email(&input.email), inserted));
            }
        }
        tx.commit().await?;
        pending
    };
    let mut out = Vec::with_capacity(created.len());
    for (email, invitation) in created {
        finish_invitation(&state, &email, &invitation, body.notify, None).await;
        out.push(invitation_json(&invitation)?);
    }
    Ok(json_response(serde_json::Value::Array(out)))
}

fn default_true() -> bool {
    true
}

fn check_days(days: i64) -> Result<()> {
    if !(1..=365).contains(&days) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "expires_in_days must be between 1 and 365",
        )
        .with_meta(json!({ "param_name": "expires_in_days" })));
    }
    Ok(())
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let mut filter = Where::new();
    if let Some(status) = query.raw("status").or_else(|| query.raw("status[]")) {
        filter.equal_text("status", status);
    }
    if let Some(search) = query.raw("query").map(str::trim).filter(|q| !q.is_empty()) {
        let slot = filter.bind_text(orbitid_core::db::helpers::contains_pattern(search));
        filter
            .clauses
            .push(format!("lower(email) LIKE {slot} ESCAPE '\\'"));
    }
    let rows = fetch_page(&state, &filter, &list).await?;
    let total = fetch_count(
        &state.pool,
        &format!("SELECT count(*) FROM invitations{}", filter.sql()),
        &filter.binds,
    )
    .await?;
    let data = rows
        .iter()
        .map(serialize_invitation)
        .map(to_value)
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

async fn fetch_page(
    state: &AppState,
    filter: &Where,
    list: &ListQuery,
) -> Result<Vec<InvitationRow>> {
    let order = order_clause(
        list.order_by.as_deref(),
        INVITATION_ORDER_COLUMNS,
        "-created_at",
    );
    let mut binds = filter.binds.clone();
    binds.push(Bind::Int(list.limit));
    let limit_slot = binds.len();
    binds.push(Bind::Int(list.offset));
    let offset_slot = binds.len();
    let sql = format!(
        "SELECT * FROM invitations{} ORDER BY {order} LIMIT ${limit_slot} OFFSET ${offset_slot}",
        filter.sql()
    );
    fetch_all(&state.pool, &sql, &binds).await
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = invitation_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_invitation(&row))?))
}

async fn revoke(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = {
        let mut tx = state.pool.begin().await?;
        let row = sqlx::query_as::<_, InvitationRow>(
            "SELECT * FROM invitations WHERE id = $1 FOR UPDATE",
        )
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Invitation not found.")
        })?;
        let revoked = orbitid_identity::restrictions::revoke_invitation_on(&mut tx, &row).await?;
        tx.commit().await?;
        revoked
    };
    audit(
        &state,
        AuditInput::new("invitation.revoked")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("invitation")
            .target_id(row.id.clone())
            .metadata(json!({ "email_address": row.email })),
    )
    .await;
    Ok(json_response(to_value(serialize_invitation(&row))?))
}

async fn invitation_or_throw(state: &AppState, id: &str) -> Result<InvitationRow> {
    sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Invitation not found.")
        })
}
