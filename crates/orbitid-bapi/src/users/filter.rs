//! User list filters, ported from `modules/admin/users/shared.ts`.

use orbitid_core::db::helpers::contains_pattern;
use orbitid_core::error::Result;
use orbitid_core::state::AppState;

use crate::shared::{normalize_email, parse_bool_query, QueryPairs, Where};

/// Applies `query`, array filters, `banned`, `locked`, `is_anonymous`, `mfa`,
/// `last_active_at_since` and date bounds. Array filters are intersected.
pub async fn user_where(state: &AppState, query: &QueryPairs) -> Result<Where> {
    let mut filter = Where::new();
    if let Some(search) = query.raw("query").map(str::trim).filter(|q| !q.is_empty()) {
        let slot = filter.bind_text(contains_pattern(search));
        // One `IN (… UNION …)` instead of per-row `EXISTS` probes: each branch is a
        // plain `LIKE '%term%'` the planner can answer from its trigram index
        // (migration 0018), so a search no longer scans every user and email.
        filter.clauses.push(format!(
            "u.id IN (\
             SELECT s.id FROM users s WHERE lower(s.id) LIKE {slot} ESCAPE '\\' \
             OR lower(s.username) LIKE {slot} ESCAPE '\\' \
             OR lower(s.first_name) LIKE {slot} ESCAPE '\\' \
             OR lower(s.last_name) LIKE {slot} ESCAPE '\\' \
             OR lower(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')) LIKE {slot} ESCAPE '\\' \
             UNION SELECT e.user_id FROM email_addresses e WHERE lower(e.email) LIKE {slot} ESCAPE '\\' \
             UNION SELECT p.user_id FROM phone_numbers p WHERE lower(p.phone) LIKE {slot} ESCAPE '\\')"
        ));
    }

    let mut allowed: Option<Vec<String>> = None;
    let mut restrict = |ids: Vec<String>| match allowed.as_mut() {
        None => allowed = Some(ids),
        Some(current) => current.retain(|id| ids.contains(id)),
    };

    let emails: Vec<String> = query
        .values("email_address")
        .into_iter()
        .map(|email| normalize_email(&email))
        .collect();
    if !emails.is_empty() {
        let rows: Vec<Option<String>> = sqlx::query_scalar(
            "SELECT DISTINCT user_id FROM email_addresses WHERE email = ANY($1)",
        )
        .bind(&emails)
        .fetch_all(&state.pool)
        .await?;
        restrict(rows.into_iter().flatten().collect());
    }
    let phones = query.values("phone_number");
    if !phones.is_empty() {
        let rows: Vec<Option<String>> =
            sqlx::query_scalar("SELECT DISTINCT user_id FROM phone_numbers WHERE phone = ANY($1)")
                .bind(&phones)
                .fetch_all(&state.pool)
                .await?;
        restrict(rows.into_iter().flatten().collect());
    }
    let usernames: Vec<String> = query
        .values("username")
        .into_iter()
        .map(|name| name.to_lowercase())
        .collect();
    if !usernames.is_empty() {
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE username_lower = ANY($1)")
                .bind(&usernames)
                .fetch_all(&state.pool)
                .await?;
        restrict(ids);
    }
    let external_ids = query.values("external_id");
    if !external_ids.is_empty() {
        let ids: Vec<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE external_id = ANY($1)")
                .bind(&external_ids)
                .fetch_all(&state.pool)
                .await?;
        restrict(ids);
    }
    let user_ids = query.values("user_id");
    if !user_ids.is_empty() {
        restrict(user_ids);
    }
    let org_ids = query.values("organization_id");
    if !org_ids.is_empty() {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT user_id FROM organization_memberships WHERE organization_id = ANY($1)",
        )
        .bind(&org_ids)
        .fetch_all(&state.pool)
        .await?;
        restrict(ids);
    }
    if let Some(ids) = allowed {
        filter.one_of_text("u.id", &ids);
    }

    if let Some(banned) = parse_bool_query(query.raw("banned")) {
        filter.equal_bool("u.banned", banned);
    }
    if let Some(locked) = parse_bool_query(query.raw("locked")) {
        filter.equal_bool("u.locked", locked);
    }
    if let Some(anonymous) = parse_bool_query(query.raw("is_anonymous")) {
        filter.equal_bool("u.is_anonymous", anonymous);
    }
    if let Some(mfa) = parse_bool_query(query.raw("mfa")) {
        filter.equal_bool("u.totp_verified", mfa);
    }
    if let Some(since) = query.raw("last_active_at_since").and_then(parse_int) {
        filter.at_least("u.last_active_at", since);
    }
    if let Some(after) = query.raw("created_at_after").and_then(parse_int) {
        filter.at_least("u.created_at", after);
    }
    if let Some(before) = query.raw("created_at_before").and_then(parse_int) {
        filter.before("u.created_at", before);
    }
    Ok(filter)
}

fn parse_int(raw: &str) -> Option<i64> {
    raw.trim().parse::<f64>().ok().map(|value| value as i64)
}

/// Columns accepted by `?order_by` on the users list.
pub const USER_ORDER_COLUMNS: &[(&str, &str)] = &[
    ("created_at", "u.created_at"),
    ("updated_at", "u.updated_at"),
    ("last_sign_in_at", "u.last_sign_in_at"),
    ("last_active_at", "u.last_active_at"),
    ("id", "u.id"),
];
