// Aggregate instance statistics for the dashboard overview (`GET /v1/stats`).
import type { AppContext } from "../context";

export interface DailyCount { date: string; count: number }
export interface InstanceStatsJSON {
  users_total: number;
  users_active_7d: number;
  sessions_active: number;
  organizations_total: number;
  signups_by_day: DailyCount[];
  signins_by_day: DailyCount[];
  banned_users: number;
  locked_users: number;
  mfa_enabled_users: number;
  top_social_providers: { provider: string; count: number }[];
}

const DAY_MS = 86_400_000;

/** `n` UTC days ending today, oldest first — used to zero-fill chart series. */
function lastDays(n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

/** Groups `table.column` rows by UTC day for the last 30 days. */
function byDay(ctx: AppContext, table: "users" | "sessions", column: "created_at", now: number): DailyCount[] {
  const rows = ctx.raw
    .prepare(`SELECT date(${column} / 1000, 'unixepoch') AS day, count(*) AS count FROM ${table} WHERE ${column} >= ? GROUP BY day`)
    .all(now - 30 * DAY_MS) as { day: string; count: number }[];
  const counts = new Map(rows.map((r) => [r.day, Number(r.count)]));
  return lastDays(30, now).map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function instanceStats(ctx: AppContext): InstanceStatsJSON {
  const now = Date.now();
  const raw = ctx.raw;

  const scalar = (query: string, ...params: unknown[]) => {
    const row = raw.prepare(query).get(...params) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };

  return {
    users_total: scalar(`SELECT count(*) AS n FROM users`),
    users_active_7d: scalar(`SELECT count(*) AS n FROM users WHERE last_active_at IS NOT NULL AND last_active_at >= ?`, now - 7 * DAY_MS),
    sessions_active: scalar(`SELECT count(*) AS n FROM sessions WHERE status = 'active' AND expire_at > ?`, now),
    organizations_total: scalar(`SELECT count(*) AS n FROM organizations`),
    signups_by_day: byDay(ctx, "users", "created_at", now),
    signins_by_day: byDay(ctx, "sessions", "created_at", now),
    banned_users: scalar(`SELECT count(*) AS n FROM users WHERE banned = 1`),
    locked_users: scalar(`SELECT count(*) AS n FROM users WHERE locked = 1 AND (lockout_expires_at IS NULL OR lockout_expires_at > ?)`, now),
    mfa_enabled_users: scalar(`SELECT count(*) AS n FROM users WHERE totp_verified = 1 OR (backup_codes IS NOT NULL AND backup_codes != '[]')`),
    top_social_providers: (raw
      .prepare(`SELECT provider, count(*) AS count FROM external_accounts GROUP BY provider ORDER BY count DESC, provider ASC LIMIT 10`)
      .all() as { provider: string; count: number }[]).map((r) => ({ provider: r.provider, count: Number(r.count) })),
  };
}
