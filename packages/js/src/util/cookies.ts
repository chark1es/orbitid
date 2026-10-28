import { COOKIES } from "@orbitid/shared";

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

/** Writes the `__session` JWT cookie read by the app's SSR/middleware (never httpOnly: the SDK owns it). */
export function setSessionCookie(jwt: string, options: CookieOptions = {}): void {
  setCookie(COOKIES.session, jwt, options);
}

/** Writes `__client_uat` (unix seconds, `0` when signed out) so middleware can skip the API for signed-out visitors. */
export function setClientUatCookie(unixSeconds: number, options: CookieOptions = {}): void {
  setCookie(COOKIES.clientUat, String(Math.max(0, Math.floor(unixSeconds))), { ...options, maxAge: 60 * 60 * 24 * 365 });
}

export function clearAuthCookies(options: CookieOptions = {}): void {
  deleteCookie(COOKIES.session, options);
  setClientUatCookie(0, options);
}
