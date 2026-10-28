import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { orbitIdMiddleware } from "../src/middleware";
import { HANDSHAKE_MARKER_COOKIE } from "../src/handshake";
import { getTestKeys, signExpiredToken, signTestToken } from "./helpers";

const API_URL = "https://auth.test";
const APP = "https://app.test";

interface ReqOptions {
  cookie?: string;
  headers?: Record<string, string>;
  method?: string;
}

function req(path: string, options: ReqOptions = {}): NextRequest {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  headers.set("sec-fetch-mode", "navigate");
  return new NextRequest(`${APP}${path}`, { headers, method: options.method ?? "GET" });
}

async function jwtKey(): Promise<string> {
  return (await getTestKeys()).publicKeyPem;
}

/** Set-Cookie headers as `{ name: value }`, plus the parsed attributes. */
function setCookies(response: Response): Map<string, { value: string; attributes: string }> {
  const cookies = new Map<string, { value: string; attributes: string }>();
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(/;\s*/);
    const index = pair!.indexOf("=");
    cookies.set(pair!.slice(0, index), { value: pair!.slice(index + 1), attributes: attributes.join("; ") });
  }
  return cookies;
}

async function middleware(overrides: Record<string, unknown> = {}) {
  return orbitIdMiddleware({ jwtKey: await jwtKey(), apiUrl: API_URL, ...overrides } as never);
}

describe("middleware handshake", () => {
  it("redirects a hard navigation with an expired token and a live __client_uat to the API handshake", async () => {
    const token = await signExpiredToken();
    const response = await (await middleware())(req("/dashboard/settings", { cookie: `__session=${token}; __client_uat=1700000000` }));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${API_URL}/v1/client/handshake`);
    expect(location.searchParams.get("redirect_url")).toBe(`${APP}/dashboard/settings`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const marker = setCookies(response).get(HANDSHAKE_MARKER_COOKIE);
    expect(marker?.value).toBe("1");
    expect(marker?.attributes).toContain("HttpOnly");
    expect(marker?.attributes).toMatch(/Max-Age=(30|[1-9]\d?)/);
  });

  it("redirects when __session is missing but __client_uat is live", async () => {
    const response = await (await middleware())(req("/dashboard", { cookie: "__client_uat=1700000000" }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/v1/client/handshake");
  });

  it("does not redirect non-navigation requests (API, fetch, RSC, non-GET)", async () => {
    const token = await signExpiredToken();
    const cookie = `__session=${token}; __client_uat=1700000000`;
    const mw = await middleware();

    const fetchRequest = new NextRequest(`${APP}/api/data`, {
      headers: { cookie, accept: "application/json", "sec-fetch-mode": "cors" },
    });
    expect((await mw(fetchRequest)).status).toBe(200);

    const acceptJson = new NextRequest(`${APP}/api/data`, { headers: { cookie, accept: "application/json" } });
    expect((await mw(acceptJson)).status).toBe(200);

    const prefetch = new NextRequest(`${APP}/dashboard`, {
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate", "next-router-prefetch": "1" },
    });
    expect((await mw(prefetch)).status).toBe(200);

    const rsc = new NextRequest(`${APP}/dashboard`, {
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate", rsc: "1" },
    });
    expect((await mw(rsc)).status).toBe(200);

    const post = new NextRequest(`${APP}/dashboard`, {
      method: "POST",
      headers: { cookie, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect((await mw(post)).status).toBe(200);
  });

  it("does not redirect a navigation that authenticates with a Bearer token", async () => {
    const token = await signExpiredToken();
    const response = await (await middleware())(
      new NextRequest(`${APP}/dashboard`, {
        headers: {
          authorization: `Bearer ${token}`,
          cookie: "__client_uat=1700000000",
          "sec-fetch-mode": "navigate",
          accept: "text/html",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect when __client_uat is 0", async () => {
    const token = await signExpiredToken();
    const response = await (await middleware())(req("/dashboard", { cookie: `__session=${token}; __client_uat=0` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("allows only one handshake per navigation (loop guard marker)", async () => {
    const token = await signExpiredToken();
    const response = await (await middleware())(
      req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect when the request already carries a handshake parameter", async () => {
    const token = await signExpiredToken();
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${token}`, { cookie: `__session=${token}; __client_uat=1700000000` }),
    );
    // The return is completed (token verified), so the browser is sent to the clean URL, not looped.
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).searchParams.has("__orbit_handshake")).toBe(false);
  });

  it("only completes a handshake it started (crafted links cannot sign a browser in)", async () => {
    const token = await signTestToken({ sub: "user_victim", sid: "sess_victim" });
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${token}`, { cookie: `__client_uat=1700000000` }),
    );
    // Stripped from the URL, but no cookie is written without the marker cookie.
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).searchParams.has("__orbit_handshake")).toBe(false);
    const cookies = setCookies(response);
    expect(cookies.get("__session")).toBeUndefined();
    expect(cookies.get("__client_uat")).toBeUndefined();
  });

  it("sets __session and __client_uat from a valid handshake token and strips the parameter", async () => {
    const token = await signTestToken({ sub: "user_42", sid: "sess_42" });
    const response = await (await middleware())(
      req(`/dashboard/settings?__orbit_handshake=${token}&tab=2`, {
        cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${APP}/dashboard/settings`);
    expect(location.searchParams.get("tab")).toBe("2");
    expect(location.searchParams.has("__orbit_handshake")).toBe(false);

    const cookies = setCookies(response);
    expect(cookies.get("__session")?.value).toBe(token);
    expect(cookies.get("__session")?.attributes).toContain("Path=/");
    expect(cookies.get("__session")?.attributes.toLowerCase()).toContain("samesite=lax");
    expect(cookies.get("__session")?.attributes).toContain("Secure");
    // Session cookie for the token, one-year `__client_uat`, marker cleared.
    expect(cookies.get("__session")?.attributes).not.toContain("Max-Age");
    expect(Number(cookies.get("__client_uat")?.value)).toBeGreaterThan(0);
    expect(cookies.get("__client_uat")?.attributes).toContain("Max-Age=31536000");
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.attributes).toContain("Max-Age=0");
  });

  it("signs out on __orbit_handshake=signed_out", async () => {
    const response = await (await middleware())(
      req("/dashboard?__orbit_handshake=signed_out", { cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` }),
    );
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).searchParams.has("__orbit_handshake")).toBe(false);
    const cookies = setCookies(response);
    expect(cookies.get("__session")?.attributes).toContain("Max-Age=0");
    expect(cookies.get("__client_uat")?.value).toBe("0");
  });

  it.each([
    ["a token signed by another key", async () => {
      const { generateKeyPair } = await import("jose");
      const other = await generateKeyPair("RS256");
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ sid: "sess_evil" })
        .setProtectedHeader({ alg: "RS256" })
        .setSubject("user_evil")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(other.privateKey);
    }],
    ["a tampered token", async () => {
      const token = await signTestToken();
      const parts = token.split(".");
      return `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`;
    }],
    ["an expired handshake token", async () => {
      return signExpiredToken();
    }],
    ["garbage", async () => "not.a.jwt"],
  ])("ignores %s and continues signed out", async (_name, makeToken) => {
    const token = await makeToken();
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${encodeURIComponent(token)}`, {
        cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.has("__orbit_handshake")).toBe(false);
    // Falls back to signed out: no token is written, the cookies are cleared and the marker consumed.
    const cookies = setCookies(response);
    expect(cookies.get("__session")?.attributes).toContain("Max-Age=0");
    expect(cookies.get("__client_uat")?.value).toBe("0");
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.attributes).toContain("Max-Age=0");
  });

  it("rejects a handshake token for an unauthorized party", async () => {
    const token = await signTestToken({ azp: "https://evil.test" });
    const response = await (await middleware({ authorizedParties: [APP] }))(
      req(`/dashboard?__orbit_handshake=${token}`, { cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` }),
    );
    expect(setCookies(response).get("__session")?.attributes).toContain("Max-Age=0");
  });

  it("keeps the old behaviour when the handshake is disabled", async () => {
    const token = await signExpiredToken();
    const mw = await middleware({ handshake: { enabled: false } });
    const response = await mw(req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
