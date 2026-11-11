// The bounded handshake retry must survive a long `Retry-After`, and exhausting it must never look like a sign-out.
// These are the reproductions for two review findings: a 60 s retry delay outliving the 30 s counter cookie (so the
// count reset on every try) and the old fallback that redirected clean and let `protect()` send the visitor to
// sign-in although the session was still valid.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { orbitIdMiddleware } from "../src/middleware";
import {
  HANDSHAKE_MARKER_COOKIE,
  HANDSHAKE_MAX_UNAVAILABLE,
  HANDSHAKE_RETRY_MARKER,
  HANDSHAKE_RETRY_PARAM,
  HANDSHAKE_UNAVAILABLE_COOKIE,
} from "../src/handshake";
import { getTestKeys, signExpiredToken } from "./helpers";

const API_URL = "https://auth.test";
const APP = "https://app.test";

function req(path: string, cookie: string, headers: Record<string, string> = {}): NextRequest {
  const next = new Headers(headers);
  next.set("cookie", cookie);
  if (!next.has("sec-fetch-mode")) next.set("sec-fetch-mode", "navigate");
  return new NextRequest(`${APP}${path}`, { headers: next });
}

async function jwtKey(): Promise<string> {
  return (await getTestKeys()).publicKeyPem;
}

async function middleware(overrides: Record<string, unknown> = {}) {
  return orbitIdMiddleware({ jwtKey: await jwtKey(), apiUrl: API_URL, ...overrides } as never);
}

interface StoredCookie {
  value: string;
  attributes: string;
}

function setCookies(response: Response): Map<string, StoredCookie> {
  const cookies = new Map<string, StoredCookie>();
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(/;\s*/);
    const index = pair!.indexOf("=");
    cookies.set(pair!.slice(0, index), { value: pair!.slice(index + 1), attributes: attributes.join("; ") });
  }
  return cookies;
}

function maxAgeSeconds(cookie: StoredCookie): number {
  return Number(/Max-Age=(\d+)/i.exec(cookie.attributes)?.[1] ?? 0);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const staleCredentials = "__session=stale-token; __client_uat=1700000000";

describe("handshake retry bound", () => {
  it("keeps the marker and counter alive longer than a 60 s Retry-After, so the bound still triggers", async () => {
    const mw = await middleware();
    let cookie = `${staleCredentials}; ${HANDSHAKE_MARKER_COOKIE}=1`;

    for (let attempt = 0; attempt < HANDSHAKE_MAX_UNAVAILABLE; attempt += 1) {
      const response = await mw(req("/dashboard?__orbit_handshake=transient&retry_after=60", cookie));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      // A 60 s meta refresh is fine only if the retry state outlives it (the old 30 s cookies did not).
      expect(await response.text()).toContain('http-equiv="refresh" content="60;');

      const cookies = setCookies(response);
      const marker = cookies.get(HANDSHAKE_MARKER_COOKIE)!;
      const counter = cookies.get(HANDSHAKE_UNAVAILABLE_COOKIE)!;
      expect(marker.value).toBe(HANDSHAKE_RETRY_MARKER);
      expect(counter.value).toBe(String(attempt + 1));
      expect(maxAgeSeconds(marker)).toBeGreaterThanOrEqual(300);
      expect(maxAgeSeconds(counter)).toBeGreaterThanOrEqual(300);
      // Credentials survive every retry.
      expect(cookies.get("__session")).toBeUndefined();
      expect(cookies.get("__client_uat")).toBeUndefined();

      cookie = `${staleCredentials}; ${HANDSHAKE_MARKER_COOKIE}=${marker.value}; ${HANDSHAKE_UNAVAILABLE_COOKIE}=${counter.value}`;
    }

    // The 4th attempt is terminal, exactly as it is for the 3 s default: no indefinite loop.
    const terminal = await mw(req("/dashboard?__orbit_handshake=transient&retry_after=60", cookie));
    expect(terminal.status).toBe(503);
    expect(terminal.headers.get("location")).toBeNull();
    expect(await terminal.text()).toContain("Try again");
  });

  it("caps a hostile Retry-After at a sane maximum", async () => {
    const mw = await middleware();
    const response = await mw(req("/dashboard?__orbit_handshake=transient&retry_after=100000", `${staleCredentials}; ${HANDSHAKE_MARKER_COOKIE}=1`));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.text()).toContain('http-equiv="refresh" content="60;');
  });

  it("serves a terminal 503 with a same-origin manual retry that resets the counter", async () => {
    const mw = await middleware();
    const boundCookies = `${staleCredentials}; ${HANDSHAKE_MARKER_COOKIE}=${HANDSHAKE_RETRY_MARKER}; ${HANDSHAKE_UNAVAILABLE_COOKIE}=${HANDSHAKE_MAX_UNAVAILABLE}`;
    // Query parameters survive into the retry link (they are part of the same-origin page the visitor asked for).
    const terminal = await mw(req("/dashboard/settings?tab=2&__orbit_handshake=transient", boundCookies));
    expect(terminal.status).toBe(503);
    expect(terminal.headers.get("location")).toBeNull();

    const html = await terminal.text();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain("You are still signed in");
    const href = /href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBeTruthy();
    const retry = new URL(decodeEntities(href!));
    expect(retry.origin).toBe(APP);
    expect(retry.pathname).toBe("/dashboard/settings");
    expect(retry.searchParams.get("tab")).toBe("2");
    expect(retry.searchParams.get("__orbit_handshake")).toBeNull();
    expect(retry.searchParams.get(HANDSHAKE_RETRY_PARAM)).toBe("1");

    // Clicking the link clears the bounded-retry state instead of being terminal straight away.
    const reset = await mw(req(`${retry.pathname}${retry.search}`, boundCookies));
    expect(reset.status).toBe(307);
    const clean = new URL(reset.headers.get("location")!);
    expect(clean.origin).toBe(APP);
    expect(clean.searchParams.get(HANDSHAKE_RETRY_PARAM)).toBeNull();
    expect(setCookies(reset).get(HANDSHAKE_UNAVAILABLE_COOKIE)?.attributes).toContain("Max-Age=0");
    expect(setCookies(reset).get(HANDSHAKE_MARKER_COOKIE)?.attributes).toContain("Max-Age=0");

    // The next navigation starts a normal handshake with a full retry budget, never a sign-in redirect.
    const freshNavigation = await mw(req(`${clean.pathname}${clean.search}`, "__client_uat=1700000000"));
    expect(freshNavigation.status).toBe(307);
    expect(new URL(freshNavigation.headers.get("location")!).pathname).toBe("/v1/client/handshake");
    expect(setCookies(freshNavigation).get(HANDSHAKE_MARKER_COOKIE)?.value).toBe("1");
  });

  it("answers a fetch with terminal 503 JSON and a retry URL instead of redirecting", async () => {
    const mw = await middleware();
    const request = new NextRequest(`${APP}/api/data?__orbit_handshake=transient`, {
      headers: {
        cookie: `${staleCredentials}; ${HANDSHAKE_MARKER_COOKIE}=${HANDSHAKE_RETRY_MARKER}; ${HANDSHAKE_UNAVAILABLE_COOKIE}=${HANDSHAKE_MAX_UNAVAILABLE}`,
        accept: "application/json",
        "sec-fetch-mode": "cors",
      },
    });
    const response = await mw(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    const body = await response.json() as { error: string; retry_url: string };
    expect(body.error).toBe("temporarily_unavailable");
    const retry = new URL(body.retry_url);
    expect(retry.origin).toBe(APP);
    expect(retry.searchParams.get(HANDSHAKE_RETRY_PARAM)).toBe("1");
    // Credentials are untouched.
    expect(setCookies(response).get("__session")).toBeUndefined();
    expect(setCookies(response).get("__client_uat")).toBeUndefined();
  });

  it("never turns an exhausted bound into a sign-in redirect for a full navigation", async () => {
    const expired = await signExpiredToken({}, API_URL);
    const mw = await middleware();
    // A navigation that arrives with credentials but an expired session and an exhausted counter goes through the
    // API handshake once more (a manual navigation, not a loop), never straight to `protect()`'s sign-in redirect.
    const response = await mw(req("/dashboard", `__session=${expired}; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=${HANDSHAKE_RETRY_MARKER}; ${HANDSHAKE_UNAVAILABLE_COOKIE}=${HANDSHAKE_MAX_UNAVAILABLE}`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${API_URL}/v1/client/handshake`);
    expect(location.searchParams.get("redirect_url")).toBe(`${APP}/dashboard`);
  });
});
