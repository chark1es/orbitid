//! Verified-domain enrollment: pending invitations and automatic joins.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;

use orbitid_core::models::{OrganizationDomainRow, OrganizationInvitationRow};
use orbitid_core::state::AppState;
use orbitid_platform::emit_event;
use orbitid_platform::webhooks::emit_event_on;
use serde_json::Value;
use sqlx::Connection;

use super::invitations::accept_invitation_on;
use super::{add_membership_prechecked_on, default_role_key_on};
use crate::org_domains::email_domain;
use crate::org_serializers::{serialize_organization_domain, serialize_organization_domain_on};

/// Members of one organization, counted up to `$2` rows (the cap).
pub const BOUNDED_MEMBER_COUNT: &str = "SELECT COUNT(*) FROM \
     (SELECT 1 FROM organization_memberships WHERE organization_id = $1 LIMIT $2) AS bounded";

/// Verified users read per enrollment transaction. Each chunk locks its users
/// plus the organization for the duration of one short transaction.
pub const ENROLLMENT_CHUNK: usize = 200;

/// Called after a user (with a freshly verified email) is created or verifies an
/// email: accept pending org invitations and apply verified-domain enrollment.
///
/// This is the **only** enrollment path for a user who becomes eligible after a
/// domain was verified (the domain-level pass in [`apply_domain_enrollment`]
/// covers users who were already eligible). Every way an address becomes
/// verified reaches it: sign-up and sign-in completion, the magic link
/// (`after_user_created`), the add-email verification, external-account user
/// creation (`create_user`) and the Backend API user creation. It runs in its
/// own transaction (retried on a deadlock or serialization failure) because a
/// dropped call would silently lose an invitation acceptance or an automatic
/// join; a failure that exhausts the retries is logged.
pub async fn on_user_email_verified(state: &AppState, user_id: &str, email: &str) -> Result<()> {
    let result = orbitid_core::db::with_retry("on_user_email_verified", |_| async {
        let mut tx = state.pool.begin().await?;
        on_user_email_verified_on(&mut tx, state, user_id, email).await?;
        tx.commit().await?;
        Ok(())
    })
    .await;
    if let Err(error) = &result {
        tracing::error!(
            user_id,
            code = %error.code,
            "verified-email organisation enrolment failed after retries"
        );
    }
    result
}

/// [`on_user_email_verified`] on a caller-owned transaction: pending invitations
/// and verified-domain enrolment commit together with the email verification
/// that triggered them. Only this user is enrolled by domain; everyone else who
/// matches the domain is handled by [`apply_domain_enrollment`] or by their own
/// verification.
pub async fn on_user_email_verified_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user_id: &str,
    email: &str,
) -> Result<()> {
    let address = email.trim().to_lowercase();
    if address.is_empty() {
        return Ok(());
    }
    let now_ms = now();
    let invitations = sqlx::query_as::<_, OrganizationInvitationRow>(
        "SELECT * FROM organization_invitations WHERE email = $1 AND status = 'pending' \
         ORDER BY organization_id, id",
    )
    .bind(&address)
    .fetch_all(&mut *conn)
    .await?;
    let domain = email_domain(&address);
    let domains = if domain.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, OrganizationDomainRow>(
            "SELECT * FROM organization_domains WHERE name = $1 AND verified = true \
             AND enrollment_mode = 'automatic_invitation' ORDER BY organization_id, id",
        )
        .bind(&domain)
        .fetch_all(&mut *conn)
        .await?
    };
    // Every membership insert below references this user (rank 3) and an
    // organization (rank 8): take both explicitly, user first, then the
    // organizations ascending, before any invitation/domain row is locked.
    let mut organizations: Vec<String> = invitations
        .iter()
        .map(|invitation| invitation.organization_id.clone())
        .chain(domains.iter().map(|row| row.organization_id.clone()))
        .collect();
    organizations.sort();
    organizations.dedup();
    let owner = [user_id.to_string()];
    let lock = crate::locks::lock_enrollment_on(conn, &owner, &organizations).await?;
    if !lock.covers_user(user_id) {
        // The user was deleted since the verification: nothing to enrol.
        return Ok(());
    }

    for invitation in invitations {
        if invitation.expires_at.map(|expires| expires <= now_ms) == Some(true) {
            continue;
        }
        if let Err(error) = accept_invitation_on(conn, state, &invitation, user_id).await {
            // A full organization must not break email verification.
            if error.code == error_codes::ORGANIZATION_MEMBERSHIP_QUOTA_EXCEEDED {
                continue;
            }
            return Err(error);
        }
    }
    for row in domains {
        enroll_locked_on(conn, state, &row, &owner, &lock, false).await?;
    }
    Ok(())
}

/// The candidate page query (`$1` domain, `$2` cursor, `$3` limit). Public so a
/// test can `EXPLAIN` it.
pub const DOMAIN_PAGE_SQL: &str = "SELECT DISTINCT user_id FROM email_addresses \
     WHERE verified = true AND user_id IS NOT NULL \
       AND lower(split_part(email, '@', 2)) = $1 AND user_id > $2 \
     ORDER BY user_id LIMIT $3";

/// One page of users with a verified address on `domain`, after `after`
/// (exclusive), ascending. Read without a lock so the caller can take the
/// key-share locks (rank 3) before the organization (rank 8). It is a plain
/// keyset walk over `email_addresses_verified_domain_idx` (migration 0010):
/// every page costs the same whatever the membership count, because members are
/// not filtered here (that anti-join made each page read all matching rows);
/// existing members are skipped under the locks by [`enroll_candidates_on`].
pub async fn domain_enrollment_user_ids_page_on(
    conn: &mut sqlx::PgConnection,
    domain: &OrganizationDomainRow,
    after: &str,
    limit: usize,
) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(DOMAIN_PAGE_SQL)
        .bind(domain.name.to_lowercase())
        .bind(after)
        .bind(limit as i64)
        .fetch_all(&mut *conn)
        .await?)
}

/// Adds every existing user with a verified email on the domain to the
/// organization (`automatic_invitation`), `extra_user_ids` first, in one
/// synchronous pass. Request handlers do not call this: they persist an
/// enrollment marker with the domain change and the worker in
/// [`super::enrollment_worker`] resumes it durably.
///
/// The work is chunked: each chunk is its own short transaction (retried on a
/// deadlock) that reads up to [`ENROLLMENT_CHUNK`] candidate ids without a lock,
/// key-shares the ones that still exist (ascending, rank 3), locks the
/// organization (rank 8), revalidates eligibility under those locks and
/// enrolls only the users the proof covers. One enrollment therefore never
/// holds the organization lock plus key-shares on every matching user, and the
/// lock order is users → organization every time. A user who becomes eligible
/// while this runs is enrolled by [`on_user_email_verified`] for that
/// verification.
pub async fn apply_domain_enrollment(
    state: &AppState,
    domain: &OrganizationDomainRow,
    extra_user_ids: &[String],
) -> Result<i64> {
    apply_domain_enrollment_chunked(state, domain, extra_user_ids, ENROLLMENT_CHUNK).await
}

/// [`apply_domain_enrollment`] with an explicit chunk size (tests use a small
/// one to exercise paging).
pub async fn apply_domain_enrollment_chunked(
    state: &AppState,
    domain: &OrganizationDomainRow,
    extra_user_ids: &[String],
    chunk_size: usize,
) -> Result<i64> {
    let chunk_size = chunk_size.max(1);
    let mut added = 0;
    let mut explicit: Vec<String> = extra_user_ids.to_vec();
    explicit.sort();
    explicit.dedup();
    for chunk in explicit.chunks(chunk_size) {
        let outcome = enroll_chunk(state, domain, chunk).await?;
        added += outcome.added;
        if outcome.full {
            return Ok(added);
        }
    }
    let mut after = String::new();
    loop {
        let page = orbitid_core::db::with_retry("domain_enrollment_chunk", |_| async {
            let mut tx = state.pool.begin().await?;
            let candidates =
                domain_enrollment_user_ids_page_on(&mut tx, domain, &after, chunk_size).await?;
            let outcome =
                enroll_candidates_counted_on(&mut tx, state, domain, &candidates, false).await?;
            tx.commit().await?;
            Ok((candidates, outcome))
        })
        .await?;
        let (candidates, outcome) = page;
        added += outcome.added;
        if outcome.full || candidates.len() < chunk_size {
            return Ok(added);
        }
        after = candidates.last().cloned().unwrap_or_default();
    }
}

async fn enroll_chunk(
    state: &AppState,
    domain: &OrganizationDomainRow,
    candidates: &[String],
) -> Result<ChunkEnrollment> {
    orbitid_core::db::with_retry("domain_enrollment_chunk", |_| async {
        let mut tx = state.pool.begin().await?;
        let outcome =
            enroll_candidates_counted_on(&mut tx, state, domain, candidates, false).await?;
        tx.commit().await?;
        Ok(outcome)
    })
    .await
}

/// What one chunk did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChunkEnrollment {
    /// Memberships created.
    pub added: i64,
    /// The organization's capacity stopped the chunk.
    pub full: bool,
    /// Users whose insert failed for a non-retryable reason and were skipped
    /// (logged with the domain and user id).
    pub skipped: Vec<String>,
}

/// One chunk on a caller-owned transaction: users (ascending, vanished users
/// skipped) → organization → revalidate → enroll. Returns the number added and
/// whether the organization's capacity stopped the chunk.
pub async fn enroll_candidates_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    domain: &OrganizationDomainRow,
    candidates: &[String],
) -> Result<(i64, bool)> {
    let chunk = enroll_candidates_counted_on(conn, state, domain, candidates, false).await?;
    Ok((chunk.added, chunk.full))
}

/// [`enroll_candidates_on`] that also reports the users it skipped. With
/// `isolate` (the background worker) a user whose insert fails for a
/// non-retryable reason is skipped; without it (synchronous callers, whose
/// transaction must stay all-or-nothing) the error propagates.
pub async fn enroll_candidates_counted_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    domain: &OrganizationDomainRow,
    candidates: &[String],
    isolate: bool,
) -> Result<ChunkEnrollment> {
    if candidates.is_empty() {
        return Ok(ChunkEnrollment::default());
    }
    let lock = crate::locks::lock_enrollment_on(
        conn,
        candidates,
        std::slice::from_ref(&domain.organization_id),
    )
    .await?;
    enroll_locked_on(conn, state, domain, candidates, &lock, isolate).await
}

/// Revalidates under the locks of `lock` and enrolls only users it covers.
/// The domain row is re-read (the organization lock serializes every writer of
/// it), each user must still hold a verified address on the domain, and
/// existing members are skipped.
pub(super) async fn enroll_locked_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    domain: &OrganizationDomainRow,
    candidates: &[String],
    lock: &crate::locks::MembershipWriteLock,
    isolate: bool,
) -> Result<ChunkEnrollment> {
    if !lock.covers_organization(&domain.organization_id) {
        return Ok(ChunkEnrollment::default());
    }
    let current = sqlx::query_as::<_, OrganizationDomainRow>(
        "SELECT * FROM organization_domains WHERE id = $1 AND organization_id = $2 \
         AND verified = true AND enrollment_mode = 'automatic_invitation'",
    )
    .bind(&domain.id)
    .bind(&domain.organization_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(current) = current else {
        return Ok(ChunkEnrollment::default());
    };
    let covered: Vec<String> = candidates
        .iter()
        .filter(|id| lock.covers_user(id))
        .cloned()
        .collect();
    if covered.is_empty() {
        return Ok(ChunkEnrollment::default());
    }
    let eligible: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT e.user_id FROM email_addresses e \
         WHERE e.verified = true AND e.user_id = ANY($1) \
           AND lower(split_part(e.email, '@', 2)) = $2 \
           AND NOT EXISTS (SELECT 1 FROM organization_memberships m \
                           WHERE m.organization_id = $3 AND m.user_id = e.user_id) \
         ORDER BY e.user_id",
    )
    .bind(&covered)
    .bind(current.name.to_lowercase())
    .bind(&current.organization_id)
    .fetch_all(&mut *conn)
    .await?;
    if eligible.is_empty() {
        return Ok(ChunkEnrollment::default());
    }
    let role_key = default_role_key_on(conn, state).await?;
    // Capacity is read once per chunk, under the organization lock that `lock`
    // proves: every other membership writer holds the same lock for its own
    // capacity check, so nobody can add a member until this transaction ends
    // and the running balance is exact. The count stops at the cap
    // (`LIMIT max`, served by the `om_org_user` index), so its cost depends on
    // the configured cap and never on how many members the organization has.
    let max: i64 =
        sqlx::query_scalar("SELECT max_allowed_memberships FROM organizations WHERE id = $1")
            .bind(&current.organization_id)
            .fetch_optional(&mut *conn)
            .await?
            .unwrap_or(0);
    let mut remaining: Option<i64> = if max > 0 {
        let members: i64 = sqlx::query_scalar(BOUNDED_MEMBER_COUNT)
            .bind(&current.organization_id)
            .bind(max)
            .fetch_one(&mut *conn)
            .await?;
        Some(max - members)
    } else {
        None
    };
    let mut chunk = ChunkEnrollment::default();
    for user_id in eligible {
        if remaining.is_some_and(|left| left <= 0) {
            // A full organization ends the pass (the TS server stopped at the
            // quota error the same way): the marker clears, the rest are
            // enrolled by their next email verification or the next mode toggle.
            chunk.full = true;
            return Ok(chunk);
        }
        // Each insert runs in a savepoint. Only a row-level failure of the
        // membership INSERT itself (see `skips_user`) rolls back to the
        // savepoint, is logged and lets the chunk continue, so one
        // persistently failing user cannot pin the domain's cursor. Everything
        // else (a retryable 40001/40P01, savepoint begin/release, connection
        // errors) fails the chunk.
        match add_isolated(conn, state, lock, &current, &user_id, &role_key).await {
            Ok(true) => {
                chunk.added += 1;
                remaining = remaining.map(|left| left - 1);
            }
            Ok(false) => {}
            Err(error) if !skips_user(isolate, &error) => return Err(error),
            Err(error) => {
                tracing::warn!(
                    domain_id = %current.id,
                    user_id = %user_id,
                    code = %error.code,
                    "domain enrollment skipped a user whose membership insert failed: {error}"
                );
                chunk.skipped.push(user_id);
            }
        }
    }
    Ok(chunk)
}

/// Worker mode skips a user only for a row-level insert failure.
fn skips_user(isolate: bool, error: &OrbitError) -> bool {
    isolate && error.row_level && !error.is_retryable_transaction()
}

async fn add_isolated(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    lock: &crate::locks::MembershipWriteLock,
    domain: &OrganizationDomainRow,
    user_id: &str,
    role_key: &str,
) -> Result<bool> {
    let mut savepoint = conn.begin().await?;
    match add_membership_prechecked_on(
        &mut savepoint,
        state,
        lock,
        &domain.organization_id,
        user_id,
        role_key,
    )
    .await
    {
        Ok(created) => {
            savepoint.commit().await?;
            Ok(created)
        }
        Err(error) => {
            let _ = savepoint.rollback().await;
            Err(error)
        }
    }
}

/// Emits `organizationDomain.*` for a domain row (used by both APIs).
pub async fn emit_domain_event(
    state: &AppState,
    event: &str,
    domain: &OrganizationDomainRow,
) -> Result<()> {
    let json: Value = serde_json::to_value(serialize_organization_domain(state, domain).await?)
        .map_err(|error| OrbitError::internal(error.to_string()))?;
    emit_event(state, event, json).await;
    Ok(())
}

/// [`emit_domain_event`] on a caller-owned connection, so the event commits
/// with the domain change.
pub async fn emit_domain_event_on(
    conn: &mut sqlx::PgConnection,
    event: &str,
    domain: &OrganizationDomainRow,
) -> Result<()> {
    let json: Value = serde_json::to_value(serialize_organization_domain_on(conn, domain).await?)
        .map_err(|error| OrbitError::internal(error.to_string()))?;
    emit_event_on(conn, event, json).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_flagged_row_failure_in_worker_mode_skips_the_user() {
        let plain = OrbitError::internal("savepoint release failed");
        let mut row = OrbitError::internal("trigger raised");
        row.row_level = true;
        assert!(!skips_user(true, &plain), "a non-row error fails the chunk");
        assert!(skips_user(true, &row));
        assert!(!skips_user(false, &row), "request path never skips");
    }
}
