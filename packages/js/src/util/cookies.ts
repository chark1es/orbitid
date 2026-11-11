import { COOKIE_MAX_AGE_SECONDS, COOKIES } from "@orbitid/shared";

export type SameSite = "Lax" | "Strict" | "None";

export interface CookieOptions {
  /** Only set `Domain` when the app needs the cookie on subdomains. */
  domain?: string;
  path?: string;
  /** Defaults to true when the page is served over https. */
  secure?: boolean;
  sameSite?: SameSite;
  maxAge?: number;
}

function isHttps(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

function cookieSuffix(options: CookieOptions): string {
  const parts = [`Path=${options.path ?? "/"}`, `SameSite=${options.sameSite ?? "Lax"}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.secure ?? isHttps()) parts.push("Secure");
  if (typeof options.maxAge === "number") parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  return parts.join("; ");
}

const hasDocument = () => typeof document !== "undefined";

export function getCookie(name: string): string | null {
  if (!hasDocument()) return null;
  const match = document.cookie.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

export function setCookie(name: string, value: string, options: CookieOptions = {}): void {
  if (!hasDocument()) return;
  document.cookie = `${name}=${encodeURIComponent(value)}; ${cookieSuffix(options)}`;
}

export function deleteCookie(name: string, options: CookieOptions = {}): void {
  if (!hasDocument()) return;
  document.cookie = `${name}=; ${cookieSuffix({ ...options, maxAge: 0 })}`;
}

/**
 * Writes the `__session` JWT cookie read by the app's SSR/middleware (never httpOnly: the SDK owns it).
 * It carries the browser's maximum lifetime rather than being a session cookie: closing the browser must not
 * throw away the only proof the middleware has. The JWT itself still expires in ~60 s; the middleware
 * handshakes with the `__client` cookie for a fresh one, and the SDK rewrites this cookie on every refresh.
 */
export function setSessionCookie(jwt: string, options: CookieOptions = {}): void {
  setCookie(COOKIES.session, jwt, { maxAge: COOKIE_MAX_AGE_SECONDS, ...options });
}

/** Writes `__client_uat` (unix seconds, `0` when signed out) so middleware can skip the API for signed-out visitors. */
export function setClientUatCookie(unixSeconds: number, options: CookieOptions = {}): void {
  setCookie(COOKIES.clientUat, String(Math.max(0, Math.floor(unixSeconds))), { ...options, maxAge: COOKIE_MAX_AGE_SECONDS });
}

export function clearAuthCookies(options: CookieOptions = {}): void {
  deleteCookie(COOKIES.session, options);
  setClientUatCookie(0, options);
}
