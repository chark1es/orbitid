// resolves the signed-in caller for Frontend-API routes owned by this worker.
//
// The Frontend API is authenticated by the opaque `__client` cookie (or `Authorization: Bearer <client token>`),
// exactly like every other `/v1/client` route. `clients`/`sessions` rows are read directly instead of going through
// another worker's module so the machine routes stay self-contained.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { desc, eq } from "drizzle-orm";
import { COOKIES, ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { clients, sessions } from "../../db/schema";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { verifySessionToken } from "../../services/tokens";
import { isSessionExpired } from "../../services/sessions";
import { first } from "../../lib/db";

type ClientRow = typeof clients.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

export interface MachineCaller {
  clientId: string;
  client: ClientRow;
  sessionId: string | null;
  session: SessionRow | null;
  userId: string | null;
}

const isLiveSession = (ctx: AppContext, row: SessionRow | undefined | null): row is SessionRow =>
  !!row && row.status === "active" && !isSessionExpired(ctx, row);

/** Client's newest active session, preferring the one the client marked as active. */
async function activeSessionForClient(ctx: AppContext, client: ClientRow): Promise<SessionRow | null> {
  if (client.lastActiveSessionId) {
    const preferred = first(await ctx.db.select().from(sessions).where(eq(sessions.id, client.lastActiveSessionId)));
    if (isLiveSession(ctx, preferred)) return preferred;
  }
  const row = (await ctx.db.select().from(sessions)
      .where(eq(sessions.clientId, client.id))
      .orderBy(desc(sessions.lastActiveAt))
      .limit(10))
    .find((session) => isLiveSession(ctx, session));
  return row ?? null;
}

async function callerFromClient(ctx: AppContext, client: ClientRow): Promise<MachineCaller> {
  const session = await activeSessionForClient(ctx, client);
  return { clientId: client.id, client, sessionId: session?.id ?? null, session, userId: session?.userId ?? null };
}

/**
 * Resolves the caller from the `__client` cookie, falling back to a session JWT in `Authorization: Bearer`.
 * Returns null when there is no client/cookie or the session is not active.
 */
export async function resolveCaller(ctx: AppContext, c: Context): Promise<MachineCaller | null> {
  const cookie = getCookie(c, COOKIES.client);
  const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  if (cookie) {
    const client = first(await ctx.db.select().from(clients).where(eq(clients.tokenHash, sha256(cookie))));
    if (client) return callerFromClient(ctx, client);
  }
  if (bearer && !bearer.startsWith("sk_")) {
    try {
      const claims = await verifySessionToken(ctx, bearer);
      const session = first(await ctx.db.select().from(sessions).where(eq(sessions.id, claims.sid)));
      if (isLiveSession(ctx, session) && session.userId === claims.sub) {
        const client = first(await ctx.db.select().from(clients).where(eq(clients.id, session.clientId)));
        if (client) return { clientId: client.id, client, sessionId: session.id, session, userId: session.userId };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Like `resolveCaller` but throws `401 authentication_invalid`. */
export async function requireCaller(ctx: AppContext, c: Context): Promise<MachineCaller> {
  const caller = await resolveCaller(ctx, c);
  if (!caller) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
  return caller;
}

/** Like `requireCaller` but also requires an active session (i.e. a signed-in user). */
export async function requireUserCaller(ctx: AppContext, c: Context): Promise<MachineCaller & { userId: string; sessionId: string; session: SessionRow }> {
  const caller = await requireCaller(ctx, c);
  if (!caller.userId || !caller.sessionId || !caller.session) {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, "No active session. Please sign in.");
  }
  return caller as MachineCaller & { userId: string; sessionId: string; session: SessionRow };
}

/** Creates a client row + its opaque cookie token (used for IdP-initiated SSO where no browser client exists yet). */
export async function createClient(ctx: AppContext, info: { ip?: string; userAgent?: string } = {}): Promise<{ client: ClientRow; token: string }> {
  const token = randomToken(32);
  const client: ClientRow = {
    id: newId(ID_PREFIX.client),
    tokenHash: sha256(token),
    lastActiveSessionId: null,
    ip: info.ip ?? null,
    userAgent: info.userAgent ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await ctx.db.insert(clients).values(client);
  return { client, token };
}
