//! Aggregate instance statistics for the dashboard overview (`GET /v1/stats`),
//! ported from the retired TypeScript server.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;
use serde::{Deserialize, Serialize};

const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyCount {
    pub date: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCount {
    pub provider: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceStatsJson {
    pub users_total: i64,
    pub users_active_7d: i64,
    pub sessions_active: i64,
    pub organizations_total: i64,
    pub signups_by_day: Vec<DailyCount>,
    pub signins_by_day: Vec<DailyCount>,
    pub banned_users: i64,
    pub locked_users: i64,
    pub mfa_enabled_users: i64,
    pub top_social_providers: Vec<ProviderCount>,
}

/// Civil date from a day number since the Unix epoch (Howard Hinnant's algorithm),
/// so the crate needs no date/time dependency for a UTC `YYYY-MM-DD`.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

fn utc_date(timestamp_ms: i64) -> String {
    let days = timestamp_ms.div_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `n` UTC days ending today, oldest first — used to zero-fill chart series.
fn last_days(n: i64, now: i64) -> Vec<String> {
    (0..n)
        .rev()
        .map(|index| utc_date(now - index * DAY_MS))
        .collect()
}

fn zero_fill(rows: &[i64], now: i64) -> Vec<DailyCount> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, i64> = HashMap::new();
    for timestamp in rows {
        *counts.entry(utc_date(*timestamp)).or_insert(0) += 1;
    }
    last_days(30, now)
        .into_iter()
        .map(|date| DailyCount {
            count: counts.get(&date).copied().unwrap_or(0),
            date,
        })
        .collect()
}

async fn by_day(state: &AppState, table: &str, now: i64) -> Result<Vec<DailyCount>> {
    let sql = match table {
        "sessions" => "SELECT created_at FROM sessions WHERE created_at >= $1",
        _ => "SELECT created_at FROM users WHERE created_at >= $1",
    };
    let rows: Vec<i64> = sqlx::query_scalar(sql)
        .bind(now - 30 * DAY_MS)
        .fetch_all(&state.pool)
        .await?;
    Ok(zero_fill(&rows, now))
}

async fn count(state: &AppState, sql: &str, bind: Option<i64>) -> Result<i64> {
    let mut query = sqlx::query_scalar::<_, i64>(sql);
    if let Some(value) = bind {
        query = query.bind(value);
    }
    Ok(query.fetch_one(&state.pool).await?)
}

/// Snapshot of the instance's aggregate counts.
pub async fn instance_stats(state: &AppState) -> Result<InstanceStatsJson> {
    let now = orbitid_core::http::now();
    let providers: Vec<(String, i64)> = sqlx::query_as(
        "SELECT provider, count(*) FROM external_accounts \
         GROUP BY provider ORDER BY count(*) DESC, provider ASC LIMIT 10",
    )
    .fetch_all(&state.pool)
    .await?;

    Ok(InstanceStatsJson {
        users_total: count(state, "SELECT count(*) FROM users", None).await?,
        users_active_7d: count(
            state,
            "SELECT count(*) FROM users WHERE last_active_at IS NOT NULL AND last_active_at >= $1",
            Some(now - 7 * DAY_MS),
        )
        .await?,
        sessions_active: count(
            state,
            "SELECT count(*) FROM sessions WHERE status = 'active' AND expire_at > $1",
            Some(now),
        )
        .await?,
        organizations_total: count(state, "SELECT count(*) FROM organizations", None).await?,
        signups_by_day: by_day(state, "users", now).await?,
        signins_by_day: by_day(state, "sessions", now).await?,
        banned_users: count(
            state,
            "SELECT count(*) FROM users WHERE banned = true",
            None,
        )
        .await?,
        locked_users: count(
            state,
            "SELECT count(*) FROM users WHERE locked = true \
             AND (lockout_expires_at IS NULL OR lockout_expires_at > $1)",
            Some(now),
        )
        .await?,
        mfa_enabled_users: count(
            state,
            "SELECT count(*) FROM users u WHERE u.totp_verified = true OR EXISTS ( \
                 SELECT 1 FROM phone_numbers p WHERE p.user_id = u.id \
                 AND p.reserved_for_second_factor = true AND p.verified = true)",
            None,
        )
        .await?,
        top_social_providers: providers
            .into_iter()
            .map(|(provider, count)| ProviderCount { provider, count })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_dates_match_javascript() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(86_400_000), "1970-01-02");
        // 2024-02-29T23:59:59Z
        assert_eq!(utc_date(1_709_251_199_000), "2024-02-29");
    }

    #[test]
    fn series_is_thirty_days_oldest_first() {
        let days = last_days(30, 1_709_251_199_000);
        assert_eq!(days.len(), 30);
        assert_eq!(days[29], "2024-02-29");
        assert_eq!(days[0], "2024-01-31");
    }
}
