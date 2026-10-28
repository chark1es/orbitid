import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "../context";
import { rateLimits } from "../db/schema";
import { clientIp } from "./http";

/** Fixed-window counter in sqlite. Throws 429 when exceeded. */
export function hit(ctx: AppContext, key: string, max: number, windowMs: number) {
  if (!ctx.settings.get().security.rateLimitEnabled) return;
  const now = Date.now();
  const row = ctx.db.select().from(rateLimits).where(eq(rateLimits.key, key)).get();
  if (!row || row.resetAt <= now) {
    ctx.db.insert(rateLimits).values({ key, count: 1, resetAt: now + windowMs }).onConflictDoUpdate({ target: rateLimits.key, set: { count: 1, resetAt: now + windowMs } }).run();
    return;
  }
  if (row.count >= max) {
    throw new OrbitError(429, ErrorCodes.rate_limit_exceeded, "Too many requests. Please try again later.", { retry_after: Math.ceil((row.resetAt - now) / 1000) });
  }
  ctx.db.update(rateLimits).set({ count: row.count + 1 }).where(eq(rateLimits.key, key)).run();
}

export const rateLimit = (ctx: AppContext, name: string, max: number, windowMs: number): MiddlewareHandler => async (c, next) => {
  hit(ctx, `${name}:${clientIp(c)}`, max, windowMs);
  await next();
};
