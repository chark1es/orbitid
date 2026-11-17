//! One-batch retention operations; each owns its transaction and follows the global lock order.

use std::collections::HashSet;

use orbitid_core::error::Result;
use orbitid_core::state::AppState;

use super::isolate::delete_isolating;
use super::simple::delete_simple;

/// Position of the last candidate a batch examined, ordered by the operation's
/// `(time column, key)` sort. The drain loop passes it back to the next batch so
/// a full page of skipped (locked/busy) rows cannot hide the backlog behind it.
pub(super) type RetentionCursor = (i64, String);

/// Which retained table a [`drain`](super::drain) loop is working on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RetentionOp {
    Verifications,
    OauthGrants,
    DeviceCodes,
    OauthStates,
    SignIns,
    SignUps,
    Sessions,
    Clients,
    WebhookDeliveries,
    WebhookEvents,
    AuditLogs,
    Uploads,
}

impl RetentionOp {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Verifications => "retention.verifications",
            Self::OauthGrants => "retention.oauth_grants",
            Self::DeviceCodes => "retention.device_codes",
            Self::OauthStates => "retention.oauth_states",
            Self::SignIns => "retention.sign_ins",
            Self::SignUps => "retention.sign_ups",
            Self::Sessions => "retention.sessions",
            Self::Clients => "retention.clients",
            Self::WebhookDeliveries => "retention.webhook_deliveries",
            Self::WebhookEvents => "retention.webhook_events",
            Self::AuditLogs => "retention.audit_logs",
            Self::Uploads => "retention.uploads",
        }
    }

    /// Runs one batch and reports `(deleted, more_candidates, next_cursor)`.
    ///
    /// `more_candidates` is true when the batch examined a full candidate page,
    /// so rows may remain beyond `next_cursor`. A batch that deleted nothing
    /// still returns `true` and advances the cursor when the page was full, so
    /// the drain pages past rows another transaction holds instead of stopping
    /// or re-selecting the same head forever.
    pub(super) async fn run(
        self,
        state: &AppState,
        cutoff: i64,
        batch: i64,
        after: Option<RetentionCursor>,
    ) -> Result<(i64, bool, Option<RetentionCursor>)> {
        match self {
            Self::Verifications => delete_verifications(state, cutoff, batch, after).await,
            Self::OauthGrants => delete_oauth_grants(state, cutoff, batch, after).await,
            Self::DeviceCodes => {
                delete_simple(
                    state,
                    "device_codes",
                    "id",
                    "expires_at < $1",
                    cutoff,
                    batch,
                    "expires_at, id",
                    after,
                )
                .await
            }
            Self::OauthStates => {
                delete_simple(
                    state,
                    "oauth_states",
                    "state",
                    "expires_at < $1",
                    cutoff,
                    batch,
                    "expires_at, state",
                    after,
                )
                .await
            }
            Self::SignIns => {
                delete_simple(
                    state,
                    "sign_ins",
                    "id",
                    "abandon_at < $1 AND (created_session_id IS NULL OR NOT EXISTS \
                     (SELECT 1 FROM sessions s WHERE s.id = sign_ins.created_session_id \
                      AND s.status IN ('active', 'pending')))",
                    cutoff,
                    batch,
                    "abandon_at, id",
                    after,
                )
                .await
            }
            Self::SignUps => {
                delete_simple(
                    state,
                    "sign_ups",
                    "id",
                    "abandon_at < $1 AND (created_session_id IS NULL OR NOT EXISTS \
                     (SELECT 1 FROM sessions s WHERE s.id = sign_ups.created_session_id \
                      AND s.status IN ('active', 'pending')))",
                    cutoff,
                    batch,
                    "abandon_at, id",
                    after,
                )
                .await
            }
            Self::Sessions => delete_sessions(state, cutoff, batch, after).await,
            Self::Clients => {
                delete_simple(
                    state,
                    "clients",
                    "id",
                    "updated_at < $1 AND NOT EXISTS \
                     (SELECT 1 FROM sessions s WHERE s.client_id = clients.id) \
                     AND NOT EXISTS \
                     (SELECT 1 FROM sign_ins i WHERE i.client_id = clients.id \
                      AND i.status NOT IN ('complete','abandoned')) \
                     AND NOT EXISTS \
                     (SELECT 1 FROM sign_ups u WHERE u.client_id = clients.id \
                      AND u.status NOT IN ('complete','abandoned'))",
                    cutoff,
                    batch,
                    "updated_at, id",
                    after,
                )
                .await
            }
            Self::WebhookDeliveries => {
                delete_simple(
                    state,
                    "webhook_deliveries",
                    "id",
                    "status IN ('success', 'failed') AND created_at < $1",
                    cutoff,
                    batch,
                    "created_at, id",
                    after,
                )
                .await
            }
            Self::WebhookEvents => {
                delete_simple(
                    state,
                    "webhook_events",
                    "id",
                    "created_at < $1 AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d \
                     WHERE d.event_id = webhook_events.id AND d.status NOT IN ('success', 'failed'))",
                    cutoff,
                    batch,
                    "created_at, id",
                    after,
                )
                .await
            }
            Self::AuditLogs => {
                delete_simple(
                    state,
                    "audit_logs",
                    "id",
                    "created_at < $1",
                    cutoff,
                    batch,
                    "created_at, id",
                    after,
                )
                .await
            }
            Self::Uploads => {
                delete_simple(
                    state,
                    "uploads",
                    "file",
                    "created_at < $1 \
                     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.image_file = uploads.file) \
                     AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.image_file = uploads.file)",
                    cutoff,
                    batch,
                    "created_at, file",
                    after,
                )
                .await
            }
        }
    }
}

/// Starts one worker transaction and takes the retention advisory lock. `None`
/// means another replica holds it, so this operation is skipped for this batch.
pub(super) async fn begin_sweep(
    state: &AppState,
) -> Result<Option<sqlx::Transaction<'_, sqlx::Postgres>>> {
    let mut tx = state.pool.begin().await?;
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtext('orbitid_retention')::bigint)",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !acquired {
        tx.rollback().await?;
        return Ok(None);
    }
    Ok(Some(tx))
}

/// Ends a sweep transaction explicitly on every path: commit on success, an
/// awaited rollback on failure. A dropped transaction only queues its rollback,
/// so the retention advisory lock and row locks would stay held by the pooled
/// connection while the next batch (or another replica) tries to take them.
pub(super) async fn finish_sweep<T>(
    tx: sqlx::Transaction<'_, sqlx::Postgres>,
    outcome: Result<T>,
) -> Result<T> {
    orbitid_core::db::finish_transaction(tx, outcome).await
}

async fn delete_verifications(
    state: &AppState,
    cutoff: i64,
    batch: i64,
    after: Option<RetentionCursor>,
) -> Result<(i64, bool, Option<RetentionCursor>)> {
    let Some(mut tx) = begin_sweep(state).await? else {
        return Ok((0, false, None));
    };
    let outcome: Result<_> = async {
        // Rank 6 only. Select the candidate page *without* a lock (so a busy row
        // does not consume the page), positioned after the drain cursor; then lock
        // only the still-eligible, unlocked rows.
        let (after_at, after_id) = after.unwrap_or((i64::MIN, String::new()));
        let candidates: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id, expires_at FROM verifications \
         WHERE (expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)) \
         AND (expires_at, id) > ($3, $4) \
         ORDER BY expires_at, id LIMIT $2",
        )
        .bind(cutoff)
        .bind(batch)
        .bind(after_at)
        .bind(&after_id)
        .fetch_all(&mut *tx)
        .await?;
        let next = candidates
            .last()
            .map(|(id, expires_at)| (*expires_at, id.clone()));
        let candidate_count = candidates.len() as i64;
        let candidate_ids: Vec<String> = candidates.into_iter().map(|(id, _)| id).collect();
        let ids: Vec<String> = if candidate_ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_scalar(
                "SELECT id FROM verifications WHERE id = ANY($2) \
             AND (expires_at < $1 OR (consumed_at IS NOT NULL AND consumed_at < $1)) \
             ORDER BY id FOR UPDATE SKIP LOCKED",
            )
            .bind(cutoff)
            .bind(&candidate_ids)
            .fetch_all(&mut *tx)
            .await?
        };
        let count = delete_isolating(
            &mut tx,
            "verifications",
            "DELETE FROM verifications WHERE id = ANY($1)",
            &ids,
        )
        .await?;
        // A full candidate page means there may be more work beyond the cursor; a
        // batch that locked none still advanced past the busy rows.
        Ok((count, candidate_count >= batch, next))
    }
    .await;
    finish_sweep(tx, outcome).await
}

async fn delete_oauth_grants(
    state: &AppState,
    cutoff: i64,
    batch: i64,
    after: Option<RetentionCursor>,
) -> Result<(i64, bool, Option<RetentionCursor>)> {
    let Some(mut tx) = begin_sweep(state).await? else {
        return Ok((0, false, None));
    };
    let outcome: Result<_> = async {
        // Rank 11 (family advisory) before rank 12-ish grant rows: take the family
        // locks in ascending order first, then delete rows that are still eligible.
        // The candidate page is positioned after the drain cursor.
        let (after_at, after_id) = after.unwrap_or((i64::MIN, String::new()));
        let candidates: Vec<(String, Option<String>, i64)> = sqlx::query_as(
            "SELECT g.id, g.family_id, g.expires_at FROM oauth_grants g \
         WHERE g.expires_at < $1 AND (g.family_id IS NULL OR NOT EXISTS \
             (SELECT 1 FROM oauth_grants f WHERE f.family_id = g.family_id \
              AND f.expires_at >= $1)) \
         AND (g.expires_at, g.id) > ($3, $4) \
         ORDER BY g.expires_at, g.id LIMIT $2",
        )
        .bind(cutoff)
        .bind(batch)
        .bind(after_at)
        .bind(&after_id)
        .fetch_all(&mut *tx)
        .await?;
        let next = candidates
            .last()
            .map(|(id, _, expires_at)| (*expires_at, id.clone()));
        let mut families: Vec<String> = candidates
            .iter()
            .filter_map(|(_, family, _)| family.clone())
            .collect();
        families.sort();
        families.dedup();
        for family in &families {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)")
                .bind(family)
                .execute(&mut *tx)
                .await?;
        }
        let candidate_count = candidates.len() as i64;
        let ids: Vec<String> = candidates.into_iter().map(|(id, _, _)| id).collect();
        // Lock the still-eligible rows in primary-key order (after their family
        // advisories) and delete exactly those, so a concurrent refresh cannot
        // deadlock on differently ordered row locks.
        let locked_ids: Vec<String> = if ids.is_empty() {
            Vec::new()
        } else {
            sqlx::query_scalar(
                "SELECT g.id FROM oauth_grants g WHERE g.id = ANY($1) AND g.expires_at < $2 \
             AND (g.family_id IS NULL OR NOT EXISTS \
                 (SELECT 1 FROM oauth_grants f WHERE f.family_id = g.family_id \
                  AND f.expires_at >= $2)) \
             ORDER BY g.id FOR UPDATE SKIP LOCKED",
            )
            .bind(&ids)
            .bind(cutoff)
            .fetch_all(&mut *tx)
            .await?
        };
        let deleted = delete_isolating(
            &mut tx,
            "oauth_grants",
            "DELETE FROM oauth_grants WHERE id = ANY($1)",
            &locked_ids,
        )
        .await?;
        Ok((deleted, candidate_count >= batch, next))
    }
    .await;
    finish_sweep(tx, outcome).await
}

/// Deletes a bounded batch of long-dead sessions and clears the text pointers
/// that could otherwise dangle. Lock order is clients (rank 2, ascending id),
/// sign_ups (rank 4), sign_ins (rank 5), sessions (rank 7) — never the reverse.
async fn delete_sessions(
    state: &AppState,
    cutoff: i64,
    batch: i64,
    after: Option<RetentionCursor>,
) -> Result<(i64, bool, Option<RetentionCursor>)> {
    let Some(mut tx) = begin_sweep(state).await? else {
        return Ok((0, false, None));
    };
    let outcome: Result<_> = async {
        let (after_at, after_id) = after.unwrap_or((i64::MIN, String::new()));
        let candidates: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT id, client_id, updated_at FROM sessions \
         WHERE status IN ('ended', 'revoked', 'expired', 'removed') AND updated_at < $1 \
         AND (updated_at, id) > ($3, $4) \
         ORDER BY updated_at, id LIMIT $2",
        )
        .bind(cutoff)
        .bind(batch)
        .bind(after_at)
        .bind(&after_id)
        .fetch_all(&mut *tx)
        .await?;
        if candidates.is_empty() {
            return Ok((0, false, None));
        }
        let next = candidates
            .last()
            .map(|(id, _, updated_at)| (*updated_at, id.clone()));
        let candidate_count = candidates.len() as i64;
        let mut client_ids: Vec<String> = candidates.iter().map(|(_, id, _)| id.clone()).collect();
        client_ids.sort();
        client_ids.dedup();
        // Skip a client that foreground traffic holds rather than waiting on it.
        let locked_clients: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM clients WHERE id = ANY($1) ORDER BY id FOR UPDATE SKIP LOCKED",
        )
        .bind(&client_ids)
        .fetch_all(&mut *tx)
        .await?;
        let locked: HashSet<&str> = locked_clients.iter().map(String::as_str).collect();
        let ids: Vec<String> = candidates
            .iter()
            .filter(|(_, client_id, _)| locked.contains(client_id.as_str()))
            .map(|(id, _, _)| id.clone())
            .collect();
        // `more_candidates` comes from the candidate page, not the rows we could
        // lock: a full page of busy clients still advances the cursor, so the next
        // batch reaches the eligible sessions behind them instead of stopping.
        if ids.is_empty() {
            return Ok((0, candidate_count >= batch, next));
        }
        // Lock the attempt rows before the sessions in rank order. Writers of these
        // rows take the client lock first, so waiting here cannot form a cycle.
        let sign_up_ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM sign_ups WHERE created_session_id = ANY($1) ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        let sign_in_ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM sign_ins WHERE created_session_id = ANY($1) ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        let session_ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM sessions WHERE id = ANY($1) \
         AND status IN ('ended', 'revoked', 'expired', 'removed') AND updated_at < $2 \
         ORDER BY id FOR UPDATE",
        )
        .bind(&ids)
        .bind(cutoff)
        .fetch_all(&mut *tx)
        .await?;
        if session_ids.is_empty() {
            return Ok((0, candidate_count >= batch, next));
        }
        if !sign_up_ids.is_empty() {
            sqlx::query("UPDATE sign_ups SET created_session_id = NULL WHERE id = ANY($1)")
                .bind(&sign_up_ids)
                .execute(&mut *tx)
                .await?;
        }
        if !sign_in_ids.is_empty() {
            sqlx::query("UPDATE sign_ins SET created_session_id = NULL WHERE id = ANY($1)")
                .bind(&sign_in_ids)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query(
            "UPDATE clients SET last_active_session_id = NULL \
         WHERE id = ANY($1) AND last_active_session_id = ANY($2)",
        )
        .bind(&locked_clients)
        .bind(&session_ids)
        .execute(&mut *tx)
        .await?;
        let count = delete_isolating(
            &mut tx,
            "sessions",
            "DELETE FROM sessions WHERE id = ANY($1)",
            &session_ids,
        )
        .await?;
        Ok((count, candidate_count >= batch, next))
    }
    .await;
    finish_sweep(tx, outcome).await
}
