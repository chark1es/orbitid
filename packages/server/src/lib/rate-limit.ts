import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "../context";
import { rateLimits } from "../db/schema";
import { clientIp } from "./http";
import { first } from "./db";

/** Fixed-window counter in sqlite. Throws 429 when exceeded. */
export async function hit(ctx: AppContext, key: string, max: number, windowMs: number) {
  if (!ctx.settings.get().security.rateLimitEnabled) return;
  const now = Date.now();
  const row = first(await ctx.db.select().from(rateLimits).where(eq(rateLimits.key, key)));
  if (!row || row.resetAt <= now) {
    await ctx.db.insert(rateLimits).values({ key, count: 1, resetAt: now + windowMs }).onConflictDoUpdate({ target: rateLimits.key, set: { count: 1, resetAt: now + windowMs } });
    return;
  }
  if (row.count >= max) {
    throw new OrbitError(429, ErrorCodes.rate_limit_exceeded, "Too many requests. Please try again later.", { retry_after: Math.ceil((row.resetAt - now) / 1000) });
  }
  await ctx.db.update(rateLimits).set({ count: row.count + 1 }).where(eq(rateLimits.key, key));
}

export const rateLimit = (ctx: AppContext, name: string, max: number, windowMs: number): MiddlewareHandler => async (c, next) => {
  await hit(ctx, `${name}:${clientIp(c)}`, max, windowMs);
  await next();
};
