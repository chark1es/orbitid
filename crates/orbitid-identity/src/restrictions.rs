//! Sign-up gating (mode/allowlist/blocklist/waitlist/invitations) and one-time
//! tickets, ported from `services/restrictions.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::InvitationRow;
use orbitid_core::resources::{InvitationJson, InvitationStatus, Metadata};
use orbitid_core::state::AppState;
use orbitid_platform::webhooks::emit_event_on;

use crate::org_domains::{email_domain, normalize_email};

/// Frequently abused throwaway providers; consulted only when
/// `settings.restrictions.blockDisposableEmailDomains`.
pub const DISPOSABLE_EMAIL_DOMAINS: &[&str] = &[
    "10minutemail.com",
    "20minutemail.com",
    "33mail.com",
    "burnermail.io",
    "discard.email",
    "dispostable.com",
    "emailfake.com",
    "emailondeck.com",
    "eyepaste.com",
    "fake-mail.net",
    "fakeinbox.com",
    "generator.email",
    "getairmail.com",
    "getnada.com",
    "grr.la",
    "guerrillamail.biz",
    "guerrillamail.com",
    "guerrillamail.de",
    "guerrillamail.info",
    "guerrillamail.net",
    "guerrillamail.org",
    "guerrillamailblock.com",
    "harakirimail.com",
    "inboxbear.com",
    "klzlk.com",
    "luxusmail.org",
    "mail-temp.com",
    "mailcatch.com",
    "maildrop.cc",
    "mailforspam.com",
    "mailinator.com",
    "mailinator2.com",
    "mailnesia.com",
    "mailsac.com",
    "mintemail.com",
    "moakt.com",
    "mohmal.com",
    "mytemp.email",
    "notmailinator.com",
    "reallymymail.com",
    "sharklasers.com",
    "sogetthis.com",
    "spam.la",
    "spam4.me",
    "spamfree24.org",
    "spamgourmet.com",
    "spamhereplease.com",
    "temp-mail.org",
    "tempail.com",
    "tempmail.com",
    "tempmailo.com",
    "tempsky.com",
    "temporarymail.com",
    "thisisnotmyrealemail.com",
    "throwaway.email",
    "throwawaymail.com",
    "trash-mail.com",
    "trashmail.com",
    "wegwerfemail.de",
    "yopmail.com",
];

/// Identifiers presented to a sign-up/sign-in screen.
#[derive(Debug, Clone, Default)]
pub struct IdentifiersToCheck {
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    pub invitation_ticket: Option<String>,
}

/// A ticket only ever grants an invitation; operator-minted sign-in tokens are
/// no longer honoured anywhere.
#[derive(Debug, Clone)]
pub struct TicketGrant {
    pub kind: String,
    pub invitation_id: String,
    pub email: String,
    pub public_metadata: Metadata,
}

/// Result of [`assert_identifiers_allowed`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowedIdentifiers {
    pub invitation_id: Option<String>,
}

fn identifier_matches(identifier: &str, email: Option<&str>, phone: Option<&str>) -> bool {
    let id = identifier.trim().to_lowercase();
    if let Some(email) = email {
        if id == email {
            return true;
        }
        if let Some(domain) = id.strip_prefix("*@") {
            if email_domain(email) == domain {
                return true;
            }
        }
        if let Some(domain) = id.strip_prefix('@') {
            if email_domain(email) == domain {
                return true;
            }
        }
    }
    if let Some(phone) = phone {
        if id == phone.trim() {
            return true;
        }
    }
    false
}

async fn allowlist_matches(state: &AppState, emails: &[String], phones: &[String]) -> Result<bool> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT identifier FROM allowlist_identifiers")
        .fetch_all(&state.pool)
        .await?;
    Ok(rows.iter().any(|row| {
        emails
            .iter()
            .any(|email| identifier_matches(row, Some(email), None))
            || phones
                .iter()
                .any(|phone| identifier_matches(row, None, Some(phone)))
    }))
}

async fn blocklist_matches(
    state: &AppState,
    emails: &[String],
    phones: &[String],
) -> Result<Option<String>> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT identifier FROM blocklist_identifiers")
        .fetch_all(&state.pool)
        .await?;
    for row in rows {
        if emails
            .iter()
            .any(|email| identifier_matches(&row, Some(email), None))
            || phones
                .iter()
                .any(|phone| identifier_matches(&row, None, Some(phone)))
        {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

/// Pending, unexpired instance invitation for `email` (lowercased comparison).
pub async fn pending_invitation_for(
    state: &AppState,
    email: &str,
) -> Result<Option<InvitationRow>> {
    let normalized = normalize_email(email).unwrap_or_else(|_| email.trim().to_lowercase());
    let rows = sqlx::query_as::<_, InvitationRow>(
        "SELECT * FROM invitations WHERE email = $1 AND status = 'pending'",
    )
    .bind(normalized)
    .fetch_all(&state.pool)
    .await?;
    let now_ms = now();
    Ok(rows
        .into_iter()
        .find(|row| row.expires_at.map(|at| at > now_ms).unwrap_or(true)))
}

pub fn serialize_invitation(row: &InvitationRow) -> InvitationJson {
    let expired = row.status == "pending" && row.expires_at.map(|at| at <= now()) == Some(true);
    let status = if expired {
        InvitationStatus::Expired
    } else {
        match row.status.as_str() {
            "accepted" => InvitationStatus::Accepted,
            "revoked" => InvitationStatus::Revoked,
            "expired" => InvitationStatus::Expired,
            _ => InvitationStatus::Pending,
        }
    };
    InvitationJson {
        object: "invitation".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        status,
        url: None,
        public_metadata: row.public_metadata.0.clone(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
    }
}

/// Validates a one-time invitation ticket without consuming it.
pub async fn validate_ticket(state: &AppState, ticket: &str) -> Result<TicketGrant> {
    let hash = orbitid_core::crypto::sha256(ticket);
    let now_ms = now();
    let invitation =
        sqlx::query_as::<_, InvitationRow>("SELECT * FROM invitations WHERE token_hash = $1")
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await?;
    let Some(invitation) = invitation else {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "This ticket is invalid.",
        ));
    };
    if invitation.status != "pending" {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_INVALID,
            "This invitation has already been used or revoked.",
        ));
    }
    if invitation.expires_at.map(|at| at <= now_ms) == Some(true) {
        return Err(OrbitError::unprocessable(
            error_codes::TICKET_EXPIRED,
            "This invitation has expired.",
        ));
    }
    Ok(TicketGrant {
        kind: "invitation".into(),
        invitation_id: invitation.id,
        email: invitation.email,
        public_metadata: invitation.public_metadata.0,
    })
}

/// Throws when sign-up of these identifiers is not permitted. Also enforces the
/// blocklist at sign-in when `sign_in` is true.
pub async fn assert_identifiers_allowed(
    state: &AppState,
    ids: &IdentifiersToCheck,
    sign_in: bool,
) -> Result<AllowedIdentifiers> {
    let settings = state.settings.get();
    let emails: Vec<String> = ids
        .emails
        .iter()
        .map(|email| normalize_email(email).unwrap_or_else(|_| email.trim().to_lowercase()))
        .filter(|email| !email.is_empty())
        .collect();
    let phones: Vec<String> = ids
        .phones
        .iter()
        .map(|phone| phone.trim().to_string())
        .filter(|phone| !phone.is_empty())
        .collect();
    if emails.is_empty() && phones.is_empty() {
        return Ok(AllowedIdentifiers::default());
    }

    let blocked = if settings.restrictions.blocklist_enabled {
        blocklist_matches(state, &emails, &phones).await?
    } else {
        None
    };
    if let Some(blocked) = blocked {
        return Err(OrbitError::unprocessable(
            error_codes::NOT_ALLOWED_ACCESS,
            format!("Access denied for {blocked}."),
        )
        .with_meta(serde_json::json!({ "param_name": "identifier" })));
    }
    if settings.restrictions.block_email_subaddresses {
        let bases: Vec<String> = emails
            .iter()
            .filter(|email| email.contains('+'))
            .map(|email| {
                let local = email.split('+').next().unwrap_or(email);
                format!("{local}@{}", email_domain(email))
            })
            .collect();
        if !bases.is_empty() && blocklist_matches(state, &bases, &[]).await?.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::NOT_ALLOWED_ACCESS,
                "Access denied: this email address is blocked.",
            )
            .with_meta(serde_json::json!({ "param_name": "email_address" })));
        }
    }
    if settings.restrictions.block_disposable_email_domains
        && emails
            .iter()
            .any(|email| DISPOSABLE_EMAIL_DOMAINS.contains(&email_domain(email).as_str()))
    {
        return Err(OrbitError::unprocessable(
            error_codes::NOT_ALLOWED_ACCESS,
            "Disposable email addresses are not allowed.",
        )
        .with_meta(serde_json::json!({ "param_name": "email_address" })));
    }

    if sign_in {
        return Ok(AllowedIdentifiers::default());
    }

    // A valid ticket proves the user was invited and bypasses every sign-up
    // restriction.
    if let Some(ticket) = &ids.invitation_ticket {
        let grant = validate_ticket(state, ticket).await?;
        return Ok(AllowedIdentifiers {
            invitation_id: Some(grant.invitation_id),
        });
    }

    let mode = settings.sign_up.mode;
    if mode == orbitid_core::settings::types::SignUpMode::Public
        && !settings.restrictions.allowlist_enabled
    {
        return Ok(AllowedIdentifiers::default());
    }

    let mut invitation: Option<InvitationRow> = None;
    for email in &emails {
        if let Some(found) = pending_invitation_for(state, email).await? {
            invitation = Some(found);
            break;
        }
    }
    let allowlisted = settings.restrictions.allowlist_enabled
        && allowlist_matches(state, &emails, &phones).await?;

    if mode == orbitid_core::settings::types::SignUpMode::Restricted
        || mode == orbitid_core::settings::types::SignUpMode::Public
    {
        if allowlisted || invitation.is_some() {
            return Ok(AllowedIdentifiers {
                invitation_id: invitation.map(|row| row.id),
            });
        }
        return Err(OrbitError::unprocessable(
            error_codes::SIGN_UP_RESTRICTED,
            "Sign-ups are restricted to invited users on this application.",
        ));
    }

    let waitlist_approved = if emails.is_empty() {
        false
    } else {
        let rows: Vec<String> =
            sqlx::query_scalar("SELECT status FROM waitlist_entries WHERE email = ANY($1)")
                .bind(&emails)
                .fetch_all(&state.pool)
                .await?;
        rows.iter()
            .any(|status| status == "invited" || status == "completed")
    };
    if allowlisted || invitation.is_some() || waitlist_approved {
        return Ok(AllowedIdentifiers {
            invitation_id: invitation.map(|row| row.id),
        });
    }
    Err(OrbitError::unprocessable(
        error_codes::WAITLIST_MODE,
        "You need an invitation to sign up for this application.",
    ))
}

/// Validates an app-invitation ticket (strategy `ticket` on sign-up).
pub async fn redeem_ticket(state: &AppState, ticket: &str) -> Result<TicketGrant> {
    validate_ticket(state, ticket).await
}

/// Marks an invitation accepted and its waitlist entry completed after a
/// successful sign-up. The `invitation.accepted` event commits with the
/// invitation row.
pub async fn mark_invitation_accepted(
    state: &AppState,
    invitation_id: &str,
    user_id: &str,
) -> Result<()> {
    let mut tx = state.pool.begin().await?;
    if let Some(accepted) = mark_invitation_accepted_on(&mut tx, invitation_id).await? {
        emit_invitation_accepted_on(&mut tx, &accepted, user_id).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// [`mark_invitation_accepted`] on a caller-supplied connection. Call
/// [`emit_invitation_accepted_on`] before the surrounding transaction commits.
pub async fn mark_invitation_accepted_on(
    conn: &mut sqlx::PgConnection,
    invitation_id: &str,
) -> Result<Option<InvitationRow>> {
    let now_ms = now();
    let accepted = sqlx::query_as::<_, InvitationRow>(
        "UPDATE invitations SET status = 'accepted', updated_at = $1 \
         WHERE id = $2 AND status = 'pending' \
         AND (expires_at IS NULL OR expires_at > $1) RETURNING *",
    )
    .bind(now_ms)
    .bind(invitation_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(accepted) = accepted else {
        return Ok(None);
    };
    sqlx::query(
        "UPDATE waitlist_entries SET status = 'completed', updated_at = $1 WHERE invitation_id = $2",
    )
    .bind(now_ms)
    .bind(&accepted.id)
    .execute(&mut *conn)
    .await?;
    Ok(Some(accepted))
}

fn invitation_accepted_payload(accepted: &InvitationRow, user_id: &str) -> serde_json::Value {
    let now_ms = now();
    let mut json = serde_json::to_value(serialize_invitation(accepted)).unwrap_or_default();
    if let Some(object) = json.as_object_mut() {
        object.insert("status".into(), serde_json::json!("accepted"));
        object.insert("user_id".into(), serde_json::json!(user_id));
        object.insert("updated_at".into(), serde_json::json!(now_ms));
    }
    json
}

/// Writes `invitation.accepted` on the caller's connection, in the same
/// transaction as the status flip.
pub async fn emit_invitation_accepted_on(
    conn: &mut sqlx::PgConnection,
    accepted: &InvitationRow,
    user_id: &str,
) -> Result<()> {
    emit_event_on(
        conn,
        "invitation.accepted",
        invitation_accepted_payload(accepted, user_id),
    )
    .await
}

mod instance_admin;
pub use instance_admin::*;
