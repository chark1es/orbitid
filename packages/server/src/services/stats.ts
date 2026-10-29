// Aggregate instance statistics for the dashboard overview (`GET /v1/stats`).
import { and, asc, count, desc, eq, exists, gt, gte, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { AppContext } from "../context";
import * as s from "../db/schema";

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

/** Counts rows per UTC day for the last 30 days, bucketed here so it works the same on every database. */
async function byDay(ctx: AppContext, createdAt: { column: PgColumn }, from: PgTable, now: number): Promise<DailyCount[]> {
  const rows = await ctx.db.select({ at: createdAt.column }).from(from).where(gte(createdAt.column, now - 30 * DAY_MS));
  const counts = new Map<string, number>();
  for (const { at } of rows) {
    const day = new Date(Number(at)).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return lastDays(30, now).map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export async function instanceStats(ctx: AppContext): Promise<InstanceStatsJSON> {
  const now = Date.now();
  const total = async (table: PgTable, where?: SQL) => {
    const [row] = await ctx.db.select({ n: count() }).from(table).where(where);
    return row?.n ?? 0;
  };
  const providers = await ctx.db
    .select({ provider: s.externalAccounts.provider, count: count() })
    .from(s.externalAccounts)
    .groupBy(s.externalAccounts.provider)
    .orderBy(desc(sql`count(*)`), asc(s.externalAccounts.provider))
    .limit(10);

  return {
    users_total: await total(s.users),
    users_active_7d: await total(s.users, and(isNotNull(s.users.lastActiveAt), gte(s.users.lastActiveAt, now - 7 * DAY_MS))),
    sessions_active: await total(s.sessions, and(eq(s.sessions.status, "active"), gt(s.sessions.expireAt, now))),
    organizations_total: await total(s.organizations),
    signups_by_day: await byDay(ctx, { column: s.users.createdAt }, s.users, now),
    signins_by_day: await byDay(ctx, { column: s.sessions.createdAt }, s.sessions, now),
    banned_users: await total(s.users, eq(s.users.banned, true)),
    locked_users: await total(s.users, and(eq(s.users.locked, true), or(isNull(s.users.lockoutExpiresAt), gt(s.users.lockoutExpiresAt, now)))),
    mfa_enabled_users: await total(s.users, or(eq(s.users.totpVerified, true), exists(ctx.db.select({ one: sql`1` }).from(s.phoneNumbers).where(and(eq(s.phoneNumbers.userId, s.users.id), eq(s.phoneNumbers.reservedForSecondFactor, true), eq(s.phoneNumbers.verified, true)))))),
    top_social_providers: providers,
  };
}
