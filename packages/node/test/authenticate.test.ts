import { describe, expect, it } from "vitest";
import { createOrbitId } from "../src/client";
import type { ExpressRequest } from "../src/adapters/express";
import { startRealServer, createUserWithSession } from "./helpers/server";

describe("authenticate()", () => {
  it("reads a bearer token from a Fetch Request", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const auth = await orbit.authenticate(new Request("https://app.example.com/api", { headers: { authorization: `Bearer ${user.token}` } }));
      expect(auth?.userId).toBe(user.userId);
      expect(auth?.sessionId).toBe(user.sessionId);
      expect(auth?.claims.sub).toBe(user.userId);
    } finally {
      await server.close();
    }
  });

  it("reads the __session cookie when there is no bearer token", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const request = new Request("https://app.example.com/api", { headers: { cookie: `theme=dark; __session=${user.token}` } });
      await expect(orbit.authenticate(request)).resolves.toMatchObject({ userId: user.userId });
    } finally {
      await server.close();
    }
  });

  it("prefers the bearer token over the cookie", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const other = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const request = new Request("https://app.example.com/api", {
        headers: { authorization: `Bearer ${user.token}`, cookie: `__session=${other.token}` },
      });
      await expect(orbit.authenticate(request)).resolves.toMatchObject({ userId: user.userId });
    } finally {
      await server.close();
    }
  });

  it("reads a Node IncomingMessage-shaped request", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const req = { headers: { authorization: `bearer ${user.token}` } };
      await expect(orbit.authenticate(req)).resolves.toMatchObject({ userId: user.userId });
    } finally {
      await server.close();
    }
  });

  it("accepts array header values produced by node:http", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const req = { headers: { authorization: [`Bearer ${user.token}`], cookie: [] as string[] } };
      await expect(orbit.authenticate(req)).resolves.toMatchObject({ userId: user.userId });
    } finally {
      await server.close();
    }
  });

  it("returns null without a token, and for expired or invalid tokens", async () => {
    const server = await startRealServer();
    try {
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, jwksCooldownMs: 0 });
      await expect(orbit.authenticate({ headers: {} })).resolves.toBeNull();
      await expect(orbit.authenticate({ headers: { authorization: "Bearer not-a-jwt" } })).resolves.toBeNull();

      const { signJwt } = await import("../../server/src/services/tokens");
      const expired = await signJwt(server.context, { sub: "user_x", sid: "sess_x", nbf: Math.floor(Date.now() / 1000) - 120 }, { expiresInSeconds: -60, issuer: server.url });
      await expect(orbit.authenticate({ headers: { authorization: `Bearer ${expired}` } })).resolves.toBeNull();
    } finally {
      await server.close();
    }
  });

  it("throws when verification cannot run (JWKS unreachable), so callers can answer 503", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "http://127.0.0.1:1", sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    await expect(orbit.authenticate({ headers: { authorization: `Bearer ${header}.${payload}.sig` } })).rejects.toMatchObject({ code: "jwks_fetch_failed", reason: "jwks-fetch-failed" });
  });
});

describe("auth context", () => {
  it("exposes organization claims and has() checks from a real token", async () => {
    const server = await startRealServer();
    try {
      const user = await createUserWithSession(server);
      const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
      const { createOrganization, tokenWithOrganization } = await import("./helpers/server");
      const orgId = await createOrganization(server, user.userId, "Acme");
      const token = await tokenWithOrganization(server, user, orgId);

      const auth = await orbit.authenticate({ headers: { authorization: `Bearer ${token}` } });
      expect(auth?.orgId).toBe(orgId);
      expect(auth?.orgRole).toBe("org:admin");
      expect(auth?.orgPermissions).toContain("org:sys_memberships:manage");
      expect(auth?.has({ role: "org:admin" })).toBe(true);
      expect(auth?.has({ role: "org:member" })).toBe(false);
      expect(auth?.has({ permission: "org:sys_memberships:manage" })).toBe(true);
      expect(auth?.has({ permission: "org:billing:manage" })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("returns null when the request object is not a request", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "https://auth.example.com" });
    await expect(orbit.authenticate(undefined as unknown as ExpressRequest)).resolves.toBeNull();
  });
});
