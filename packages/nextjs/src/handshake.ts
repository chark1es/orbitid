import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_MAX_AGE_SECONDS, COOKIES } from "@orbitid/shared";
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
/**
 * Marker values the Frontend API appends to `__orbit_handshake`. These mirror
 * `HANDSHAKE_SIGNED_OUT` / `HANDSHAKE_TRANSIENT` in the server's handshake module; they are branch
 * conditions here, not tokens that were meant to fail JWT parsing.
 */
export const HANDSHAKE_API_SIGNED_OUT = "signed_out";
export const HANDSHAKE_API_TRANSIENT = "transient";
/** Marker value after the API reported a transient failure. The next navigation retries the handshake instead of
 * treating the visitor as signed out; the 503 page waits a few seconds first so a broken API is not hammered. */
export const HANDSHAKE_RETRY_MARKER = "retry";
/**
 * Counts consecutive "the API answered but the token cannot be verified (yet)" results — a cooldown/unknown `kid`,
 * a JWKS fetch failure, clock skew. They use the same retriable 503 as `transient`, but the count is bounded so a
 * permanently broken key cannot loop forever; after {@link HANDSHAKE_MAX_UNAVAILABLE} the middleware serves a
 * terminal 503 with a manual "Try again" link. It never classifies the visitor as signed out.
 */
export const HANDSHAKE_UNAVAILABLE_COOKIE = "__orbit_handshake_unavailable";
export const HANDSHAKE_MAX_UNAVAILABLE = 3;
/**
 * Same-origin query parameter on the manual "Try again" link. It clears the retry counter and the marker, so a
 * visitor who asks for another attempt starts a fresh bounded set of retries instead of being terminal at once.
 */
export const HANDSHAKE_RETRY_PARAM = "__orbit_handshake_retry";
const MARKER_MAX_AGE_SECONDS = 30;
/**
 * The retry marker and its counter must outlive the retry delay, or they expire before the scheduled retry and the
 * count silently resets — an indefinite loop once `Retry-After` is longer than the old 30 s lifetime.
 */
const RETRY_COOKIE_MIN_AGE_SECONDS = 300;
/** A sane maximum for `Retry-After`: longer delays belong behind a manual retry, not an automatic one. */
export const HANDSHAKE_MAX_RETRY_AFTER_SECONDS = 60;
/** How long the "temporarily unavailable" page waits before retrying the handshake. */
export const HANDSHAKE_RETRY_DELAY_SECONDS = 3;
/** Optional query parameter carrying the API's `Retry-After` on the transient redirect. */
const RETRY_AFTER_PARAM = "retry_after";
const HANDSHAKE_PARAM = COOKIES.handshake;

/** Lifetime for the retry marker/counter: comfortably longer than the delay plus a handshake round trip. */
function retryCookieMaxAge(retryAfterSeconds: number): number {
  return Math.max(RETRY_COOKIE_MIN_AGE_SECONDS, Math.ceil(retryAfterSeconds) * 3);
}

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
  // `nextUrl.protocol` follows the request URL (which Next builds from the forwarded headers), but a proxy
  // that terminates TLS and talks http inward must still produce a `Secure` cookie. Accept an explicit
  // `X-Forwarded-Proto: https` as well, and keep plain-http localhost usable.
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  const secure = options.secure ?? (req.nextUrl.protocol === "https:" || forwardedProto === "https");
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** A finite, positive `Retry-After` in seconds; anything else falls back to the small default. */
function parseRetryAfterSeconds(value: string | null): number {
  if (!value) return HANDSHAKE_RETRY_DELAY_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return HANDSHAKE_RETRY_DELAY_SECONDS;
  return Math.min(HANDSHAKE_MAX_RETRY_AFTER_SECONDS, Math.ceil(seconds));
}

/** The same-origin URL a manual retry navigates to; it clears the counter before starting a fresh attempt. */
function manualRetryUrl(retryUrl: string): string {
  const url = new URL(retryUrl);
  url.searchParams.delete(HANDSHAKE_PARAM);
  url.searchParams.delete(RETRY_AFTER_PARAM);
  url.searchParams.set(HANDSHAKE_RETRY_PARAM, "1");
  return url.toString();
}

/**
 * The API could not mint a token for a live visitor (database/signing-key failure). This is an outage, not a
 * sign-out: answer 503, keep every credential cookie, and let the browser retry the handshake. A document gets a
 * tiny auto-refreshing page; a fetch gets JSON. Neither path may redirect to sign-in.
 */
export function handshakeUnavailableResponse(
  req: NextRequest,
  retryUrl: string,
  retryAfterSeconds: number = HANDSHAKE_RETRY_DELAY_SECONDS,
): NextResponse {
  const retryAfter = String(retryAfterSeconds);
  if (!isNavigationRequest(req)) {
    const response = new NextResponse(
      JSON.stringify({
        error: "temporarily_unavailable",
        message: "Authentication is temporarily unavailable. Retry shortly.",
        retry_url: manualRetryUrl(retryUrl),
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8", "retry-after": retryAfter, "cache-control": "no-store" } },
    );
    return response;
  }
  const response = new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="${retryAfterSeconds};url=${escapeHtml(retryUrl)}"><title>Temporarily unavailable</title></head>` +
      `<body><p>Sign-in is temporarily unavailable. Retrying…</p><p><a href="${escapeHtml(manualRetryUrl(retryUrl))}">Try again now</a></p></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": retryAfter,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
  return response;
}

/**
 * The bounded automatic retries are exhausted. This is **terminal for this attempt only**: a document gets a 503
 * page with a manual "Try again" link (never a meta-refresh loop, never a sign-in redirect), a fetch gets 503 JSON
 * with the same link. Credential cookies are untouched, so the visitor stays signed in; the link clears the counter
 * for a fresh set of retries.
 */
export function handshakeTerminalResponse(
  req: NextRequest,
  retryUrl: string,
  retryAfterSeconds: number = HANDSHAKE_RETRY_DELAY_SECONDS,
): NextResponse {
  const retryAfter = String(retryAfterSeconds);
  const link = manualRetryUrl(retryUrl);
  if (!isNavigationRequest(req)) {
    return new NextResponse(
      JSON.stringify({
        error: "temporarily_unavailable",
        message: "Authentication is still temporarily unavailable. Try again with the retry link.",
        retry_url: link,
      }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8", "retry-after": retryAfter, "cache-control": "no-store" } },
    );
  }
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in temporarily unavailable</title></head>` +
      `<body><h1>Sign-in is temporarily unavailable</h1>` +
      `<p>You are still signed in. Automatic retries have paused so a broken authentication service is not hammered.</p>` +
      `<p><a href="${escapeHtml(link)}">Try again</a></p></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "retry-after": retryAfter,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/**
 * Picks the retriable or the terminal 503 for a request that is not a handshake return (for example a fetch while
 * the API is known to be down). Credentials are never touched by either.
 */
export function handshakeUnavailableFor(
  req: NextRequest,
  retryUrl: string,
  retryAfterSeconds: number = HANDSHAKE_RETRY_DELAY_SECONDS,
): NextResponse {
  return unavailableCount(req) >= HANDSHAKE_MAX_UNAVAILABLE
    ? handshakeTerminalResponse(req, retryUrl, retryAfterSeconds)
    : handshakeUnavailableResponse(req, retryUrl, retryAfterSeconds);
}

/**
 * Handles the manual retry link: clears the bounded-retry counter and marker, then sends the browser back to the
 * clean URL. The next navigation starts a fresh handshake with a full retry budget. Same-origin by construction.
 */
export function resetHandshakeRetries(
  req: NextRequest,
  options: HandshakeOptions,
): NextResponse | null {
  if (req.nextUrl.searchParams.get(HANDSHAKE_RETRY_PARAM) === null) return null;
  const target = req.nextUrl.clone();
  target.searchParams.delete(HANDSHAKE_RETRY_PARAM);
  const response = NextResponse.redirect(target);
  const attributes = cookieAttributes(req, options);
  response.cookies.set(HANDSHAKE_MARKER_COOKIE, "", { ...attributes, httpOnly: true, maxAge: 0 });
  response.cookies.set(HANDSHAKE_UNAVAILABLE_COOKIE, "", { ...attributes, httpOnly: true, maxAge: 0 });
  return noStore(response);
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

/**
 * Authoritative sign-out: the Frontend API looked for a session and found none. Only this outcome clears the
 * browser's cookies. `__session` is deleted and `__client_uat` becomes `0`, which stops the handshake path; the
 * cookie itself keeps a long lifetime so a later sign-in in this browser starts from a clean, persistent cookie.
 */
function signOut(response: NextResponse, attributes: CookieAttributes): NextResponse {
  response.cookies.set(COOKIES.session, "", { ...attributes, maxAge: 0 });
  response.cookies.set(COOKIES.clientUat, "0", { ...attributes, maxAge: COOKIE_MAX_AGE_SECONDS });
  return response;
}

export interface HandshakeOutcome {
  response: NextResponse;
  /**
   * `signed-in` when a valid token was written, `signed-out` only when the API authoritatively found no session,
   * and `unavailable` when the API reported a transient failure (503 + retry; credentials untouched).
   */
  status: "signed-in" | "signed-out" | "unavailable";
}

/**
 * Completes a handshake return: verifies `__orbit_handshake`, writes (or clears) the SDK cookies and
 * redirects to the same URL without the parameter. Returns `null` when the request is not a return.
 *
 * Only a return the middleware itself initiated is acted on: the `__orbit_handshake_pending` marker
 * must be present. Without it the parameter is stripped and cookies are left alone, so a crafted link
 * (`?__orbit_handshake=<someone else's token>`) cannot sign a browser in or out.
 *
 * A token that does not verify is treated as *unavailable*, exactly like an API `transient` failure: the parameter is
 * stripped, every credential cookie is left alone, and the answer is a 503 with `Retry-After` and a meta-refresh page
 * (JSON for a fetch) that retries the handshake. Re-arming only the plain marker used to make the next clean
 * navigation reach `protect()` as signed-out and redirect to sign-in. A short-lived counter bounds the retries; after
 * {@link HANDSHAKE_MAX_UNAVAILABLE} consecutive unavailable answers the visitor gets a terminal 503 page with a manual
 * "Try again" link (never a sign-out, never an automatic loop). Only the API's own `signed_out` answer is authoritative
 * and clears the cookies.
 */
export async function completeHandshake(
  req: NextRequest,
  env: ResolvedServerEnv,
  options: HandshakeOptions,
): Promise<HandshakeOutcome | null> {
  const value = req.nextUrl.searchParams.get(HANDSHAKE_PARAM);
  if (value === null) return null;
  const retryAfterSeconds = parseRetryAfterSeconds(req.nextUrl.searchParams.get(RETRY_AFTER_PARAM));

  const cleanUrl = req.nextUrl.clone();
  cleanUrl.searchParams.delete(HANDSHAKE_PARAM);
  cleanUrl.searchParams.delete(RETRY_AFTER_PARAM);
  const response = NextResponse.redirect(cleanUrl);
  const attributes = cookieAttributes(req, options);
  const clearUnavailable = (target: NextResponse): NextResponse => {
    target.cookies.set(HANDSHAKE_UNAVAILABLE_COOKIE, "", { ...attributes, httpOnly: true, maxAge: 0 });
    return target;
  };
  const signedOut = (): HandshakeOutcome => ({ response: noStore(clearUnavailable(signOut(response, attributes))), status: "signed-out" });
  /** Strip the parameter and leave the visitor's cookies alone; optionally retry the handshake later. */
  const ignored = (retry: boolean): HandshakeOutcome => {
    if (retry) response.cookies.set(HANDSHAKE_MARKER_COOKIE, "1", { ...attributes, httpOnly: true, maxAge: MARKER_MAX_AGE_SECONDS });
    return { response: noStore(response), status: "signed-out" };
  };
  /**
   * The API is broken, not the session: keep cookies, answer 503 and re-arm the marker for a delayed retry. A token
   * that merely fails verification (unknown/cooldown key, JWKS outage, skew) is the same situation: it is not proof
   * of a sign-out, and the old one-shot marker turned the next clean navigation into a sign-in redirect. The
   * counter cookie bounds the automatic retries; after {@link HANDSHAKE_MAX_UNAVAILABLE} the answer is a terminal
   * 503 with a manual "Try again" link — still never a sign-out, and never an automatic loop.
   */
  const unavailable = (seconds: number = retryAfterSeconds): HandshakeOutcome => {
    const consecutive = unavailableCount(req);
    const maxAge = retryCookieMaxAge(seconds);
    if (consecutive >= HANDSHAKE_MAX_UNAVAILABLE) {
      const terminal = handshakeTerminalResponse(req, cleanUrl.toString(), seconds);
      terminal.cookies.set(HANDSHAKE_MARKER_COOKIE, HANDSHAKE_RETRY_MARKER, { ...attributes, httpOnly: true, maxAge });
      terminal.cookies.set(HANDSHAKE_UNAVAILABLE_COOKIE, String(HANDSHAKE_MAX_UNAVAILABLE), { ...attributes, httpOnly: true, maxAge });
      return { response: noStore(terminal), status: "unavailable" };
    }
    const unavailableResponse = handshakeUnavailableResponse(req, cleanUrl.toString(), seconds);
    unavailableResponse.cookies.set(HANDSHAKE_MARKER_COOKIE, HANDSHAKE_RETRY_MARKER, {
      ...attributes,
      httpOnly: true,
      maxAge,
    });
    unavailableResponse.cookies.set(HANDSHAKE_UNAVAILABLE_COOKIE, String(consecutive + 1), {
      ...attributes,
      httpOnly: true,
      maxAge,
    });
    return { response: noStore(unavailableResponse), status: "unavailable" };
  };

  if (!hasHandshakeMarker(req)) return ignored(false);

  // One attempt per navigation: the marker goes away with the return, whatever its result.
  response.cookies.set(HANDSHAKE_MARKER_COOKIE, "", { ...attributes, httpOnly: true, maxAge: 0 });

  // The server looked and found no usable session: this browser really is signed out.
  if (value === HANDSHAKE_API_SIGNED_OUT) return signedOut();
  // The API rate-limited or otherwise answered without a token. Keep the visitor's cookies and retry later.
  if (!value.trim()) return ignored(true);
  // Database/signing-key failure. Only this marker is an outage; a token that merely fails verification stays a
  // retryable but non-authoritative answer below.
  if (value === HANDSHAKE_API_TRANSIENT) return unavailable();

  const verified = await verifySessionToken(value, {
    jwtKey: env.jwtKey,
    jwksUrl: env.jwksUrl,
    apiUrl: env.apiUrl,
    issuer: env.issuer,
    authorizedParties: env.authorizedParties,
    clockSkewInMs: env.clockSkewInMs,
    expClockSkewInMs: env.expClockSkewInMs,
  });
  // A token that does not verify is not proof of a sign-out: it can be seconds stale, signed by a key this
  // process has not fetched yet, or simply malformed. Keep the `__client`/`__client_uat` cookies and answer the same
  // retriable 503 as `transient`, so the next clean navigation retries instead of reaching `protect()` as
  // signed-out. The counter cookie bounds the retries (see `unavailable`).
  if (!verified.valid) return unavailable();

  // Same cookie shapes the browser SDK writes: `__session` carries the JWT with the browser's maximum cookie
  // lifetime (the JWT itself keeps its ~60 s `exp`), `__client_uat` lives as long.
  response.cookies.set(COOKIES.session, verified.token, { ...attributes, maxAge: COOKIE_MAX_AGE_SECONDS });
  response.cookies.set(COOKIES.clientUat, String(Math.floor(Date.now() / 1000)), {
    ...attributes,
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  clearUnavailable(response);
  return { response: noStore(response), status: "signed-in" };
}

/** Consecutive unavailable results already served for this browser, capped at the retry bound. */
function unavailableCount(req: NextRequest): number {
  const raw = req.cookies.get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value ?? "";
  const count = Number(raw);
  return Number.isInteger(count) && count > 0 ? Math.min(count, HANDSHAKE_MAX_UNAVAILABLE) : 0;
}

/** Whether a handshake attempt is still marked as in flight for this browser. */
export function hasHandshakeMarker(req: NextRequest): boolean {
  return (req.cookies.get(HANDSHAKE_MARKER_COOKIE)?.value ?? "") !== "";
}

/** Whether the marker asks for another handshake attempt after a transient API failure. */
export function hasHandshakeRetryMarker(req: NextRequest): boolean {
  return (req.cookies.get(HANDSHAKE_MARKER_COOKIE)?.value ?? "") === HANDSHAKE_RETRY_MARKER;
}
