// Client (browser/device) authentication + ClientJSON serialization.
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import { COOKIES, ErrorCodes, OrbitError, type ClientJSON, type SessionJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { clientIp } from "../../lib/http";
import { serializeSession } from "../../serializers";
import { evaluateSessionStatus, getSession, isSessionExpired } from "../../services/sessions";
import { signSessionToken } from "../../services/tokens";
import { buildSignInJSON } from "./signin-core";
import { buildSignUpJSON } from "./signup-core";

export type ClientRow = typeof s.clients.$inferSelect;

const ONE_YEAR_SECONDS = 365 * 24 * 3600;

export function setClientCookie(c: Context, _ctx: AppContext, token: string) {
  setCookie(c, COOKIES.client, token, {
    httpOnly: true,
    secure: _ctx.env.baseUrl.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
}

export function clearClientCookie(c: Context, _ctx: AppContext) {
  deleteCookie(c, COOKIES.client, { path: "/" });
}

function readClientToken(c: Context): string | null {
  const cookie = c.req.header("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${COOKIES.client.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}=([^;]+)`).exec(cookie);
  const fromCookie = match?.[1];
  if (fromCookie) return decodeURIComponent(fromCookie);
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && !token.startsWith("sk_") && !token.startsWith("pk_")) return token;
  }
  const header = c.req.header("x-orbitid-client");
  return header || null;
}

/** Creates a client row, returns it plus the opaque token that must be set as a cookie. */
export function createClient(ctx: AppContext, c: Context): { row: ClientRow; token: string } {
  const token = randomToken(32);
  const id = newId("client");
  const now = Date.now();
  ctx.db.insert(s.clients).values({
    id, tokenHash: sha256(token), ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null, createdAt: now, updatedAt: now,
  }).run();
  return { row: ctx.db.select().from(s.clients).where(eq(s.clients.id, id)).get()!, token };
}

/** Looks up the client from the cookie / bearer token without creating one. */
export function findClient(ctx: AppContext, c: Context): ClientRow | null {
  const token = readClientToken(c);
  if (!token) return null;
  return ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(token))).get() ?? null;
}

/** Returns the request's client, creating one (and setting the httpOnly cookie) when absent. */
export function getOrCreateClient(ctx: AppContext, c: Context): ClientRow {
  const existing = findClient(ctx, c);
  if (existing) return existing;
  const { row, token } = createClient(ctx, c);
  setClientCookie(c, ctx, token);
  return row;
}

export function requireClient(ctx: AppContext, c: Context): ClientRow {
  const client = findClient(ctx, c);
  if (!client) throw new OrbitError(401, ErrorCodes.client_state_invalid, "No client found. Reload the page to create one.");
  return client;
}

/** Rotates the opaque client token (used after an OAuth form_post callback where the cookie may be missing). */
export function regenerateClientToken(ctx: AppContext, c: Context, clientId: string): string {
  const token = randomToken(32);
  ctx.db.update(s.clients).set({ tokenHash: sha256(token), updatedAt: Date.now() }).where(eq(s.clients.id, clientId)).run();
  setClientCookie(c, ctx, token);
  return token;
}

export const clientAzp = (c: Context): string | undefined => {
  const origin = c.req.header("origin");
  if (origin) return origin;
  const referer = c.req.header("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
};

/** Latest in-flight sign_in / sign_up for the client (completed attempts are hidden from the SDK). */
function inflightSignIn(ctx: AppContext, clientId: string) {
  const row = ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)).orderBy(desc(s.signIns.createdAt)).get();
  return row && row.status !== "complete" && row.status !== "abandoned" ? row : undefined;
}
function inflightSignUp(ctx: AppContext, clientId: string) {
  const row = ctx.db.select().from(s.signUps).where(eq(s.signUps.clientId, clientId)).orderBy(desc(s.signUps.createdAt)).get();
  return row && row.status !== "complete" && row.status !== "abandoned" ? row : undefined;
}

/** Wire representation of a client including its sessions (with users) and freshly minted session tokens. */
export async function serializeClient(ctx: AppContext, client: ClientRow, opts: { azp?: string } = {}): Promise<ClientJSON> {
  const fresh = ctx.db.select().from(s.clients).where(eq(s.clients.id, client.id)).get() ?? client;
  const rows = ctx.db.select().from(s.sessions).where(eq(s.sessions.clientId, fresh.id)).orderBy(desc(s.sessions.createdAt)).all();
  const sessions: SessionJSON[] = [];
  for (const stored of rows) {
    const status = evaluateSessionStatus(ctx, stored);
    if (status === "expired") continue;
    const row = { ...stored, status };
    let token: string | null = null;
    if ((status === "active" || status === "pending") && !isSessionExpired(ctx, row)) {
      try {
        token = await signSessionToken(ctx, row.id, { azp: opts.azp });
      } catch {
        token = null;
      }
    }
    sessions.push({ ...serializeSession(ctx, row, { withUser: true, lastToken: token }), last_active_token: token ? { object: "token", jwt: token } : null });
  }
  const signInRow = inflightSignIn(ctx, fresh.id);
  const signUpRow = inflightSignUp(ctx, fresh.id);
  return {
    object: "client",
    id: fresh.id,
    sessions,
    sign_in: signInRow ? buildSignInJSON(ctx, signInRow) : null,
    sign_up: signUpRow ? buildSignUpJSON(ctx, signUpRow) : null,
    last_active_session_id: fresh.lastActiveSessionId ?? null,
    cookie_expires_at: Date.now() + ONE_YEAR_SECONDS * 1000,
    created_at: fresh.createdAt,
    updated_at: fresh.updatedAt,
  };
}

/** Active session for the client (the one the SDK is using), or null. */
export function activeClientSession(ctx: AppContext, client: ClientRow) {
  if (client.lastActiveSessionId) {
    const row = getSession(ctx, client.lastActiveSessionId);
    const status = row && row.clientId === client.id ? evaluateSessionStatus(ctx, row) : null;
    if (row && (status === "active" || status === "pending")) return { ...row, status };
  }
  const rows = ctx.db.select().from(s.sessions)
    .where(and(eq(s.sessions.clientId, client.id), eq(s.sessions.status, "active")))
    .orderBy(desc(s.sessions.lastActiveAt)).all();
  const row = rows.find((candidate) => {
    const status = evaluateSessionStatus(ctx, candidate);
    return status === "active" || status === "pending";
  });
  return row ? { ...row, status: evaluateSessionStatus(ctx, row) } : null;
}

/** The signed-in user for a client (throw when there is none). */
export function requireActiveUser(ctx: AppContext, client: ClientRow) {
  const session = activeClientSession(ctx, client);
  if (!session) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
  const user = ctx.db.select().from(s.users).where(eq(s.users.id, session.userId)).get();
  if (!user) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
  if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
  return { session, user };
}
