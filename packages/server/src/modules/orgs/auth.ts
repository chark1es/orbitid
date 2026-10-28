// Minimal caller resolution for Frontend API organization routes.
// The auth modules own the full client/session surface; this helper only answers "which user is calling?".
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { sha256 } from "../../lib/crypto";
import { verifySessionToken } from "../../services/tokens";
import { first } from "../../lib/db";

export type UserRow = typeof s.users.$inferSelect;
export type SessionRow = typeof s.sessions.$inferSelect;

export interface Caller {
  user: UserRow;
  userId: string;
  sessionId: string;
}

const looksLikeJwt = (token: string) => token.split(".").length === 3;

function activeSession(row: SessionRow | undefined): row is SessionRow {
  return !!row && row.status === "active" && row.expireAt > Date.now();
}

async function sessionUser(ctx: AppContext, row: SessionRow): Promise<Caller | null> {
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  return user ? { user, userId: user.id, sessionId: row.id } : null;
}

/**
 * Resolves the calling user from (in order): `x-orbitid-session-id` header / `?_session_id` query hint,
 * `Authorization: Bearer <session JWT>`, or the opaque `__client` cookie (+ that client's active session).
 * Returns null when nobody is signed in.
 */
export async function tryResolveCaller(ctx: AppContext, c: Context): Promise<Caller | null> {
  const hinted = c.req.header("x-orbitid-session-id") ?? c.req.query("_session_id") ?? null;
  const authorization = c.req.header("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";

  if (bearer && looksLikeJwt(bearer)) {
    // Malformed / expired / foreign tokens simply mean "not signed in" for organization routes.
    const claims = await verifySessionToken(ctx, bearer).catch(() => null);
    const row = claims?.sid ? first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, claims.sid))) : undefined;
    if (activeSession(row) && row.userId === claims?.sub) return sessionUser(ctx, row);
    return null;
  }

  const clientToken = getCookie(c, COOKIES.client) ?? (bearer && !looksLikeJwt(bearer) ? bearer : null);
  if (!clientToken) return null;
  const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(clientToken))));
  if (!client) return null;

  const belongs = async (sessionId: string | null | undefined): Promise<SessionRow | undefined> => {
    if (!sessionId) return undefined;
    const row = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
    return row && row.clientId === client.id ? row : undefined;
  };

  const hintedRow = await belongs(hinted);
  if (activeSession(hintedRow)) return sessionUser(ctx, hintedRow);
  const lastActive = await belongs(client.lastActiveSessionId);
  if (activeSession(lastActive)) return sessionUser(ctx, lastActive);

  const fallback = first(await ctx.db
      .select()
      .from(s.sessions)
      .where(and(eq(s.sessions.clientId, client.id), eq(s.sessions.status, "active")))
      .orderBy(desc(s.sessions.lastActiveAt)));
  return activeSession(fallback) ? await sessionUser(ctx, fallback) : null;
}

/** Same as {@link tryResolveCaller} but throws a 401 when nobody is signed in. */
export async function resolveCaller(ctx: AppContext, c: Context): Promise<Caller> {
  const caller = await tryResolveCaller(ctx, c);
  if (!caller) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not authenticated");
  return caller;
}
