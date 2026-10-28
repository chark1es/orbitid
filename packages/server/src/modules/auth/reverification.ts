// Session reverification enforcement + helpers.
import type { Context, MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, type ReverificationLevel } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { findClient, type ClientRow } from "./client-auth";
import { evaluateSessionStatus } from "../../services/sessions";

const ageMinutes = (t: number | null) => (t ? Math.floor((Date.now() - t) / 60_000) : null);

/** True when the session verified `level` within `afterMinutes`. */
export function isReverified(session: typeof s.sessions.$inferSelect, level: ReverificationLevel, afterMinutes: number): boolean {
  const within = (t: number | null) => !!t && Date.now() - t <= afterMinutes * 60_000;
  if (level === "first_factor") return within(session.firstFactorVerifiedAt);
  if (level === "second_factor") return within(session.secondFactorVerifiedAt);
  return within(session.firstFactorVerifiedAt) && within(session.secondFactorVerifiedAt);
}

export interface SessionContext { client: ClientRow; session: typeof s.sessions.$inferSelect }

/** The active session of the request's client, if any (expiry-aware). */
export function requestSession(ctx: AppContext, c: Context): SessionContext | null {
  const client = findClient(ctx, c);
  if (!client?.lastActiveSessionId) return null;
  const row = ctx.db.select().from(s.sessions).where(and(eq(s.sessions.id, client.lastActiveSessionId), eq(s.sessions.clientId, client.id))).get();
  if (!row) return null;
  const status = evaluateSessionStatus(ctx, row);
  if (status !== "active" && status !== "pending") return null;
  return { client, session: { ...row, status } };
}

/**
 * Hono middleware for sensitive mutations: returns 403 `session_reverification_required` with meta when the
 * session's last factor verification is older than `afterMinutes`.
 */
export function requireReverification(ctx: AppContext, level: ReverificationLevel = "first_factor", afterMinutes = 10): MiddlewareHandler {
  return async (c, next) => {
    const found = requestSession(ctx, c);
    if (!found) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
    if (!isReverified(found.session, level, afterMinutes)) {
      throw new OrbitError(403, ErrorCodes.reverification_required, "Session verification is required to perform this action", {
        level,
        after_minutes: afterMinutes,
        session_id: found.session.id,
        first_factor_age_minutes: ageMinutes(found.session.firstFactorVerifiedAt),
        second_factor_age_minutes: ageMinutes(found.session.secondFactorVerifiedAt),
      });
    }
    await next();
  };
}

/** Current verification ages (minutes; null = never). */
export const verificationAges = (session: typeof s.sessions.$inferSelect) => ({
  first_factor: ageMinutes(session.firstFactorVerifiedAt),
  second_factor: ageMinutes(session.secondFactorVerifiedAt),
});
