import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { orbitIdMiddleware } from "../src/middleware";
import { HANDSHAKE_MARKER_COOKIE, HANDSHAKE_MAX_UNAVAILABLE, HANDSHAKE_RETRY_MARKER, HANDSHAKE_UNAVAILABLE_COOKIE } from "../src/handshake";
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
    const token = await signExpiredToken({}, "https://auth.test");
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
    const token = await signExpiredToken({}, "https://auth.test");
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
    const token = await signExpiredToken({}, "https://auth.test");
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
    const token = await signExpiredToken({}, "https://auth.test");
    const response = await (await middleware())(req("/dashboard", { cookie: `__session=${token}; __client_uat=0` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("allows only one handshake per navigation (loop guard marker)", async () => {
    const token = await signExpiredToken({}, "https://auth.test");
    const response = await (await middleware())(
      req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect when the request already carries a handshake parameter", async () => {
    const token = await signExpiredToken({}, "https://auth.test");
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${token}`, { cookie: `__session=${token}; __client_uat=1700000000` }),
    );
    // The return is completed (token verified), so the browser is sent to the clean URL, not looped.
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).searchParams.has("__orbit_handshake")).toBe(false);
  });

  it("only completes a handshake it started (crafted links cannot sign a browser in)", async () => {
    const token = await signTestToken({ sub: "user_victim", sid: "sess_victim" }, { issuer: API_URL });
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
    const token = await signTestToken({ sub: "user_42", sid: "sess_42" }, { issuer: API_URL });
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
    // Both cookies carry the browser's maximum lifetime (400 days), never a session cookie; the JWT inside
    // still expires in ~60 s and the next hard navigation handshakes again.
    expect(cookies.get("__session")?.attributes).toContain("Max-Age=34560000");
    expect(Number(cookies.get("__client_uat")?.value)).toBeGreaterThan(0);
    expect(cookies.get("__client_uat")?.attributes).toContain("Max-Age=34560000");
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.attributes).toContain("Max-Age=0");
  });

  it("keeps a pending-session handshake signed-in-incomplete instead of clearing it", async () => {
    const token = await signTestToken({ sts: "pending", sub: "user_pending", sid: "sess_pending" }, { issuer: API_URL });
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${token}`, {
        cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    expect(response.status).toBe(307);
    const cookies = setCookies(response);
    expect(cookies.get("__session")?.value).toBe(token);
    expect(Number(cookies.get("__client_uat")?.value)).toBeGreaterThan(0);
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
      const token = await signTestToken({}, { issuer: API_URL });
      const parts = token.split(".");
      return `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`;
    }],
    ["an expired handshake token", async () => {
      return signExpiredToken({}, "https://auth.test");
    }],
    ["garbage", async () => "not.a.jwt"],
  ])("treats %s as a retriable unavailable handshake and leaves the browser signed in", async (_name, makeToken) => {
    const token = await makeToken();
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${encodeURIComponent(token)}`, {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toContain('http-equiv="refresh"');
    // No token is written, but nothing is cleared either: the stale `__session` and the live `__client_uat`
    // stay so the next navigation can handshake again. The retry marker and its counter bound the attempts.
    const cookies = setCookies(response);
    expect(cookies.get("__session")).toBeUndefined();
    expect(cookies.get("__client_uat")).toBeUndefined();
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.value).toBe(HANDSHAKE_RETRY_MARKER);
    expect(cookies.get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value).toBe("1");
  });

  it("rejects a handshake token for an unauthorized party without clearing the browser", async () => {
    const token = await signTestToken({ azp: "https://evil.test" }, { issuer: API_URL });
    const response = await (await middleware({ authorizedParties: [APP] }))(
      req(`/dashboard?__orbit_handshake=${token}`, { cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` }),
    );
    // The token is not used, but a misconfigured `authorizedParties` is not a sign-out: cookies stay and the
    // handshake is retried as an unavailable answer, never a sign-in redirect.
    expect(response.status).toBe(503);
    expect(setCookies(response).get("__session")).toBeUndefined();
    expect(setCookies(response).get("__client_uat")).toBeUndefined();
  });

  it("tolerates clock skew on nbf/iat but not beyond the small expiry bound", async () => {
    const { privateKey } = await getTestKeys();
    const now = Math.floor(Date.now() / 1000);
    // `nbf` is 20 s in the future (verifier's clock fast) and the token is still valid: both accepted.
    const token = await new SignJWT({ sid: "sess_skew" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("user_skew")
      .setIssuedAt(now - 61)
      .setNotBefore(now + 20)
      .setExpirationTime(now + 5)
      .setIssuer(API_URL)
      .sign(privateKey);
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${encodeURIComponent(token)}`, {
        cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    const cookies = setCookies(response);
    expect(cookies.get("__session")?.value).toBe(token);
    expect(Number(cookies.get("__client_uat")?.value)).toBeGreaterThan(0);
  });

  it("does not accept a JWT more than 10 s past exp (the real revocation bound)", async () => {
    const { privateKey } = await getTestKeys();
    const now = Math.floor(Date.now() / 1000);
    // Expired 20 s ago. A 60 s early-clock tolerance must not give a revoked session another full minute.
    const token = await new SignJWT({ sid: "sess_stale" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("user_stale")
      .setIssuedAt(now - 80)
      .setExpirationTime(now - 20)
      .setIssuer(API_URL)
      .sign(privateKey);
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${encodeURIComponent(token)}`, {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    const cookies = setCookies(response);
    expect(response.status).toBe(503);
    expect(cookies.get("__session")).toBeUndefined();
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.value).toBe(HANDSHAKE_RETRY_MARKER);
    expect(cookies.get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value).toBe("1");
  });

  it("answers the API's transient marker with a retriable 503, never a sign-in redirect", async () => {
    const response = await (await middleware())(
      req("/dashboard?__orbit_handshake=transient", {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('http-equiv="refresh"');
    // Credentials are untouched (no Set-Cookie deleting __session / __client_uat); only the marker becomes retry.
    const cookies = setCookies(response);
    expect(cookies.get("__session")).toBeUndefined();
    expect(cookies.get("__client_uat")).toBeUndefined();
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.value).toBe(HANDSHAKE_RETRY_MARKER);
  });

  it("honours the Retry-After the API put on the transient return", async () => {
    const response = await (await middleware())(
      req("/dashboard?__orbit_handshake=transient&retry_after=7", {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toContain('http-equiv="refresh" content="7;');
    // The retry parameter does not survive into the page the visitor is returned to.
    expect(response.headers.get("location")).toBeNull();
  });

  it("bounds consecutive unavailable handshakes and then serves a terminal 503 that never signs the visitor out", async () => {
    const expired = await signExpiredToken({}, "https://auth.test");
    const mw = await middleware();
    const run = async (count: number) =>
      mw(req(`/dashboard?__orbit_handshake=${encodeURIComponent(expired)}`, {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1; ${HANDSHAKE_UNAVAILABLE_COOKIE}=${count}`,
      }));

    for (const prior of [0, 1, 2]) {
      const response = await run(prior);
      // A token that cannot be verified yet is an outage, not a sign-out: retriable 503, cookies untouched.
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("3");
      expect(setCookies(response).get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value).toBe(String(prior + 1));
      expect(setCookies(response).get("__session")).toBeUndefined();
    }

    // Still unverifiable after the bound: automatic retries stop, but the visitor is NOT signed out. The response is
    // a terminal 503 page with a manual "Try again" link — never a clean-URL redirect that `protect()` would turn
    // into a sign-in redirect, and never a meta-refresh loop.
    const terminal = await run(HANDSHAKE_MAX_UNAVAILABLE);
    expect(terminal.status).toBe(503);
    expect(terminal.headers.get("location")).toBeNull();
    const body = await terminal.text();
    expect(body).toContain("Try again");
    expect(body).not.toContain('http-equiv="refresh"');
    const cookies = setCookies(terminal);
    expect(cookies.get("__session")).toBeUndefined();
    expect(cookies.get("__client_uat")).toBeUndefined();
    expect(cookies.get(HANDSHAKE_MARKER_COOKIE)?.value).toBe(HANDSHAKE_RETRY_MARKER);
    expect(cookies.get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value).toBe(String(HANDSHAKE_MAX_UNAVAILABLE));
  });

  it("counts the API's transient answer toward the same retry bound", async () => {
    const mw = await middleware();
    const response = await mw(req("/dashboard?__orbit_handshake=transient", {
      cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1; ${HANDSHAKE_UNAVAILABLE_COOKIE}=2`,
    }));
    expect(response.status).toBe(503);
    expect(setCookies(response).get(HANDSHAKE_UNAVAILABLE_COOKIE)?.value).toBe("3");

    const terminal = await mw(req("/dashboard?__orbit_handshake=transient", {
      cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1; ${HANDSHAKE_UNAVAILABLE_COOKIE}=3`,
    }));
    expect(terminal.status).toBe(503);
    expect(terminal.headers.get("location")).toBeNull();
    expect(await terminal.text()).toContain("Try again");
    expect(setCookies(terminal).get("__session")).toBeUndefined();
  });

  it("clears the unavailable counter once a handshake token verifies", async () => {
    const token = await signTestToken({ sub: "user_42", sid: "sess_42" }, { issuer: API_URL });
    const response = await (await middleware())(
      req(`/dashboard?__orbit_handshake=${token}`, {
        cookie: `__client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1; ${HANDSHAKE_UNAVAILABLE_COOKIE}=2`,
      }),
    );
    expect(response.status).toBe(307);
    const cleared = setCookies(response).get(HANDSHAKE_UNAVAILABLE_COOKIE);
    expect(cleared?.value).toBe("");
    expect(cleared?.attributes).toContain("Max-Age=0");
    expect(setCookies(response).get("__session")?.value).toBe(token);
  });

  it("retries the handshake after a transient failure instead of redirecting to sign-in", async () => {
    const token = await signExpiredToken({}, "https://auth.test");
    const response = await (await middleware())(
      req("/dashboard", {
        cookie: `__session=${token}; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=${HANDSHAKE_RETRY_MARKER}`,
      }),
    );
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`${API_URL}/v1/client/handshake`);
    expect(setCookies(response).get(HANDSHAKE_MARKER_COOKIE)?.value).toBe("1");
  });

  it("answers a transient handshake on a fetch with 503 JSON and keeps cookies", async () => {
    const request = new NextRequest(`${APP}/api/data?__orbit_handshake=transient`, {
      headers: {
        cookie: `__session=stale-token; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1`,
        accept: "application/json",
        "sec-fetch-mode": "cors",
      },
    });
    const response = await (await middleware())(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { error: string };
    expect(body.error).toBe("temporarily_unavailable");
    expect(setCookies(response).get("__session")).toBeUndefined();
  });

  it("keeps the old behaviour when the handshake is disabled", async () => {
    const token = await signExpiredToken({}, "https://auth.test");
    const mw = await middleware({ handshake: { enabled: false } });
    const response = await mw(req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000` }));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
