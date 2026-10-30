import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { OrbitError, ErrorCodes, COOKIES } from "@orbitid/shared";
import type { AppContext } from "./context";
import { safeEqual } from "./lib/crypto";
import { clientIp } from "./lib/http";
import { hit } from "./lib/rate-limit";
import { logSafe } from "./lib/security";
import { findOperatorSession, operatorCookieOriginAllowed } from "./services/operator-session";

/** Failed secret-key attempts per IP: more than this in the window locks the address out briefly. */
const SECRET_KEY_MAX_FAILURES = 10;
const SECRET_KEY_WINDOW_MS = 5 * 60_000;

/**
 * Backend API auth. Two credentials are accepted:
 *
 * - `Authorization: Bearer sk_...`, the instance secret key, compared in constant time. This is the
 *   credential servers, SDKs and scripts use, and it is unchanged.
 * - The dashboard's httpOnly operator-session cookie, which only a same-origin browser can present. It is
 *   minted by exchanging the secret key once (`POST /v1/operator_sessions`), stores only a token hash, and
 *   can be revoked and expires. The key itself never reaches the browser again.
 *
 * Keys in the query string are refused (they end up in proxy logs, browser history and Referer headers),
 * and failed bearer attempts are rate limited per address.
 */
export const requireSecretKey = (ctx: AppContext): MiddlewareHandler => async (c, next) => {
  if (c.req.query("secret_key") || c.req.query("api_key") || c.req.query("token")) {
    throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Send the secret key in the Authorization header, never in the query string");
  }
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (token) {
    if (safeEqual(token, ctx.env.secretKey)) return next();
    await hit(ctx, `secret_key_failure:${clientIp(c)}`, SECRET_KEY_MAX_FAILURES, SECRET_KEY_WINDOW_MS);
    console.warn(`[auth] rejected secret key from ${logSafe(clientIp(c))} (wrong value)`);
    throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Invalid secret key");
  }

  // No bearer token: the only other accepted credential is the dashboard's same-origin session cookie.
  if (getCookie(c, COOKIES.operator)) {
    if (!operatorCookieOriginAllowed(ctx, c)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Cross-origin requests cannot use the dashboard session. Send a secret key instead.");
    }
    if (await findOperatorSession(ctx, c)) return next();
    throw new OrbitError(401, ErrorCodes.authentication_invalid, "Your dashboard session ended. Sign in again.");
  }

  await hit(ctx, `secret_key_failure:${clientIp(c)}`, SECRET_KEY_MAX_FAILURES, SECRET_KEY_WINDOW_MS);
  console.warn(`[auth] rejected secret key from ${logSafe(clientIp(c))} (missing)`);
  throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Invalid secret key");
};
