//! Organization domain helpers, ported from `services/org-domains.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{OrganizationDomainRow, OrganizationInvitationRow, OrganizationRow};
use orbitid_core::state::AppState;
use serde_json::json;

pub const ENROLLMENT_MODES: &[&str] = &[
    "manual_invitation",
    "automatic_invitation",
    "automatic_suggestion",
];

const EMAIL_RE: &str = r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$";
const PUBLIC_SUFFIXES: &[&str] = &[
    "com", "net", "org", "io", "co", "dev", "app", "ai", "edu", "gov", "mil", "info", "biz", "me",
    "sh", "xyz",
];

/// Whether `mode` is one of the accepted enrollment modes.
pub fn is_enrollment_mode(mode: &str) -> bool {
    ENROLLMENT_MODES.contains(&mode)
}

/// Lowercases + strips a leading `@` / `*@`; throws when the result is not a
/// registrable domain.
pub fn normalize_domain(raw: &str) -> Result<String> {
    let mut name = raw.trim().to_lowercase();
    if let Some(rest) = name.strip_prefix("*@") {
        name = rest.to_string();
    } else if let Some(rest) = name.strip_prefix('@') {
        name = rest.to_string();
    }
    while name.ends_with('.') {
        name.pop();
    }
    if !valid_domain(&name) || PUBLIC_SUFFIXES.contains(&name.as_str()) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("\"{raw}\" is not a valid domain"),
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    Ok(name)
}

/// Rust's regex crate has no look-around, so the domain grammar is checked
/// label by label (the TS regex is
/// `^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`).
fn valid_domain(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 || !name.contains('.') {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    })
}

pub fn normalize_email(raw: &str) -> Result<String> {
    let email = raw.trim().to_lowercase();
    let re =
        regex::Regex::new(EMAIL_RE).map_err(|error| OrbitError::internal(error.to_string()))?;
    if !re.is_match(&email) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            format!("\"{raw}\" is not a valid email address"),
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    Ok(email)
}

pub fn email_domain(email: &str) -> String {
    email
        .trim()
        .to_lowercase()
        .split('@')
        .nth(1)
        .unwrap_or("")
        .to_string()
}

pub async fn user_verified_emails(state: &AppState, user_id: &str) -> Result<Vec<String>> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT email FROM email_addresses WHERE user_id = $1 AND verified = true",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.into_iter().map(|email| email.to_lowercase()).collect())
}

pub async fn user_verified_email_domains(state: &AppState, user_id: &str) -> Result<Vec<String>> {
    let mut domains: Vec<String> = user_verified_emails(state, user_id)
        .await?
        .into_iter()
        .map(|email| email_domain(&email))
        .filter(|domain| !domain.is_empty())
        .collect();
    domains.sort();
    domains.dedup();
    Ok(domains)
}

pub async fn user_member_org_ids(state: &AppState, user_id: &str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT organization_id FROM organization_memberships WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?)
}

/// Organizations the user could join because a verified domain of theirs uses
/// `automatic_suggestion`.
pub async fn suggested_organizations(
    state: &AppState,
    user_id: &str,
) -> Result<Vec<(OrganizationRow, OrganizationDomainRow)>> {
    let domains = user_verified_email_domains(state, user_id).await?;
    if domains.is_empty() {
        return Ok(Vec::new());
    }
    let memberships: std::collections::HashSet<String> = user_member_org_ids(state, user_id)
        .await?
        .into_iter()
        .collect();
    let rows = sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE name = ANY($1) AND verified = true \
         AND enrollment_mode = 'automatic_suggestion'",
    )
    .bind(&domains)
    .fetch_all(&state.pool)
    .await?;
    let org_ids: Vec<String> = {
        let mut ids: Vec<String> = rows.iter().map(|row| row.organization_id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
    };
    let orgs: std::collections::HashMap<String, OrganizationRow> =
        sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = ANY($1)")
            .bind(&org_ids)
            .fetch_all(&state.pool)
            .await?
            .into_iter()
            .map(|org| (org.id.clone(), org))
            .collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for domain in rows {
        if memberships.contains(&domain.organization_id)
            || !seen.insert(domain.organization_id.clone())
        {
            continue;
        }
        if let Some(org) = orgs.get(&domain.organization_id) {
            out.push((org.clone(), domain));
        }
    }
    out.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    Ok(out)
}

/// Whether the user qualifies to request membership through a verified
/// suggestion domain.
pub async fn has_suggestion_for_organization(
    state: &AppState,
    user_id: &str,
    org_id: &str,
) -> Result<bool> {
    Ok(suggested_organizations(state, user_id)
        .await?
        .iter()
        .any(|(org, _)| org.id == org_id))
}

pub async fn find_domain_by_name(
    state: &AppState,
    org_id: &str,
    name: &str,
) -> Result<Option<OrganizationDomainRow>> {
    Ok(sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE organization_id = $1 AND name = $2",
    )
    .bind(org_id)
    .bind(name.to_lowercase())
    .fetch_optional(&state.pool)
    .await?)
}

pub async fn find_domain(
    state: &AppState,
    org_id: &str,
    id: &str,
) -> Result<Option<OrganizationDomainRow>> {
    Ok(sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE organization_id = $1 AND id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?)
}

/// Pending invitations addressed to mailboxes on this domain.
pub async fn pending_invitations_for_domain(
    state: &AppState,
    org_id: &str,
    domain_name: &str,
) -> Result<i64> {
    let mut conn = state.pool.acquire().await?;
    pending_invitations_for_domain_on(&mut conn, org_id, domain_name).await
}

/// [`pending_invitations_for_domain`] on a caller-owned connection.
pub async fn pending_invitations_for_domain_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    domain_name: &str,
) -> Result<i64> {
    let suffix = format!("@{}", domain_name.to_lowercase());
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_invitations \
         WHERE organization_id = $1 AND status = 'pending' AND lower(email) LIKE $2",
    )
    .bind(org_id)
    .bind(format!("%{suffix}"))
    .fetch_one(&mut *conn)
    .await?)
}

/// Users with a verified email on this domain who are not members yet
/// (`total_pending_suggestions`).
pub async fn pending_suggestions_for_domain(
    state: &AppState,
    org_id: &str,
    domain_name: &str,
) -> Result<i64> {
    let mut conn = state.pool.acquire().await?;
    pending_suggestions_for_domain_on(&mut conn, org_id, domain_name).await
}

/// [`pending_suggestions_for_domain`] on a caller-owned connection. Uses
/// `email_addresses_verified_domain_idx` (migration 0010).
pub async fn pending_suggestions_for_domain_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    domain_name: &str,
) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(DISTINCT e.user_id) FROM email_addresses e \
         WHERE e.verified = true AND e.user_id IS NOT NULL \
         AND lower(split_part(e.email, '@', 2)) = $2 \
         AND NOT EXISTS (SELECT 1 FROM organization_memberships m \
                         WHERE m.organization_id = $1 AND m.user_id = e.user_id)",
    )
    .bind(org_id)
    .bind(domain_name.to_lowercase())
    .fetch_one(&mut *conn)
    .await?)
}

/// Drops pending invitations addressed to this domain; returns them so callers
/// can emit revoke events.
pub async fn delete_pending_for_domain(
    state: &AppState,
    org_id: &str,
    domain_name: &str,
) -> Result<Vec<OrganizationInvitationRow>> {
    let mut tx = state.pool.begin().await?;
    let rows = delete_pending_for_domain_on(&mut tx, org_id, domain_name).await?;
    tx.commit().await?;
    Ok(rows)
}

/// [`delete_pending_for_domain`] on a caller-owned transaction.
pub async fn delete_pending_for_domain_on(
    conn: &mut sqlx::PgConnection,
    org_id: &str,
    domain_name: &str,
) -> Result<Vec<OrganizationInvitationRow>> {
    let suffix = format!("@{}", domain_name.to_lowercase());
    let rows = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations \
         WHERE organization_id = $1 AND status = 'pending' AND lower(email) LIKE $2",
    )
    .bind(org_id)
    .bind(format!("%{suffix}"))
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        sqlx::query("DELETE FROM organization_invitations WHERE id = $1")
            .bind(&row.id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(rows)
}

/// Issues the affiliation code and records its address on the domain in one
/// transaction. The caller sends the e-mail after commit.
pub async fn prepare_domain_affiliation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    domain: &OrganizationDomainRow,
    email: &str,
) -> Result<(OrganizationDomainRow, String)> {
    let settings = state.settings.get();
    let issued = crate::verifications::issue_verification_on(
        conn,
        state,
        crate::verifications::IssueVerificationInput::new(
            crate::verifications::purposes::ORG_DOMAIN,
            "email_code",
            email,
            &domain.id,
            settings.email.code_lifetime_seconds,
        )
        .with_code_length(settings.email.code_length),
    )
    .await?;
    let updated = sqlx::query_as::<_, OrganizationDomainRow>(
        "UPDATE organization_domains SET affiliation_email_address = $1, updated_at = $2 \
         WHERE id = $3 RETURNING *",
    )
    .bind(email)
    .bind(orbitid_core::http::now())
    .bind(&domain.id)
    .fetch_one(&mut *conn)
    .await?;
    Ok((
        updated,
        issued
            .code
            .ok_or_else(|| OrbitError::internal("domain verification expected a code"))?,
    ))
}

/// Locks the latest affiliation verification for a domain `FOR UPDATE`
/// (rank 6) so a caller can take it before the organization (rank 8).
pub async fn lock_latest_domain_verification_on(
    conn: &mut sqlx::PgConnection,
    domain_id: &str,
) -> Result<()> {
    sqlx::query(
        "SELECT id FROM verifications WHERE owner_id = $1 AND purpose = 'org_domain' \
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
    )
    .bind(domain_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(())
}

/// Outcome of [`attempt_domain_affiliation_on`].
pub enum DomainAttempt {
    Verified(OrganizationDomainRow),
    /// The code was refused; commit it with
    /// [`crate::verifications::commit_code_refusal`] so the attempt counter
    /// survives. The refusal names the verification id read *before* the
    /// attempt, never a re-read "latest" one.
    Refused(crate::verifications::CodeRefusal),
}

/// Consumes the latest affiliation code and marks the domain verified. The
/// attempt counter, the verification and the domain update commit together. A
/// database failure is the `Err` (roll back); a refused code is
/// [`DomainAttempt::Refused`].
pub async fn attempt_domain_affiliation_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    domain: &OrganizationDomainRow,
    code: &str,
) -> Result<DomainAttempt> {
    let verification = sqlx::query_as::<_, orbitid_core::models::VerificationRow>(
        "SELECT * FROM verifications WHERE owner_id = $1 AND purpose = 'org_domain' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&domain.id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| {
        OrbitError::unprocessable(
            error_codes::VERIFICATION_FAILED,
            "Start domain verification first",
        )
    })?;
    let verified =
        match crate::verifications::check_code_on(conn, state, Some(&verification), Some(code))
            .await?
        {
            crate::verifications::CodeCheck::Verified(row) => row,
            crate::verifications::CodeCheck::Refused(refusal) => {
                return Ok(DomainAttempt::Refused(refusal))
            }
        };
    sqlx::query("UPDATE verifications SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL")
        .bind(orbitid_core::http::now())
        .bind(&verified.id)
        .execute(&mut *conn)
        .await?;
    Ok(DomainAttempt::Verified(
        sqlx::query_as::<_, OrganizationDomainRow>(
            "UPDATE organization_domains SET verified = true, updated_at = $1, \
             enrollment_pending_since = CASE WHEN enrollment_mode = 'automatic_invitation' \
                                             THEN $1 ELSE NULL END, \
             enrollment_cursor = '', enrollment_failures = NULL, \
             enrollment_last_error = NULL, enrollment_next_attempt_at = NULL \
             WHERE id = $2 RETURNING *",
        )
        .bind(orbitid_core::http::now())
        .bind(&domain.id)
        .fetch_one(&mut *conn)
        .await?,
    ))
}

/// Changes the enrollment mode and optionally drops pending invitations, all on
/// the caller's connection. Revoked invitation events are written here too.
pub async fn set_domain_enrollment_mode_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    domain: &OrganizationDomainRow,
    mode: &str,
    delete_pending: bool,
) -> Result<OrganizationDomainRow> {
    if !is_enrollment_mode(mode) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "enrollment_mode must be manual_invitation, automatic_invitation or automatic_suggestion",
        )
        .with_meta(json!({ "param_name": "enrollment_mode" })));
    }
    let updated = sqlx::query_as::<_, OrganizationDomainRow>(
        "UPDATE organization_domains SET enrollment_mode = $1, updated_at = $2, \
         enrollment_pending_since = CASE WHEN $1 = 'automatic_invitation' AND verified \
                                         THEN $2 ELSE NULL END, \
         enrollment_cursor = '', enrollment_failures = NULL, \
         enrollment_last_error = NULL, enrollment_next_attempt_at = NULL \
         WHERE id = $3 RETURNING *",
    )
    .bind(mode)
    .bind(orbitid_core::http::now())
    .bind(&domain.id)
    .fetch_one(&mut *conn)
    .await?;
    if delete_pending {
        for invitation in
            delete_pending_for_domain_on(conn, &domain.organization_id, &domain.name).await?
        {
            let json = serde_json::to_value(
                crate::org_serializers::serialize_organization_invitation_on(
                    conn,
                    &invitation,
                    true,
                    None,
                )
                .await?,
            )
            .unwrap_or_default();
            orbitid_platform::webhooks::emit_event_on(conn, "organizationInvitation.revoked", json)
                .await?;
        }
    }
    Ok(updated)
}
