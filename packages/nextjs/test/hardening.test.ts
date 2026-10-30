import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair, exportSPKI } from "jose";
import { NextRequest } from "next/server";
import { orbitIdMiddleware } from "../src/middleware";
import { createRouteMatcher } from "../src/route-matcher";
import { buildAuthUrl, getServerEnv, toAbsoluteUrl } from "../src/env";
import { completeHandshake, HANDSHAKE_MARKER_COOKIE } from "../src/handshake";
import { resolveRequestAuthState } from "../src/resolve";
import { verifySessionToken } from "../src/token";
import { getTestKeys, signExpiredToken, signTestToken } from "./helpers";

const APP = "https://app.test";

function forwardedAuth(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

async function jwtKey(): Promise<string> {
  return (await getTestKeys()).publicKeyPem;
}

describe("redirect targets cannot leave the app", () => {
  it("refuses protocol-relative and backslash-prefixed targets", () => {
    for (const target of ["//evil.test/x", "/\\evil.test/x", "\\\\evil.test", "/\t/evil.test"]) {
      expect(toAbsoluteUrl(target, APP)).toBe(`${APP}/`);
    }
  });

  it("resolves ordinary relative paths", () => {
    expect(toAbsoluteUrl("/dashboard", APP)).toBe(`${APP}/dashboard`);
    expect(toAbsoluteUrl("https://other.test/x", APP)).toBe("https://other.test/x");
  });

  it("refuses a non-http(s) or credential-bearing absolute target", () => {
    for (const target of ["javascript:alert(1)", "data:text/html,x", "https://user:pass@other.test/x"]) {
      expect(toAbsoluteUrl(target, APP)).toBe(`${APP}/`);
    }
  });

  it("builds a sign-in redirect that stays on the app origin", () => {
    expect(buildAuthUrl("/sign-in", "//evil.test")).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("//evil.test")}`,
    );
    expect(toAbsoluteUrl("/sign-in", APP)).toBe(`${APP}/sign-in`);
  });

  it("answers an unauthorized redirect with a same-origin location", async () => {
    const token = await signTestToken({ org_role: "org:member" });
    const middleware = orbitIdMiddleware(
      async (auth) => {
        await auth.protect({ role: "org:admin", unauthorizedUrl: "//evil.test/steal" });
      },
      { jwtKey: await jwtKey() },
    );
    const response = await middleware(new NextRequest(`${APP}/admin`, { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).origin).toBe(APP);
  });
});

describe("route matcher is stateless", () => {
  it("keeps matching a global RegExp on every request", () => {
    const matcher = createRouteMatcher([/^\/admin(\/|$)/g]);
    for (let i = 0; i < 6; i += 1) expect(matcher({ url: `${APP}/admin` })).toBe(true);
  });

  it("does not consume a caller-owned RegExp's lastIndex", () => {
    const pattern = /^\/dashboard(\/|$)/g;
    const matcher = createRouteMatcher([pattern]);
    matcher({ url: `${APP}/dashboard` });
    expect(pattern.lastIndex).toBe(0);
  });
});

describe("session token verification is strict", () => {
  it("refuses a bare string jwtKey (algorithm-confusion guard)", async () => {
    const result = await verifySessionToken("a.b.c", { jwtKey: "super-secret" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("no-key");
    expect(result.message).toMatch(/hs256:/);
  });

  it("accepts an HMAC secret only when it is explicitly marked", async () => {
    const secret = "an-operator-chosen-hmac-secret";
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: "sess_hs" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_hs")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("https://auth.test")
      .sign(new TextEncoder().encode(secret));
    expect((await verifySessionToken(token, { jwtKey: `hs256:${secret}`, issuer: "https://auth.test" })).valid).toBe(true);
    expect((await verifySessionToken(token, { jwtKey: secret, issuer: "https://auth.test" })).valid).toBe(false);
  });

  it("refuses an HS256 token signed with the public key", async () => {
    const publicKeyPem = await jwtKey();
    const publicKey = publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, "");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ sid: "sess_forged" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_victim")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("http://localhost:4000")
      .sign(new TextEncoder().encode(publicKey));
    const result = await verifySessionToken(forged, { jwtKey: publicKeyPem, issuer: "http://localhost:4000" });
    expect(result.valid).toBe(false);
  });

  it("accepts an explicitly supplied HMAC secret as bytes", async () => {
    const secret = new TextEncoder().encode("an-operator-chosen-hmac-secret");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sid: "sess_hs" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_hs")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("https://auth.test")
      .sign(secret);
    const result = await verifySessionToken(token, { jwtKey: secret, issuer: "https://auth.test" });
    expect(result.valid).toBe(true);
  });

  it("rejects a validly signed token that has no sub/sid", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: "users:read" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("https://auth.test")
      .sign(privateKey);
    const result = await verifySessionToken(token, {
      jwtKey: await exportSPKI(publicKey),
      issuer: "https://auth.test",
    });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.reason).toBe("invalid");
  });

  it("does not return claims from a token it could not verify", async () => {
    const other = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ sid: "sess_forged", org_role: "org:admin" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_victim")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("http://localhost:4000")
      .sign(other.privateKey);
    const result = await verifySessionToken(forged, { jwtKey: await jwtKey(), issuer: "http://localhost:4000" });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("unreachable");
    expect(result.claims ?? null).toBeNull();
  });

  it("does not forward claims from an expired token into signed-out auth state", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });
    const expired = await signExpiredToken({ org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    const state = await resolveRequestAuthState(
      new Headers({ cookie: `__session=${expired}` }),
      `${APP}/admin`,
      env,
    );
    expect(state.status).toBe("signed-out");
    expect(state.claims).toBeNull();
    expect(state.token).toBeNull();
  });

  it("treats a forwarded signed-in state without a token as signed out", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });
    const state = await resolveRequestAuthState(
      new Headers({ "x-orbitid-auth-status": "signed-in" }),
      `${APP}/admin`,
      env,
    );
    expect(state.status).toBe("signed-out");
    expect(state.claims).toBeNull();
    expect(state.token).toBeNull();
  });

  it("refuses a forwarded token that was not signed for this issuer", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), issuer: "https://auth.test" });
    const foreign = await signTestToken({ org_role: "org:admin" }, { issuer: "https://evil.test" });
    const state = await resolveRequestAuthState(
      new Headers({ "x-orbitid-auth-status": "signed-in", "x-orbitid-auth-token": foreign }),
      `${APP}/admin`,
      env,
    );
    expect(state.status).toBe("signed-out");
    expect(state.claims).toBeNull();
  });
});

describe("CSP nonce", () => {
  it("adds the nonce to script-src even without a placeholder", async () => {
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      contentSecurityPolicy: { directives: { "default-src": ["'self'"], "script-src": ["'self'"] }, nonce: "abc123" },
    });
    const response = await middleware(new NextRequest(`${APP}/`));
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("'nonce-abc123'");
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
  });

  it("replaces an existing placeholder instead of duplicating it", async () => {
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      contentSecurityPolicy: { directives: { "script-src": ["'self'", "'nonce-OLD'"] }, nonce: "new" },
    });
    const csp = (await middleware(new NextRequest(`${APP}/`))).headers.get("content-security-policy")!;
    expect(csp).toBe("script-src 'self' 'nonce-new'");
  });

  it("does not synthesize directives the operator did not configure", async () => {
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      contentSecurityPolicy: { directives: { "default-src": ["'self'"] }, nonce: "abc123" },
    });
    const csp = (await middleware(new NextRequest(`${APP}/`))).headers.get("content-security-policy")!;
    expect(csp).toBe("default-src 'self'; script-src 'self' 'nonce-abc123'");
  });

  it("answers an empty has() with false", async () => {
    const token = await signTestToken({ org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    const middleware = orbitIdMiddleware(async (auth) => {
      expect(auth.isAuthenticated).toBe(true);
      expect(auth.has({})).toBe(false);
    }, { jwtKey: await jwtKey() });
    await middleware(new NextRequest(`${APP}/dashboard`, { headers: { authorization: `Bearer ${token}` } }));
  });

  it("drops a nonce that would inject into the header", async () => {
    const middleware = orbitIdMiddleware({
      jwtKey: await jwtKey(),
      contentSecurityPolicy: { directives: { "default-src": ["'self'"], "script-src": ["'self'"] }, nonce: "x; script-src *" },
    });
    const csp = (await middleware(new NextRequest(`${APP}/`))).headers.get("content-security-policy")!;
    expect(csp).toBe("default-src 'self'; script-src 'self'");
  });
});

describe("handshake cookie boundary", () => {
  it("ignores a handshake token when the middleware did not start the attempt", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });
    const token = await signTestToken({ sub: "user_victim" });
    const request = new NextRequest(`${APP}/dashboard?__orbit_handshake=${token}`);
    const outcome = await completeHandshake(request, env, {});
    expect(outcome?.status).toBe("signed-out");
    expect(outcome?.response.headers.getSetCookie().join(" ")).not.toContain("__session=");
  });

  it("drops a tampered handshake token and clears the session", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });
    const request = new NextRequest(`${APP}/dashboard?__orbit_handshake=tampered`, {
      headers: { cookie: `${HANDSHAKE_MARKER_COOKIE}=1` },
    });
    const outcome = await completeHandshake(request, env, {});
    expect(outcome?.status).toBe("signed-out");
    const cookies = outcome?.response.headers.getSetCookie().join(" ") ?? "";
    expect(cookies).toContain("__session=;");
    expect(cookies).toContain("__client_uat=0");
  });
});
