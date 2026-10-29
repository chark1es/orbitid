import type { MiddlewareHandler } from "hono";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "./context";
import { safeEqual } from "./lib/crypto";
import { clientIp } from "./lib/http";
import { hit } from "./lib/rate-limit";
import { logSafe } from "./lib/security";

/** Failed secret-key attempts per IP: more than this in the window locks the address out briefly. */
const SECRET_KEY_MAX_FAILURES = 10;
const SECRET_KEY_WINDOW_MS = 5 * 60_000;

/**
 * Backend API auth: `Authorization: Bearer sk_...` must equal env secret key. The comparison is
 * constant time, retries from one address are rate limited, and keys in the query string are refused
 * (they end up in proxy logs, browser history and Referer headers).
 */
export const requireSecretKey = (ctx: AppContext): MiddlewareHandler => async (c, next) => {
  if (c.req.query("secret_key") || c.req.query("api_key") || c.req.query("token")) {
    throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Send the secret key in the Authorization header, never in the query string");
  }
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || !safeEqual(token, ctx.env.secretKey)) {
    await hit(ctx, `secret_key_failure:${clientIp(c)}`, SECRET_KEY_MAX_FAILURES, SECRET_KEY_WINDOW_MS);
    console.warn(`[auth] rejected secret key from ${logSafe(clientIp(c))} (${token ? "wrong value" : "missing"})`);
    throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Invalid secret key");
  }
  await next();
};
