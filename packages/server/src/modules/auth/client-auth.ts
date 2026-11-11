// Client (browser/device) authentication + ClientJSON serialization.
import { findAsync } from "../../lib/async";
import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { and, desc, eq } from "drizzle-orm";
import { COOKIE_MAX_AGE_SECONDS, COOKIES, ErrorCodes, OrbitError, type ClientJSON, type SessionJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { clientIp, requestIsSecure } from "../../lib/http";
import { serializeSession } from "../../serializers";
import { evaluateSessionStatus, getSession, isSessionExpired } from "../../services/sessions";
import { signSessionToken } from "../../services/tokens";
import { buildSignInJSON } from "./signin-core";
import { buildSignUpJSON } from "./signup-core";
import { first } from "../../lib/db";

export type ClientRow = typeof s.clients.$inferSelect;

const CLIENT_COOKIE_MAX_AGE_SECONDS = COOKIE_MAX_AGE_SECONDS;
/** Re-issue the same client cookie when it is at least this old, so an actively used browser never hits the cap. */
const CLIENT_COOKIE_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export function setClientCookie(c: Context, _ctx: AppContext, token: string) {
  // The browser's client cookie is the thing that keeps a visitor signed in across restarts: it must not be a
  // session cookie (gone when the browser closes) and must not expire while the account is alive. It is rewritten
  // on every client creation and sign-in, so the 400-day browser cap keeps rolling forward.
  setCookie(c, COOKIES.client, token, {
    httpOnly: true,
    // Behind a TLS-terminating proxy `ORBITID_BASE_URL` is https; for a plain-http localhost instance the
    // browser would reject `Secure`. `requestIsSecure` also honours a trusted `X-Forwarded-Proto`.
    secure: requestIsSecure(c, _ctx.env.baseUrl),
    sameSite: "Lax",
    path: "/",
    maxAge: CLIENT_COOKIE_MAX_AGE_SECONDS,
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
export async function createClient(ctx: AppContext, c: Context): Promise<{ row: ClientRow; token: string }> {
  const token = randomToken(32);
  const id = newId("client");
  const now = Date.now();
  await ctx.db.insert(s.clients).values({
            id, tokenHash: sha256(token), tokenIssuedAt: now, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null, createdAt: now, updatedAt: now,
          });
  return { row: first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, id)))!, token };
}

/** Looks up the client from the cookie / bearer token without creating one. */
export async function findClient(ctx: AppContext, c: Context): Promise<ClientRow | null> {
  const token = readClientToken(c);
  if (!token) return null;
  return first(await ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(token)))) ?? null;
}

/** Returns the request's client, creating one (and setting the httpOnly cookie) when absent. */
export async function getOrCreateClient(ctx: AppContext, c: Context): Promise<ClientRow> {
  const existing = await findClient(ctx, c);
  if (existing) {
    // A browser kept alive only by daily use must not lose its credential at the 400-day cap: re-issue the same
    // token (no rotation) once it is a day old. Rotation is reserved for sign-in and recovery.
    await renewClientCookieIfDue(ctx, c, existing);
    return existing;
  }
  // A token was presented but no row matches. It was rotated by a sign-in in another tab, or the database was
  // restored. Minting a replacement client here and overwriting the cookie would wipe a live sign-in that the
  // other tab just established (a random-looking sign-out). Only the SDK's own bootstrap (`GET /v1/client`) may
  // recover by creating a client; every other request is told to reload, leaving the cookie untouched.
  if (readClientToken(c) !== null && !(c.req.method === "GET" && c.req.path === "/v1/client")) {
    throw new OrbitError(401, ErrorCodes.client_state_invalid, "This browser's client token is no longer valid. Reload the page to continue.");
  }
  const { row, token } = await createClient(ctx, c);
  setClientCookie(c, ctx, token);
  return row;
}

export async function requireClient(ctx: AppContext, c: Context): Promise<ClientRow> {
  const client = await findClient(ctx, c);
  if (!client) throw new OrbitError(401, ErrorCodes.client_state_invalid, "No client found. Reload the page to create one.");
  return client;
}

/** Rotates the opaque client token (used after an OAuth form_post callback where the cookie may be missing). */
export async function regenerateClientToken(ctx: AppContext, c: Context, clientId: string): Promise<string> {
  const token = randomToken(32);
  await ctx.db.update(s.clients).set({ tokenHash: sha256(token), tokenIssuedAt: Date.now(), updatedAt: Date.now() }).where(eq(s.clients.id, clientId));
  setClientCookie(c, ctx, token);
  return token;
}

/**
 * Re-issues the *same* opaque client token when the browser's cookie is old enough to be near the 400-day cap.
 * Nothing rotates: the token hash stays the same, so another tab's cookie keeps working. Called by the SDK
 * bootstrap (`GET /v1/client`), token refreshes and the handshake, i.e. every path an actively used browser takes.
 */
export async function renewClientCookieIfDue(ctx: AppContext, c: Context, client: ClientRow): Promise<boolean> {
  const token = readClientToken(c);
  if (!token) return false;
  const issuedAt = client.tokenIssuedAt ?? client.updatedAt ?? client.createdAt;
  if (Date.now() - issuedAt < CLIENT_COOKIE_RENEW_AFTER_MS) return false;
  const now = Date.now();
  setClientCookie(c, ctx, token);
  await ctx.db.update(s.clients).set({ tokenIssuedAt: now, updatedAt: now }).where(eq(s.clients.id, client.id));
  return true;
}

/**
 * Rotates the client token when a session is created from it, so a token captured before sign-in cannot
 * be replayed against the now-authenticated client (session fixation).
 */
export async function rotateClientTokenOnSignIn(ctx: AppContext, c: Context, clientId: string): Promise<void> {
  await regenerateClientToken(ctx, c, clientId);
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
async function inflightSignIn(ctx: AppContext, clientId: string) {
  const row = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)).orderBy(desc(s.signIns.createdAt)));
  return row && row.status !== "complete" && row.status !== "abandoned" ? row : undefined;
}
async function inflightSignUp(ctx: AppContext, clientId: string) {
  const row = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.clientId, clientId)).orderBy(desc(s.signUps.createdAt)));
  return row && row.status !== "complete" && row.status !== "abandoned" ? row : undefined;
}

/**
 * Wire representation of a client including its sessions (with users).
 *
 * Session JWTs are minted only for the client that is asking for itself: `opts.mintTokens` is set by the
 * Frontend API routes after they have authenticated the caller's own `__client` cookie. The Backend API's
 * `GET /v1/clients/:id` serializes the same shape with `mintTokens: false`, because returning fresh, valid
 * session JWTs for arbitrary clients would hand an operator a working session without any user action.
 */
export async function serializeClient(ctx: AppContext, client: ClientRow, opts: { azp?: string; mintTokens?: boolean } = {}): Promise<ClientJSON> {
  const fresh = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, client.id))) ?? client;
  const rows = (await ctx.db.select().from(s.sessions).where(eq(s.sessions.clientId, fresh.id)).orderBy(desc(s.sessions.createdAt)));
  const sessions: SessionJSON[] = [];
  for (const stored of rows) {
    const status = await evaluateSessionStatus(ctx, stored);
    if (status === "expired") continue;
    const row = { ...stored, status };
    let token: string | null = null;
    if (opts.mintTokens && (status === "active" || status === "pending") && !isSessionExpired(ctx, row)) {
      try {
        token = await signSessionToken(ctx, row.id, { azp: opts.azp });
      } catch {
        token = null;
      }
    }
    sessions.push({ ...await serializeSession(ctx, row, { withUser: true, lastToken: token }), last_active_token: token ? { object: "token", jwt: token } : null });
  }
  const signInRow = await inflightSignIn(ctx, fresh.id);
  const signUpRow = await inflightSignUp(ctx, fresh.id);
  return {
    object: "client",
    id: fresh.id,
    sessions,
    sign_in: signInRow ? await buildSignInJSON(ctx, signInRow) : null,
    sign_up: signUpRow ? await buildSignUpJSON(ctx, signUpRow) : null,
    last_active_session_id: fresh.lastActiveSessionId ?? null,
    cookie_expires_at: Date.now() + CLIENT_COOKIE_MAX_AGE_SECONDS * 1000,
    created_at: fresh.createdAt,
    updated_at: fresh.updatedAt,
  };
}

/** Active session for the client (the one the SDK is using), or null. */
export async function activeClientSession(ctx: AppContext, client: ClientRow) {
  if (client.lastActiveSessionId) {
    const row = await getSession(ctx, client.lastActiveSessionId);
    const status = row && row.clientId === client.id ? await evaluateSessionStatus(ctx, row) : null;
    if (row && (status === "active" || status === "pending")) return { ...row, status };
  }
  const rows = (await ctx.db.select().from(s.sessions)
      .where(and(eq(s.sessions.clientId, client.id), eq(s.sessions.status, "active")))
      .orderBy(desc(s.sessions.lastActiveAt)));
  const row = await findAsync(rows, async (candidate) => {
    const status = await evaluateSessionStatus(ctx, candidate);
    return status === "active" || status === "pending";
  });
  return row ? { ...row, status: await evaluateSessionStatus(ctx, row) } : null;
}

/** The signed-in user for a client (throw when there is none). */
export async function requireActiveUser(ctx: AppContext, client: ClientRow) {
  const session = await activeClientSession(ctx, client);
  if (!session) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, session.userId)));
  if (!user) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not signed in");
  if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
  return { session, user };
}
