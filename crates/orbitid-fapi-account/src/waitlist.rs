//! Frontend API waitlist collection (`modules/waitlist-client.ts`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{client_ip, now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{InvitationRow, WaitlistEntryRow};
use orbitid_core::resources::{
    InvitationJson, InvitationStatus, WaitlistEntryJson, WaitlistStatus,
};
use orbitid_core::settings::types::SignUpMode;
use orbitid_core::state::AppState;
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;

use crate::reply::json_reply;

pub fn router() -> axum::Router<AppState> {
    axum::Router::new().route(
        "/v1/client/waitlist",
        axum::routing::post(create_waitlist_entry),
    )
}

#[derive(Debug, Deserialize)]
pub struct WaitlistBody {
    pub email_address: String,
}

/// `normalizeEmail` from `modules/admin/shared.ts`.
fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

fn invitation_status(row: &InvitationRow) -> InvitationStatus {
    let expired = row.status == "pending" && row.expires_at.map(|at| at <= now()).unwrap_or(false);
    if expired {
        return InvitationStatus::Expired;
    }
    match row.status.as_str() {
        "accepted" => InvitationStatus::Accepted,
        "revoked" => InvitationStatus::Revoked,
        "expired" => InvitationStatus::Expired,
        _ => InvitationStatus::Pending,
    }
}

/// `serializeInvitation` from `services/restrictions.ts`.
fn serialize_invitation(row: &InvitationRow) -> InvitationJson {
    InvitationJson {
        object: "invitation".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        status: invitation_status(row),
        url: None,
        public_metadata: row.public_metadata.0.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
    }
}

/// `serializeWaitlistEntry` from `modules/admin/waitlist.ts`, on the caller's
/// connection so the payload used by the event and the insert agree.
async fn serialize_waitlist_entry_on(
    conn: &mut sqlx::PgConnection,
    row: &WaitlistEntryRow,
) -> Result<WaitlistEntryJson> {
    let invitation = match &row.invitation_id {
        Some(id) => {
            sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await?
        }
        None => None,
    };
    let status = match row.status.as_str() {
        "invited" => WaitlistStatus::Invited,
        "completed" => WaitlistStatus::Completed,
        "rejected" => WaitlistStatus::Rejected,
        _ => WaitlistStatus::Pending,
    };
    Ok(WaitlistEntryJson {
        object: "waitlist_entry".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        status,
        invitation: invitation.as_ref().map(serialize_invitation),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// `serializeWaitlistEntry` from `modules/admin/waitlist.ts`.
async fn serialize_waitlist_entry(
    state: &AppState,
    row: &WaitlistEntryRow,
) -> Result<WaitlistEntryJson> {
    let invitation = match &row.invitation_id {
        Some(id) => {
            sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.pool)
                .await?
        }
        None => None,
    };
    let status = match row.status.as_str() {
        "invited" => WaitlistStatus::Invited,
        "completed" => WaitlistStatus::Completed,
        "rejected" => WaitlistStatus::Rejected,
        _ => WaitlistStatus::Pending,
    };
    Ok(WaitlistEntryJson {
        object: "waitlist_entry".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        status,
        invitation: invitation.as_ref().map(serialize_invitation),
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn create_waitlist_entry(
    State(state): State<AppState>,
    headers: HeaderMap,
    OrbitJson(body): OrbitJson<WaitlistBody>,
) -> Result<Response> {
    if state.settings.get().sign_up.mode != SignUpMode::Waitlist {
        return Err(OrbitError::unprocessable(
            error_codes::SIGN_UP_MODE_RESTRICTED,
            "The waitlist is not enabled for this instance.",
        ));
    }
    let ip = client_ip(&headers, None, state.env.trust_proxy);
    orbitid_core::http::hit(&state, &format!("waitlist:{ip}"), 5, 3_600_000).await?;
    crate::me::shared::assert_max_chars(&body.email_address, 320, "email_address")?;
    let email = normalize_email(&body.email_address);
    if !orbitid_identity::users::is_valid_email(&email) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_address is not a valid email address",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    // Idempotent upsert on the unique email: concurrent joins yield one row and
    // exactly one `waitlistEntry.created` event, written in the same
    // transaction as the insert.
    let now_ms = now();
    let id = new_id(id_prefix::WAITLIST);
    let mut tx = state.pool.begin().await?;
    let inserted = sqlx::query_as::<_, WaitlistEntryRow>(
        "INSERT INTO waitlist_entries (id, email, status, created_at, updated_at) \
         VALUES ($1,$2,'pending',$3,$3) ON CONFLICT (email) DO NOTHING RETURNING *",
    )
    .bind(&id)
    .bind(&email)
    .bind(now_ms)
    .fetch_optional(&mut *tx)
    .await?;
    let row = match inserted {
        Some(row) => {
            let json = serde_json::to_value(serialize_waitlist_entry_on(&mut tx, &row).await?)
                .unwrap_or_default();
            orbitid_platform::webhooks::emit_event_on(&mut tx, "waitlistEntry.created", json)
                .await?;
            row
        }
        None => {
            sqlx::query_as::<_, WaitlistEntryRow>("SELECT * FROM waitlist_entries WHERE email = $1")
                .bind(&email)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    tx.commit().await?;
    let json_value = serialize_waitlist_entry(&state, &row).await?;
    audit(
        &state,
        AuditInput::new("waitlist_entry.created")
            .actor("anonymous")
            .target_type("waitlist_entry")
            .target_id(row.id.clone())
            .metadata(json!({ "email_address": email })),
    )
    .await;
    Ok(json_reply(json!({ "response": json_value }), Vec::new()))
}
