import { afterEach, describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from "jose";
import { createOrbitId } from "../src/client";
import { OrbitIdError } from "../src/errors";
import { JwksCache } from "../src/jwks";
import { createTransport } from "../src/transport";
import { startRealServer, createUserWithSession, type RealServer } from "./helpers/server";

let server: RealServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

function sdkFor(target: RealServer) {
  return createOrbitId({ secretKey: target.secretKey, apiUrl: target.url, jwksCooldownMs: 0 });
}

describe("verifyToken against the real instance JWKS", () => {
  it("verifies a real session token and exposes its claims", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = sdkFor(server);

    const claims = await orbit.verifyToken(user.token);
    expect(claims.sub).toBe(user.userId);
    expect(claims.sid).toBe(user.sessionId);
    expect(claims.iss).toBe(server.url);
    expect(typeof claims.exp).toBe("number");
  });

  it("rejects a token signed by a different key (tampered signature)", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = sdkFor(server);

    const [header, payload] = user.token.split(".");
    const forged = `${header}.${payload}.${"A".repeat(342)}`;
    await expect(orbit.verifyToken(forged)).rejects.toMatchObject({ code: "token_invalid_signature", reason: "invalid-signature" });
  });

  it("rejects a token with a modified payload", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = sdkFor(server);

    const [header, payload, signature] = user.token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
    decoded.org_role = "org:admin";
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await expect(orbit.verifyToken(`${header}.${tampered}.${signature}`)).rejects.toMatchObject({ reason: "invalid-signature" });
  });

  it("rejects a token signed with another instance's key", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    const other = await startRealServer();
    try {
      const foreignUser = await createUserWithSession(other);
      await expect(orbit.verifyToken(foreignUser.token)).rejects.toMatchObject({ reason: "no-matching-key" });
    } finally {
      await other.close();
    }
  });

  it("rejects an expired token", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    // A token minted by the instance key with a past `exp` exercises the real verification path.
    const { signJwt } = await import("../../server/src/services/tokens");
    const expired = await signJwt(server.context, { sub: "user_x", sid: "sess_x", nbf: Math.floor(Date.now() / 1000) - 120 }, {
      expiresInSeconds: -60,
      issuer: server.url,
    });
    await expect(orbit.verifyToken(expired)).rejects.toMatchObject({ code: "token_expired", reason: "token-expired" });
  });

  it("rejects a token that is not valid yet", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, clockToleranceSeconds: 0, jwksCooldownMs: 0 });
    const { signJwt } = await import("../../server/src/services/tokens");
    const future = await signJwt(server.context, { sub: "user_x", sid: "sess_x", nbf: Math.floor(Date.now() / 1000) + 120 }, {
      expiresInSeconds: 600,
      issuer: server.url,
    });
    await expect(orbit.verifyToken(future)).rejects.toMatchObject({ code: "token_not_active_yet", reason: "token-not-active-yet" });
  });

  it("allows a small clock skew for nbf", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, clockToleranceSeconds: 120, jwksCooldownMs: 0 });
    const { signJwt } = await import("../../server/src/services/tokens");
    const slightlyEarly = await signJwt(server.context, { sub: "user_x", sid: "sess_x", nbf: Math.floor(Date.now() / 1000) + 30 }, {
      expiresInSeconds: 600,
      issuer: server.url,
    });
    await expect(orbit.verifyToken(slightlyEarly)).resolves.toMatchObject({ sub: "user_x", sid: "sess_x" });
  });

  it("rejects a token from another issuer", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    const { signJwt } = await import("../../server/src/services/tokens");
    const wrongIssuer = await signJwt(server.context, { sub: "user_x", sid: "sess_x" }, {
      expiresInSeconds: 600,
      issuer: "https://evil.example.com",
    });
    await expect(orbit.verifyToken(wrongIssuer)).rejects.toMatchObject({ code: "token_invalid_issuer", reason: "invalid-issuer" });
  });

  it("rejects `alg: none` and HS256 tokens", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: server.url, sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    await expect(orbit.verifyToken(`${header}.${payload}.`)).rejects.toMatchObject({ code: "token_invalid_algorithm", reason: "invalid-algorithm" });

    const hsHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    await expect(orbit.verifyToken(`${hsHeader}.${payload}.c2ln`)).rejects.toMatchObject({ reason: "invalid-algorithm" });
  });

  it("rejects a token whose header claims an algorithm the key cannot satisfy", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = sdkFor(server);
    const [header, payload, signature] = user.token.split(".");
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>;
    decoded.alg = "ES256";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${payload}.${signature}`;
    // A per-token problem must stay a token problem, not become an outage.
    await expect(orbit.verifyToken(forged)).rejects.toMatchObject({ code: "token_invalid", reason: "invalid-claims" });
    await expect(orbit.authenticate({ headers: { authorization: `Bearer ${forged}` } })).resolves.toBeNull();
  });

  it("rejects a malformed token", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    await expect(orbit.verifyToken("not-a-jwt")).rejects.toMatchObject({ reason: "invalid-claims" });
    await expect(orbit.verifyToken("")).rejects.toMatchObject({ code: "token_missing", reason: "token-missing" });
  });

  it("rejects a machine token (audience, no session id) as not a session token", async () => {
    server = await startRealServer();
    const orbit = sdkFor(server);
    const machine = await orbit.client.m2m.machines.createMachine({ name: "worker" });
    const token = await orbit.client.m2m.tokens.createToken({ machineId: machine.id, tokenFormat: "jwt" });
    // The JWT carries an audience; a session verifier without a configured audience refuses it.
    await expect(orbit.verifyToken(token.token!)).rejects.toMatchObject({ code: "token_not_session", reason: "not-session-token" });
  });

  it("enforces a configured audience against a real token", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, audience: "some-other-audience", jwksCooldownMs: 0 });
    const machine = await orbit.client.m2m.machines.createMachine({ name: "audience-worker" });
    const token = await orbit.client.m2m.tokens.createToken({ machineId: machine.id, tokenFormat: "jwt" });
    // The token is signed by the instance and carries a different `aud`.
    await expect(orbit.verifyToken(token.token!)).rejects.toMatchObject({ code: "token_invalid_audience", reason: "invalid-audience" });
  });

  it("enforces authorizedParties when configured", async () => {
    server = await startRealServer();
    const strict = createOrbitId({
      secretKey: server.secretKey,
      apiUrl: server.url,
      authorizedParties: ["https://app.example.com"],
      jwksCooldownMs: 0,
    });
    const user = await createUserWithSession(server);
    // Session tokens minted by the Backend API carry no `azp`.
    await expect(strict.verifyToken(user.token)).rejects.toMatchObject({ reason: "invalid-authorized-party" });
  });

  it("still verifies tokens minted before a signing-key rotation", async () => {
    server = await startRealServer();
    const user = await createUserWithSession(server);
    const orbit = sdkFor(server);
    await orbit.verifyToken(user.token);

    const { rotateSigningKey } = await import("../../server/src/services/tokens");
    await rotateSigningKey(server.context);
    await expect(orbit.verifyToken(user.token)).resolves.toMatchObject({ sub: user.userId });
  });
});

describe("JwksCache", () => {
  it("fetches the key set once and serves later lookups from memory", async () => {
    let fetches = 0;
    const { publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await import("jose").then((jose) => jose.exportJWK(publicKey))), kid: "kid_1", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      },
    });
    await cache.getKey("kid_1", "RS256");
    await cache.getKey("kid_1", "RS256");
    await cache.getKey("kid_1", "RS256");
    expect(fetches).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("refreshes once for an unknown kid, then applies the cooldown", async () => {
    let fetches = 0;
    const { publicKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "kid_1", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      cooldownMs: 60_000,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      },
    });
    await expect(cache.getKey("kid_1", "RS256")).resolves.toBeTruthy();
    const afterFirst = fetches;

    // A flood of unknown kids must not become a flood of fetches.
    for (let i = 0; i < 25; i += 1) {
      await expect(cache.getKey(`kid_missing_${i}`, "RS256")).rejects.toMatchObject({ code: "jwks_no_matching_key" });
    }
    expect(fetches).toBeLessThanOrEqual(afterFirst + 1);
  });

  it("re-fetches after the cooldown for a new kid", async () => {
    let fetches = 0;
    let clock = 1_000_000;
    const { publicKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "kid_1", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      cooldownMs: 30_000,
      maxAgeMs: 10_000_000,
      now: () => clock,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      },
    });
    await expect(cache.getKey("kid_1", "RS256")).resolves.toBeTruthy();
    const base = fetches;
    await expect(cache.getKey("kid_2", "RS256")).rejects.toMatchObject({ code: "jwks_no_matching_key" });
    expect(fetches).toBe(base + 1);
    clock += 30_001;
    await expect(cache.getKey("kid_3", "RS256")).rejects.toMatchObject({ code: "jwks_no_matching_key" });
    expect(fetches).toBe(base + 2);
  });

  it("coalesces concurrent refreshes into one request", async () => {
    let fetches = 0;
    const { publicKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "kid_1", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => {
        fetches += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      },
    });
    await Promise.all(Array.from({ length: 10 }, () => cache.getKey("kid_1", "RS256").catch(() => null)));
    expect(fetches).toBe(1);
  });

  it("keeps serving stale keys when a refresh fails", async () => {
    let fail = false;
    const { publicKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "kid_1", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      maxAgeMs: 1,
      cooldownMs: 60_000,
      fetch: async () => {
        if (fail) return new Response(null, { status: 500 });
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      },
    });
    await expect(cache.getKey("kid_1", "RS256")).resolves.toBeTruthy();
    fail = true;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Past maxAge the cache tries to refresh, fails, and keeps the previous key material.
    await expect(cache.getKey("kid_1", "RS256")).resolves.toBeTruthy();
  });

  it("reports an unreachable JWKS endpoint as jwks_fetch_failed", async () => {
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(cache.getKey("kid_1", "RS256")).rejects.toMatchObject({ code: "jwks_fetch_failed", reason: "jwks-fetch-failed" });
  });

  it("rejects a JWKS document with no usable keys", async () => {
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    });
    await expect(cache.getKey(undefined, "RS256")).rejects.toMatchObject({ code: "jwks_fetch_failed" });
  });

  it("matches a key without a kid when the instance publishes exactly one", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "only", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
    });
    await expect(cache.getKey(undefined, "RS256")).resolves.toBeTruthy();
    void privateKey;
  });
});

describe("transport wiring for JWKS", () => {
  it("sends the SDK User-Agent to the JWKS endpoint too", async () => {
    server = await startRealServer();
    const seen: (string | null)[] = [];
    const transport = createTransport({
      fetch: async (input, init) => {
        if (input.includes("jwks")) seen.push(new Headers(init?.headers).get("user-agent"));
        return fetch(input, init);
      },
    });
    const user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, fetch: transport.request, jwksCooldownMs: 0 });
    await orbit.verifyToken(user.token);
    expect(seen).toEqual(["orbitid-node/0.1.0"]);
  });

  it("surfaces a JWKS outage as a typed error rather than signed-out", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 500 });
    await expect(orbit.verifyToken("a.b.c")).rejects.toBeInstanceOf(OrbitIdError);
  });
});

describe("PEM-free defaults", () => {
  it("verifies a token signed by an RS256 key that the JWKS publishes as a public JWK", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const { exportJWK } = await import("jose");
    const jwk = { ...(await exportJWK(publicKey)), kid: "kid_pem", alg: "RS256", use: "sig" };
    const cache = new JwksCache({
      url: "https://auth.example.com/.well-known/jwks.json",
      fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
    });
    const { verifySessionToken } = await import("../src/token");
    const token = await signTestToken(privateKey, "kid_pem");
    const claims = await verifySessionToken({ token }, { issuer: "https://auth.example.com", clockToleranceSeconds: 5, jwks: cache });
    expect(claims.sub).toBe("user_pem");
    await expect(exportSPKI(publicKey)).resolves.toContain("BEGIN PUBLIC KEY");
  });
});

async function signTestToken(privateKey: KeyLike, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "sess_pem", sts: "active" })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setSubject("user_pem")
    .setIssuer("https://auth.example.com")
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(now + 60)
    .sign(privateKey);
}
