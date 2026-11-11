import { describe, expect, it, vi } from "vitest";
import { SignJWT, generateKeyPair, exportSPKI, exportJWK } from "jose";
import { NextRequest } from "next/server";
import { orbitIdMiddleware } from "../src/middleware";
import { createRouteMatcher } from "../src/route-matcher";
import { buildAuthUrl, getServerEnv, toAbsoluteUrl } from "../src/env";
import { completeHandshake, HANDSHAKE_MARKER_COOKIE, HANDSHAKE_RETRY_MARKER } from "../src/handshake";
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

  it("drops a tampered handshake token without clearing the browser", async () => {
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });
    const request = new NextRequest(`${APP}/dashboard?__orbit_handshake=tampered`, {
      headers: { cookie: `__session=stale; __client_uat=1700000000; ${HANDSHAKE_MARKER_COOKIE}=1` },
    });
    const outcome = await completeHandshake(request, env, {});
    expect(outcome?.status).toBe("unavailable");
    expect(outcome?.response.status).toBe(503);
    const cookies = outcome?.response.headers.getSetCookie().join(" ") ?? "";
    // A bad token is a transient verification failure, not the API saying the session ended: keep the
    // cookies and serve the same retriable 503 as `transient`, with the plain marker no longer re-armed alone.
    expect(cookies).not.toContain("__session=;");
    expect(cookies).not.toContain("__client_uat=0");
    expect(cookies).toContain(`${HANDSHAKE_MARKER_COOKIE}=${HANDSHAKE_RETRY_MARKER}`);
  });
});

describe("resolve does not handshake for a tampered token", () => {
  it("stays signed out for an invalid token even when __client_uat is live", async () => {
    const other = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ sid: "sess_forged" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_victim")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setIssuer("https://auth.test")
      .sign(other.privateKey);
    const env = getServerEnv({ jwtKey: await jwtKey(), apiUrl: "https://auth.test" });

    const state = await resolveRequestAuthState(
      new Headers({ cookie: `__session=${forged}; __client_uat=${now}` }),
      `${APP}/admin`,
      env,
    );

    // Only an expired token may start a handshake; a bad signature is treated as signed out.
    expect(state.status).toBe("signed-out");
    expect(state.token).toBeNull();
    expect(state.claims).toBeNull();
  });
});


describe("a signing-key rotation is not a tampered token", () => {
  async function jwksServer(keys: Record<string, unknown>[]) {
    let fetches = 0;
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      const key = keys[Math.min(fetches, keys.length - 1)]!;
      fetches += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [key] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    return {
      url: `http://127.0.0.1:${address.port}`,
      count: () => fetches,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("forces one JWKS refetch when the token names a key the cache does not know", async () => {
    const oldPair = await generateKeyPair("RS256");
    const newPair = await generateKeyPair("RS256");
    const oldJwk = { ...(await exportJWK(oldPair.publicKey)), kid: "old-key", alg: "RS256", use: "sig" };
    const newJwk = { ...(await exportJWK(newPair.publicKey)), kid: "new-key", alg: "RS256", use: "sig" };
    const server = await jwksServer([oldJwk, newJwk]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ sid: "sess_rotated" })
        .setProtectedHeader({ alg: "RS256", kid: "new-key" })
        .setSubject("user_rotated")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .setIssuer(server.url)
        .sign(newPair.privateKey);

      const result = await verifySessionToken(token, { apiUrl: server.url, issuer: server.url });
      expect(result.valid).toBe(true);
      expect(server.count()).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("bounds forced JWKS reloads so an attacker-controlled kid cannot fetch on every request", async () => {
    const oldPair = await generateKeyPair("RS256");
    const attackerPair = await generateKeyPair("RS256");
    const oldJwk = { ...(await exportJWK(oldPair.publicKey)), kid: "old-key", alg: "RS256", use: "sig" };
    const server = await jwksServer([oldJwk]);
    try {
      const now = Math.floor(Date.now() / 1000);
      for (let index = 0; index < 20; index += 1) {
        const token = await new SignJWT({ sid: `sess_attacker_${index}` })
          .setProtectedHeader({ alg: "RS256", kid: `made-up-${index}` })
          .setSubject("user_attacker")
          .setIssuedAt(now)
          .setExpirationTime(now + 60)
          .setIssuer(server.url)
          .sign(attackerPair.privateKey);
        const result = await verifySessionToken(token, { apiUrl: server.url, issuer: server.url });
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).toBe("unverifiable-key");
      }
      // One normal key-set fetch plus at most one forced reload for the whole burst of twenty unknown kids.
      expect(server.count()).toBeLessThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("hands a live client off to the handshake instead of signing it out", async () => {
    const oldPair = await generateKeyPair("RS256");
    const unknownPair = await generateKeyPair("RS256");
    const oldJwk = { ...(await exportJWK(oldPair.publicKey)), kid: "old-key", alg: "RS256", use: "sig" };
    const server = await jwksServer([oldJwk]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({ sid: "sess_unknown" })
        .setProtectedHeader({ alg: "RS256", kid: "rotated-elsewhere" })
        .setSubject("user_unknown")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .setIssuer(server.url)
        .sign(unknownPair.privateKey);

      const env = getServerEnv({ apiUrl: server.url });
      const state = await resolveRequestAuthState(
        new Headers({ cookie: `__session=${token}; __client_uat=${now}` }),
        `${APP}/admin`,
        env,
      );
      // A rotation that has not reached this process is exactly what the handshake heals.
      expect(state.status).toBe("handshake");
      expect(state.token).toBeNull();

      const withoutLiveClient = await resolveRequestAuthState(
        new Headers({ cookie: `__session=${token}; __client_uat=0` }),
        `${APP}/admin`,
        env,
      );
      // With no live client proof there is nothing to hand off: the browser stays signed out.
      expect(withoutLiveClient.status).toBe("signed-out");
      expect(withoutLiveClient.reason).toBe("session-token-unverifiable-key");
    } finally {
      await server.close();
    }
  });
});
