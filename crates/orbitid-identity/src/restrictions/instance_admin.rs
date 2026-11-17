//! Transaction-safe instance administration helpers: invitations, the
//! allow/block lists and the waitlist. Every helper runs on the caller's
//! connection so the row change and its webhook event commit together.

use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{
    AllowlistIdentifierRow, BlocklistIdentifierRow, InvitationRow, WaitlistEntryRow,
};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use crate::org_domains::normalize_email;
use crate::restrictions::serialize_invitation;

/// `email_address`, `phone_number` or `""` for the instance list tables.
pub fn identifier_kind(identifier: &str) -> &'static str {
    if identifier.contains('@') {
        "email_address"
    } else if identifier
        .chars()
        .next()
        .is_some_and(|ch| ch.is_ascii_digit() || ch == '+')
    {
        "phone_number"
    } else {
        ""
    }
}

/// Creates one instance invitation inside the caller's transaction. The
/// `invitation.created` event (with its ticket URL) commits with the row; the
/// caller sends the e-mail and writes the audit entry after commit.
pub async fn create_invitation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    email: &str,
    public_metadata: Option<Metadata>,
    redirect_url: Option<&str>,
    expires_in_days: Option<i64>,
) -> Result<(InvitationRow, String)> {
    let email = normalize_email(email)?;
    let ticket = orbitid_core::crypto::random_token(32);
    let now_ms = now();
    let row = sqlx::query_as::<_, InvitationRow>(
        "INSERT INTO invitations (id, email, status, token_hash, redirect_url, public_metadata, \
         expires_at, created_at, updated_at) \
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$7) RETURNING *",
    )
    .bind(new_id(id_prefix::APP_INVITATION))
    .bind(&email)
    .bind(orbitid_core::crypto::sha256(&ticket))
    .bind(redirect_url)
    .bind(sqlx::types::Json(public_metadata.unwrap_or_default()))
    .bind(now_ms + expires_in_days.unwrap_or(30) * 86_400_000)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?;
    let url = invitation_ticket_url(state, &ticket);
    let mut payload = serde_json::to_value(serialize_invitation(&row)).unwrap_or_default();
    if let Some(object) = payload.as_object_mut() {
        object.insert("url".into(), serde_json::json!(url));
    }
    emit_event_on(conn, "invitation.created", payload).await?;
    Ok((row, ticket))
}

fn invitation_ticket_url(state: &AppState, ticket: &str) -> String {
    let settings = state.settings.get();
    let base = settings.application.home_url.trim_end_matches('/');
    format!(
        "{base}/sign-up?__orbit_ticket={}",
        percent_encoding::utf8_percent_encode(ticket, percent_encoding::NON_ALPHANUMERIC)
    )
}

/// Marks a pending instance invitation revoked and emits `invitation.revoked`
/// in the same transaction. An invitation that is not pending is returned
/// unchanged without a second event.
pub async fn revoke_invitation_on(
    conn: &mut sqlx::PgConnection,
    invitation: &InvitationRow,
) -> Result<InvitationRow> {
    let revoked = sqlx::query_as::<_, InvitationRow>(
        "UPDATE invitations SET status = 'revoked', updated_at = $1 \
         WHERE id = $2 AND status = 'pending' RETURNING *",
    )
    .bind(now())
    .bind(&invitation.id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = revoked else {
        return Ok(
            sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE id = $1")
                .bind(&invitation.id)
                .fetch_one(&mut *conn)
                .await?,
        );
    };
    emit_event_on(
        conn,
        "invitation.revoked",
        serde_json::to_value(serialize_invitation(&row)).unwrap_or_default(),
    )
    .await?;
    Ok(row)
}

/// Creates an allowlist entry inside the caller's transaction.
pub async fn create_allowlist_identifier_on(
    conn: &mut sqlx::PgConnection,
    identifier: &str,
    invitation_id: Option<&str>,
) -> Result<AllowlistIdentifierRow> {
    let now_ms = now();
    Ok(sqlx::query_as::<_, AllowlistIdentifierRow>(
        "INSERT INTO allowlist_identifiers (id, identifier, identifier_type, invitation_id, \
         created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *",
    )
    .bind(new_id(id_prefix::ALLOW))
    .bind(identifier)
    .bind(identifier_kind(identifier))
    .bind(invitation_id)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}

/// Deletes an allowlist entry inside the caller's transaction.
pub async fn delete_allowlist_identifier_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<AllowlistIdentifierRow>> {
    Ok(sqlx::query_as::<_, AllowlistIdentifierRow>(
        "DELETE FROM allowlist_identifiers WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Creates a blocklist entry inside the caller's transaction.
pub async fn create_blocklist_identifier_on(
    conn: &mut sqlx::PgConnection,
    identifier: &str,
) -> Result<BlocklistIdentifierRow> {
    let now_ms = now();
    Ok(sqlx::query_as::<_, BlocklistIdentifierRow>(
        "INSERT INTO blocklist_identifiers (id, identifier, identifier_type, created_at, \
         updated_at) VALUES ($1,$2,$3,$4,$4) RETURNING *",
    )
    .bind(new_id(id_prefix::BLOCK))
    .bind(identifier)
    .bind(identifier_kind(identifier))
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}

/// Deletes a blocklist entry inside the caller's transaction.
pub async fn delete_blocklist_identifier_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<BlocklistIdentifierRow>> {
    Ok(sqlx::query_as::<_, BlocklistIdentifierRow>(
        "DELETE FROM blocklist_identifiers WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Creates a waitlist entry inside the caller's transaction.
pub async fn create_waitlist_entry_on(
    conn: &mut sqlx::PgConnection,
    email: &str,
) -> Result<WaitlistEntryRow> {
    let now_ms = now();
    Ok(sqlx::query_as::<_, WaitlistEntryRow>(
        "INSERT INTO waitlist_entries (id, email, status, created_at, updated_at) \
         VALUES ($1,$2,'pending',$3,$3) RETURNING *",
    )
    .bind(new_id(id_prefix::WAITLIST))
    .bind(email)
    .bind(now_ms)
    .fetch_one(&mut *conn)
    .await?)
}

/// Sets a waitlist entry's status/invitation in the caller's transaction.
pub async fn set_waitlist_entry_status_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
    status: &str,
    invitation_id: Option<&str>,
) -> Result<Option<WaitlistEntryRow>> {
    Ok(sqlx::query_as::<_, WaitlistEntryRow>(
        "UPDATE waitlist_entries SET status = $1, invitation_id = $2, updated_at = $3 \
         WHERE id = $4 RETURNING *",
    )
    .bind(status)
    .bind(invitation_id)
    .bind(now())
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Deletes a waitlist entry inside the caller's transaction.
pub async fn delete_waitlist_entry_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
) -> Result<Option<WaitlistEntryRow>> {
    Ok(sqlx::query_as::<_, WaitlistEntryRow>(
        "DELETE FROM waitlist_entries WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?)
}
