// Ties an SSO/OAuth flow to the browser that started it, so a callback cannot be completed from another browser.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../../context";
import { randomToken, safeEqual, sha256 } from "../../lib/crypto";

export const BROWSER_COOKIE = "__orbit_oauth";
const COOKIE_PATH = "/v1";
const TTL_SECONDS = 10 * 60;

/** Sets the binding cookie on the response and returns the hash to store with the flow. */
export function bindBrowser(ctx: AppContext, c: Context): string {
  const nonce = randomToken(24);
  const secure = ctx.env.baseUrl.startsWith("https://");
  // Cross-site callbacks (SAML ACS, Apple form_post) are POSTs, which Lax cookies do not accompany.
  setCookie(c, BROWSER_COOKIE, nonce, { httpOnly: true, secure, sameSite: secure ? "None" : "Lax", path: COOKIE_PATH, maxAge: TTL_SECONDS });
  return sha256(nonce);
}

/** True when this request carries the cookie that was set for the stored hash. The cookie is single-use. */
export function browserMatches(c: Context, expectedHash: string | undefined): boolean {
  const presented = getCookie(c, BROWSER_COOKIE);
  deleteCookie(c, BROWSER_COOKIE, { path: COOKIE_PATH });
  return !!presented && !!expectedHash && safeEqual(sha256(presented), expectedHash);
}
