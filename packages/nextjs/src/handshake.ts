import { NextResponse, type NextRequest } from "next/server";
import { COOKIES } from "@orbitid/shared";
import type { ResolvedServerEnv } from "./env";
import { verifySessionToken } from "./token";

/**
 * Server-side handshake for hard navigations (see docs/HANDSHAKE.md).
 *
 * The session JWT lives 60 s and the browser SDK refreshes it while a tab is open. A full page load
 * after an idle period therefore arrives with `__client_uat` > 0 but a dead `__session`. Instead of
 * bouncing the visitor to sign-in, the middleware sends the browser through
 * `GET /v1/client/handshake` on the Frontend API, which mints a fresh token and redirects back with
 * `__orbit_handshake=<jwt>`; the middleware verifies it and writes the cookies the browser SDK owns.
 */

/** Short-lived marker so a failing handshake cannot bounce the browser back and forth. */
export const HANDSHAKE_MARKER_COOKIE = "__orbit_handshake_pending";
const MARKER_MAX_AGE_SECONDS = 30;
const CLIENT_UAT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const HANDSHAKE_PARAM = COOKIES.handshake;

export interface HandshakeOptions {
  /** Set to `false` to keep the old behaviour: forward `handshake` and let the browser SDK refresh. */
  enabled?: boolean;
  /** Cookie domain when the app also sets `__session` on a parent domain. Defaults to host-only. */
  cookieDomain?: string;
  /** Force the `Secure` attribute. Defaults to `true` on https requests. */
  secure?: boolean;
}

interface CookieAttributes {
  path: string;
  sameSite: "lax";
  secure: boolean;
  domain?: string;
}

function cookieAttributes(req: NextRequest, options: HandshakeOptions): CookieAttributes {
  const secure = options.secure ?? req.nextUrl.protocol === "https:";
  return { path: "/", sameSite: "lax", secure, ...(options.cookieDomain ? { domain: options.cookieDomain } : {}) };
}

/**
 * Only top-level navigations may be redirected to the handshake: API calls, fetches, RSC payloads and
 * prefetches must keep their response.
 */
export function isNavigationRequest(req: NextRequest): boolean {
  if (req.method !== "GET") return false;
  if (req.headers.get("rsc") === "1" || req.headers.get("next-router-prefetch") === "1") return false;
  const mode = req.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/html");
}

/** Absolute handshake URL on the Frontend API origin, returning to the current absolute URL. */
export function buildHandshakeUrl(env: ResolvedServerEnv, req: NextRequest): string {
  const base = `${env.apiUrl.replace(/\/+$/, "")}/v1/client/handshake`;
  return `${base}?redirect_url=${encodeURIComponent(req.url)}`;
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Sends the browser to the Frontend API handshake and remembers that one attempt is in flight. */
export function redirectToHandshake(
  req: NextRequest,
  env: ResolvedServerEnv,
  options: HandshakeOptions,
): NextResponse {
  const response = NextResponse.redirect(buildHandshakeUrl(env, req));
  response.cookies.set(HANDSHAKE_MARKER_COOKIE, "1", {
    ...cookieAttributes(req, options),
    httpOnly: true,
    maxAge: MARKER_MAX_AGE_SECONDS,
  });
  return noStore(response);
}

function signOut(response: NextResponse, attributes: CookieAttributes): NextResponse {
  response.cookies.set(COOKIES.session, "", { ...attributes, maxAge: 0 });
  response.cookies.set(COOKIES.clientUat, "0", { ...attributes, maxAge: CLIENT_UAT_MAX_AGE_SECONDS });
  return response;
}

export interface HandshakeOutcome {
  response: NextResponse;
  /** `signed-in` when a valid token was written, `signed-out` when the handshake reported or produced none. */
  status: "signed-in" | "signed-out";
}

/**
 * Completes a handshake return: verifies `__orbit_handshake`, writes (or clears) the SDK cookies and
 * redirects to the same URL without the parameter. Returns `null` when the request is not a return.
 *
 * Only a return the middleware itself initiated is acted on: the `__orbit_handshake_pending` marker
 * must be present. Without it the parameter is stripped and cookies are left alone, so a crafted link
 * (`?__orbit_handshake=<someone else's token>`) cannot sign a browser in or out.
 *
 * Any token that does not verify is ignored and the visitor continues signed out, so a tampered or
 * already expired handshake can never sign anybody in. Clearing `__client_uat` also ends the handshake
 * path for this browser, which is the loop guard of last resort.
 */
export async function completeHandshake(
  req: NextRequest,
  env: ResolvedServerEnv,
  options: HandshakeOptions,
): Promise<HandshakeOutcome | null> {
  const value = req.nextUrl.searchParams.get(HANDSHAKE_PARAM);
  if (value === null) return null;

  const cleanUrl = req.nextUrl.clone();
  cleanUrl.searchParams.delete(HANDSHAKE_PARAM);
  const response = NextResponse.redirect(cleanUrl);
  const attributes = cookieAttributes(req, options);
  const signedOut = (): HandshakeOutcome => ({ response: noStore(signOut(response, attributes)), status: "signed-out" });
  /** Strip the parameter and clear the marker, but leave the visitor's cookies alone. */
  const ignored = (): HandshakeOutcome => ({ response: noStore(response), status: "signed-out" });

  if (!hasHandshakeMarker(req)) return ignored();

  // One attempt per navigation: the marker goes away with the return, whatever its result.
  response.cookies.set(HANDSHAKE_MARKER_COOKIE, "", { ...attributes, httpOnly: true, maxAge: 0 });

  // The server looked and found no usable session: this browser really is signed out.
  if (value === "signed_out") return signedOut();

  const verified = await verifySessionToken(value, {
    jwtKey: env.jwtKey,
    jwksUrl: env.jwksUrl,
    apiUrl: env.apiUrl,
    issuer: env.issuer,
    authorizedParties: env.authorizedParties,
    clockSkewInMs: env.clockSkewInMs,
  });
  // A tampered or stale token never signs anybody in. Clearing the cookies (including `__client_uat`)
  // also ends the handshake path for this browser, so a bad token can never cause a redirect loop.
  if (!verified.valid) return signedOut();

  // Same cookie shapes the browser SDK writes: `__session` is a session cookie, `__client_uat` lives a year.
  response.cookies.set(COOKIES.session, verified.token, attributes);
  response.cookies.set(COOKIES.clientUat, String(Math.floor(Date.now() / 1000)), {
    ...attributes,
    maxAge: CLIENT_UAT_MAX_AGE_SECONDS,
  });
  return { response: noStore(response), status: "signed-in" };
}

/** Whether a handshake attempt is still marked as in flight for this browser. */
export function hasHandshakeMarker(req: NextRequest): boolean {
  return (req.cookies.get(HANDSHAKE_MARKER_COOKIE)?.value ?? "") !== "";
}
