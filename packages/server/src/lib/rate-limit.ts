import type { MiddlewareHandler } from "hono";
import { lte, sql } from "drizzle-orm";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "../context";
import { rateLimits } from "../db/schema";
import { clientIp } from "./http";
import { first } from "./db";

/** Fixed-window counter. Throws 429 when exceeded. */
export async function hit(ctx: AppContext, key: string, max: number, windowMs: number) {
  if (!ctx.settings.get().security.rateLimitEnabled) return;
  const now = Date.now();
  const resetAt = now + windowMs;
  const row = first(await ctx.db.insert(rateLimits)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.resetAt} <= ${now} then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} <= ${now} then ${resetAt} else ${rateLimits.resetAt} end`,
      },
    })
    .returning());
  // Expired windows are dead weight; sweep them now and then so spoofed or rotating keys cannot grow the table forever.
  if (Math.random() < 0.01) void ctx.db.delete(rateLimits).where(lte(rateLimits.resetAt, now)).catch(() => undefined);
  if (row && row.count > max) {
    throw new OrbitError(429, ErrorCodes.rate_limit_exceeded, "Too many requests. Please try again later.", { retry_after: Math.ceil((row.resetAt - now) / 1000) });
  }
}

export const rateLimit = (ctx: AppContext, name: string, max: number, windowMs: number): MiddlewareHandler => async (c, next) => {
  await hit(ctx, `${name}:${clientIp(c)}`, max, windowMs);
  await next();
};
