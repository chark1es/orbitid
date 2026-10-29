// Dashboard operator sessions: the one route that accepts the secret key from a browser.
//
// `POST /v1/operator_sessions` trades the secret key for an httpOnly cookie and never echoes the key back.
// The dashboard keeps nothing in storage; `GET` reports the session's expiry and `DELETE` revokes it.
// Everything else under `/v1` then accepts the cookie next to the unchanged bearer credential.
import { Hono } from "hono";
import { z } from "zod";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { parseBody } from "../lib/http";
import { clientIp } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { logSafe } from "../lib/security";
import { safeEqual } from "../lib/crypto";
import { audit } from "../services/audit";
import { OPERATOR_KEY_MAX_FAILURES, OPERATOR_KEY_WINDOW_MS, clearOperatorCookie, findOperatorSession, issueOperatorSession, operatorCookieOriginAllowed, revokeOperatorSession, setOperatorCookie } from "../services/operator-session";

const exchangeSchema = z.object({ secret_key: z.string().min(1) });

/**
 * A browser request that will receive a cookie must come from this instance. `Origin` is mandatory for a
 * cross-origin POST, so its absence plus `Sec-Fetch-Site: same-origin|none` (or no fetch metadata, e.g. a
 * test client) is what a same-origin form post looks like. A literal `Origin: null` is always refused.
 */
function assertExchangeOrigin(ctx: AppContext, c: { req: { header(name: string): string | undefined } }): void {
  const origin = c.req.header("origin");
  if (origin?.trim().toLowerCase() === "null") {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, "Cross-site request blocked.");
  }
  if (!operatorCookieOriginAllowed(ctx, c)) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, "Sign in from the dashboard served by this instance.");
  }
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  /** Exchanges the instance secret key for an httpOnly operator cookie. The key is not stored or returned. */
  app.post("/operator_sessions", async (c) => {
    assertExchangeOrigin(ctx, c);
    const body = await parseBody(c, exchangeSchema);

    // A wrong key is rate limited exactly like a wrong bearer token, against the same per-address budget:
    // the key is a root credential, and presenting it in two places must not double the guessing budget.
    if (!safeEqual(body.secret_key.trim(), ctx.env.secretKey)) {
      await hit(ctx, `secret_key_failure:${clientIp(c)}`, OPERATOR_KEY_MAX_FAILURES, OPERATOR_KEY_WINDOW_MS);
      console.warn(`[auth] rejected dashboard key exchange from ${logSafe(clientIp(c))}`);
      throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Invalid secret key");
    }

    // One session per browser: signing in again replaces the cookie, and abandoning the old one is harmless.
    await revokeOperatorSession(ctx, c).catch(() => undefined);
    const { row, token } = await issueOperatorSession(ctx, c);
    setOperatorCookie(c, ctx, token);
    await audit(ctx, { actor: "secret_key", action: "operator_session.created", targetType: "operator_session", targetId: row.id, ip: clientIp(c) });
    return c.json({ object: "operator_session" as const, id: row.id, expires_at: row.expiresAt }, 201);
  });

  /**
   * Says whether this browser still has a live session. The dashboard calls it on load, so a cookie that
   * expired or was revoked sends the operator to the sign-in screen without a flash of the shell.
   */
  app.get("/operator_sessions/current", async (c) => {
    // Same origin rule as every other path that answers a cookie-bearing request.
    if (!operatorCookieOriginAllowed(ctx, c)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Cross-origin requests cannot use the dashboard session.");
    }
    const row = await findOperatorSession(ctx, c);
    if (!row) {
      // Drop a cookie that no longer authenticates anything, so the browser stops sending it.
      if (c.req.header("cookie")?.includes(COOKIES.operator)) clearOperatorCookie(c);
      throw new OrbitError(401, ErrorCodes.authentication_invalid, "Your dashboard session ended. Sign in again.");
    }
    return c.json({ object: "operator_session" as const, id: row.id, expires_at: row.expiresAt });
  });

  /** Revokes this browser's session and clears the cookie. Safe to call without a session. */
  app.delete("/operator_sessions/current", async (c) => {
    if (!operatorCookieOriginAllowed(ctx, c)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Cross-site request blocked.");
    }
    const row = await findOperatorSession(ctx, c);
    await revokeOperatorSession(ctx, c);
    clearOperatorCookie(c);
    if (row) await audit(ctx, { actor: "secret_key", action: "operator_session.revoked", targetType: "operator_session", targetId: row.id, ip: clientIp(c) });
    return c.body(null, 204);
  });

  return app;
}
