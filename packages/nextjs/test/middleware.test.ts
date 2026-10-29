import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT, generateKeyPair } from "jose";
import { orbitIdMiddleware } from "../src/middleware";
import { createRouteMatcher } from "../src/route-matcher";
import { getTestKeys, signExpiredToken, signTestToken } from "./helpers";

function req(path: string, init: { token?: string; cookie?: string } = {}): NextRequest {
  const headers = new Headers();
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(`https://app.test${path}`, { headers });
}

async function jwtKey(): Promise<string> {
  return (await getTestKeys()).publicKeyPem;
}

function forwardedAuth(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("orbitIdMiddleware", () => {
  it("ignores internal auth headers sent by the client", async () => {
    const attacker = await generateKeyPair("RS256");
    const forged = await new SignJWT({ sub: "user_victim", sid: "sess_victim" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(attacker.privateKey);
    const headers = new Headers({ "x-orbitid-auth-status": "signed-in", "x-orbitid-auth-token": forged });
    // No jwtKey: tokens are verified against JWKS, which is unreachable here, so nothing may be trusted.
    const middleware = orbitIdMiddleware({ apiUrl: "http://127.0.0.1:9" });
    const response = await middleware(new NextRequest("https://app.test/dashboard", { headers }));

    expect(forwardedAuth(response, "x-orbitid-auth-status")).not.toBe("signed-in");
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBeNull();
  });

  it("forwards signed-in auth state for a bearer token", async () => {
    const token = await signTestToken({ sub: "user_1", sid: "sess_1" });
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey(), signInUrl: "/sign-in" });
    const response = await middleware(req("/dashboard", { token }));

    expect(response.status).toBe(200);
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-in");
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBe(token);
    expect(response.headers.get("x-middleware-override-headers")).toContain("x-orbitid-auth-status");
  });

  it("does not treat a token with an audience (machine / OIDC) as a session", async () => {
    const token = await signTestToken({ sub: "mch_1", sid: "sess_forged" }, { audience: "orbitid-m2m" });
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(req("/dashboard", { token }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).not.toBe("signed-in");
  });

  it("accepts the __session cookie when no bearer token is present", async () => {
    const token = await signTestToken();
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000` }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-in");
  });

  it("prefers the Authorization header over the cookie", async () => {
    const headerToken = await signTestToken({ sub: "user_header" });
    const cookieToken = await signTestToken({ sub: "user_cookie" });
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(
      req("/dashboard", { token: headerToken, cookie: `__session=${cookieToken}` }),
    );
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBe(headerToken);
  });

  it("reports signed-out when there is neither a token nor a client session", async () => {
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(req("/"));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
    expect(forwardedAuth(response, "x-orbitid-auth-reason")).toBe("no-session");
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBeNull();
  });

  it("requests a handshake when the token is expired but __client_uat is live", async () => {
    const token = await signExpiredToken();
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(
      req("/dashboard", { cookie: `__session=${token}; __client_uat=1700000000` }),
    );
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("handshake");
    expect(forwardedAuth(response, "x-orbitid-auth-reason")).toBe("session-token-expired");
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBeNull();
  });

  it("requests a handshake when the token is missing but __client_uat is live", async () => {
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(req("/dashboard", { cookie: "__client_uat=1700000000" }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("handshake");
    expect(forwardedAuth(response, "x-orbitid-auth-reason")).toBe("session-token-missing");
  });

  it("reports signed-out with an expired reason when __client_uat is 0", async () => {
    const token = await signExpiredToken();
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(
      req("/dashboard", { cookie: `__session=${token}; __client_uat=0` }),
    );
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
    expect(forwardedAuth(response, "x-orbitid-auth-reason")).toBe("session-token-expired");
  });

  it("rejects tokens signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: "sess_other" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_other")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(other.privateKey);
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const response = await middleware(req("/dashboard", { token }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
  });

  it("rejects a token from another issuer even when the signature checks out", async () => {
    const token = await signTestToken({}, { issuer: "https://attacker.example" });
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey(), issuer: "http://localhost:4000" });
    const response = await middleware(req("/dashboard", { token }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
    const ok = await signTestToken({}, { issuer: "http://localhost:4000" });
    const accepted = await middleware(req("/dashboard", { token: ok }));
    expect(forwardedAuth(accepted, "x-orbitid-auth-status")).toBe("signed-in");
  });

  it("does not treat a pending session as signed in", async () => {
    const token = await signTestToken({ sts: "pending", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    const isProtected = createRouteMatcher(["/dashboard(.*)"]);
    let seen: { authenticated: boolean; userId: string | null } | null = null;
    const middleware = orbitIdMiddleware(
      async (auth, request) => {
        seen = { authenticated: auth.isAuthenticated, userId: auth.userId };
        if (isProtected(request)) await auth.protect({ permission: "org:sys_memberships:manage" });
      },
      { jwtKey: await jwtKey(), signInUrl: "/sign-in" },
    );
    const response = await middleware(req("/dashboard", { token }));
    expect(seen).toEqual({ authenticated: false, userId: null });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
  });

  it("enforces authorizedParties from the azp claim", async () => {
    const token = await signTestToken({ azp: "https://evil.test" });
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      authorizedParties: ["https://app.test"],
    });
    const response = await middleware(req("/dashboard", { token }));
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
    expect(forwardedAuth(response, "x-orbitid-auth-reason")).toBe("unauthorized-party");
  });

  it("redirects protected routes to sign-in with redirect_url", async () => {
    const isProtected = createRouteMatcher(["/dashboard(.*)"]);
    const middleware = orbitIdMiddleware(
      async (auth, request) => {
        if (isProtected(request)) await auth.protect();
      },
      { jwtKey: await jwtKey(), signInUrl: "/sign-in" },
    );
    const response = await middleware(req("/dashboard/settings"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("redirect_url")).toBe("https://app.test/dashboard/settings");
  });

  it("passes auth data to the handler and lets it continue", async () => {
    const token = await signTestToken({
      sub: "user_42",
      org_id: "org_1",
      org_role: "org:admin",
      org_permissions: ["org:sys_memberships:manage"],
    });
    let seen: { userId: string | null; canManage: boolean } | null = null;
    const middleware = orbitIdMiddleware(
      async (auth) => {
        seen = {
          userId: auth.userId,
          canManage: auth.has({ permission: "org:sys_memberships:manage" }),
        };
      },
      { jwtKey: await jwtKey() },
    );
    const response = await middleware(req("/dashboard", { token }));
    expect(seen).toEqual({ userId: "user_42", canManage: true });
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-in");
  });

  it("returns 404 when a signed-in user lacks the required permission", async () => {
    const token = await signTestToken({ org_role: "org:member", org_permissions: [] });
    const middleware = orbitIdMiddleware(
      async (auth) => {
        await auth.protect({ permission: "org:sys_memberships:manage" });
      },
      { jwtKey: await jwtKey() },
    );
    const response = await middleware(req("/admin", { token }));
    expect(response.status).toBe(404);
  });

  it("redirects unauthorized users to unauthorizedUrl", async () => {
    const token = await signTestToken({ org_role: "org:member" });
    const middleware = orbitIdMiddleware(
      async (auth) => {
        await auth.protect({ role: "org:admin", unauthorizedUrl: "/no-access" });
      },
      { jwtKey: await jwtKey() },
    );
    const response = await middleware(req("/admin", { token }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/no-access");
  });

  it("supports redirectToSignIn returning a response", async () => {
    const middleware = orbitIdMiddleware(
      async (auth) => auth.redirectToSignIn({ returnBackUrl: "/settings" }),
      { jwtKey: await jwtKey(), signInUrl: "/login" },
    );
    const response = await middleware(req("/dashboard"));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("redirect_url")).toBe("/settings");
  });

  it("returns handler-provided responses untouched (plus CSP)", async () => {
    const middleware = orbitIdMiddleware(
      async () => new Response("teapot", { status: 418 }),
      {
        jwtKey: await jwtKey(),
        contentSecurityPolicy: {
          directives: { "default-src": ["'self'"], "script-src": ["'self'"] },
        },
      },
    );
    const response = await middleware(req("/"));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; script-src 'self'");
  });

  it("emits report-only CSP when requested", async () => {
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      contentSecurityPolicy: { directives: ["default-src 'self'"], reportOnly: true },
    });
    const response = await middleware(req("/"));
    expect(response.headers.get("content-security-policy-report-only")).toBe("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("overwrites client-supplied auth headers", async () => {
    const middleware = orbitIdMiddleware({ jwtKey: await jwtKey() });
    const request = new NextRequest("https://app.test/dashboard", {
      headers: {
        "x-orbitid-auth-status": "signed-in",
        "x-orbitid-auth-token": "forged",
      },
    });
    const response = await middleware(request);
    expect(forwardedAuth(response, "x-orbitid-auth-status")).toBe("signed-out");
    expect(forwardedAuth(response, "x-orbitid-auth-token")).toBeNull();
  });

  it("omits organization claims when the session has none", async () => {
    const token = await signTestToken();
    let checked = false;
    const middleware = orbitIdMiddleware(async (auth) => {
      checked = true;
      expect(auth.orgId).toBeNull();
      expect(auth.has({ role: "org:admin" })).toBe(false);
    }, { jwtKey: await jwtKey() });
    await middleware(req("/", { token }));
    expect(checked).toBe(true);
  });
});
