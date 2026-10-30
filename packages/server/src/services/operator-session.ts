// Dashboard operator sessions: exchange the instance secret key once for an opaque, revocable cookie.
//
// The browser posts the key once to `POST /v1/operator_sessions` and does not retain it after sign-in. The server
// compares it in constant time (rate limited per address), and answers with an httpOnly cookie whose token
// is stored only as a sha256 hash. Every later Backend API call from the dashboard authenticates with that
// cookie instead of a bearer secret. `Authorization: Bearer sk_...` keeps working unchanged for servers/SDKs.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { COOKIES, ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { hmacSha256, randomToken, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { clientIp } from "../lib/http";
import { first } from "../lib/db";

/** 8 hours: long enough for a working day, short enough that a stolen cookie ages out. */
export const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** Failed key exchanges per address before the caller is locked out briefly. Mirrors the bearer gate. */
export const OPERATOR_KEY_MAX_FAILURES = 10;
export const OPERATOR_KEY_WINDOW_MS = 5 * 60_000;

/** The cookie is scoped to `/v1` so it is never sent to the dashboard's own HTML or static assets. */
const COOKIE_PATH = "/v1";

/** Stable, non-reversible tag of the secret key; rotating the key invalidates every operator session. */
export function keyFingerprint(secretKey: string): string {
  return hmacSha256(secretKey, "orbitid/operator-session/fingerprint").toString("base64url");
}

/**
 * `Secure` whenever the instance is served over https. `SameSite=Strict` because the dashboard is
 * same-origin: no cross-site request ever needs to carry this cookie, and Strict means a malicious site
 * cannot even trigger a credentialled read.
 */
function cookieOptions(ctx: AppContext) {
  return {
    httpOnly: true as const,
    secure: ctx.env.baseUrl.startsWith("https://"),
    sameSite: "Strict" as const,
    path: COOKIE_PATH,
    maxAge: Math.floor(OPERATOR_SESSION_TTL_MS / 1000),
  };
}

export type OperatorSessionRow = typeof s.operatorSessions.$inferSelect;

export interface IssuedOperatorSession {
  row: OperatorSessionRow;
  /** Plaintext token, only ever placed in the response cookie. Never logged, never returned in JSON. */
  token: string;
}

/** Creates a session row and returns its plaintext token (for the httpOnly cookie only). */
export async function issueOperatorSession(ctx: AppContext, c: Context): Promise<IssuedOperatorSession> {
  const token = randomToken(32);
  const now = Date.now();
  const id = newId(ID_PREFIX.operatorSession);
  await ctx.db.insert(s.operatorSessions).values({
    id,
    tokenHash: sha256(token),
    keyFingerprint: keyFingerprint(ctx.env.secretKey),
    userAgent: c.req.header("user-agent") ?? null,
    ipAddress: clientIp(c),
    expiresAt: now + OPERATOR_SESSION_TTL_MS,
    createdAt: now,
    updatedAt: now,
  });
  // Expired and revoked rows are dead weight; sweep them now and then so the table stays small.
  if (Math.random() < 0.05) void sweepOperatorSessions(ctx);
  return { row: first(await ctx.db.select().from(s.operatorSessions).where(eq(s.operatorSessions.id, id)))!, token };
}

export function setOperatorCookie(c: Context, ctx: AppContext, token: string): void {
  setCookie(c, COOKIES.operator, token, cookieOptions(ctx));
}

export function clearOperatorCookie(c: Context): void {
  deleteCookie(c, COOKIES.operator, { path: COOKIE_PATH });
}

/**
 * Resolves the operator session behind the request, or null when there is none. An expired, revoked or
 * key-mismatched session is rejected; a stale row is left for the expiry sweep rather than deleted here.
 */
export async function findOperatorSession(ctx: AppContext, c: Context): Promise<OperatorSessionRow | null> {
  const token = getCookie(c, COOKIES.operator);
  if (!token) return null;
  const row = first(await ctx.db.select().from(s.operatorSessions).where(eq(s.operatorSessions.tokenHash, sha256(token))));
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= Date.now()) return null;
  // A rotated secret key ends sessions approved with the previous key.
  if (row.keyFingerprint !== keyFingerprint(ctx.env.secretKey)) return null;
  return row;
}

/** Revokes the session behind this request, if any. Idempotent. */
export async function revokeOperatorSession(ctx: AppContext, c: Context): Promise<boolean> {
  const token = getCookie(c, COOKIES.operator);
  if (!token) return false;
  const now = Date.now();
  const row = first(await ctx.db
      .update(s.operatorSessions)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(s.operatorSessions.tokenHash, sha256(token)), isNull(s.operatorSessions.revokedAt)))
      .returning());
  return !!row;
}

/** Revokes every operator session for the current secret key (used by tests and key rotation). */
export async function revokeAllOperatorSessions(ctx: AppContext): Promise<void> {
  await ctx.db
            .update(s.operatorSessions)
            .set({ revokedAt: Date.now(), updatedAt: Date.now() })
            .where(and(eq(s.operatorSessions.keyFingerprint, keyFingerprint(ctx.env.secretKey)), isNull(s.operatorSessions.revokedAt)));
}

/** Removes rows that can no longer authenticate anyone. Best effort: the table must not grow without bound. */
export async function sweepOperatorSessions(ctx: AppContext): Promise<void> {
  const now = Date.now();
  await ctx.db
            .delete(s.operatorSessions)
            .where(or(lte(s.operatorSessions.expiresAt, now), isNotNull(s.operatorSessions.revokedAt)))
            .catch(() => undefined);
}

/** Origins a browser presents on a same-origin request: this server's own origin, and nothing else. */
function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * A cookie is an ambient credential, so a request that uses one must provably come from this instance's own
 * origin. `Origin`/`Referer` are checked when present (the server sends `Referrer-Policy: no-referrer`, and a
 * same-origin GET carries neither); `Sec-Fetch-Site` is checked when present and must say `same-origin` or
 * `none`. A request with no such header at all is not a browser cross-site request, and still needs a valid
 * 256-bit token. `SameSite=Strict` on the cookie is the second layer: a browser never attaches it cross-site.
 *
 * Only this instance's own origin qualifies: `settings.application.developmentMode` and
 * `application.allowedOrigins` govern the Frontend API's CORS, not this credential. `bun run dev:dashboard`
 * therefore proxies the API and rewrites `Origin` to this server (see `apps/dashboard/vite.config.ts`) instead
 * of the server trusting an arbitrary localhost port.
 */
export const operatorCookieOriginAllowed = (ctx: AppContext, c: { req: { header(name: string): string | undefined } }): boolean => {
  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const own = originOf(ctx.env.baseUrl);
  if (!own) return false;
  // An explicit `Origin` is authoritative: `null`, a malformed value or another host is a refusal, and
  // `Referer` is never consulted in its place. Browsers always send `Origin` on a cross-origin request.
  const origin = c.req.header("origin");
  if (origin !== undefined) return originOf(origin) === own;
  // No `Origin` at all: same-origin navigations and non-browser clients. A `Referer` is used only if present.
  const referer = c.req.header("referer");
  if (referer !== undefined) return originOf(referer) === own;
  return true;
};
