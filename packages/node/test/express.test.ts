import { afterEach, describe, expect, it } from "vitest";
import { createOrbitId } from "../src/client";
import { getAuth } from "../src/adapters/express";
import { startRealServer, createUserWithSession, createOrganization, tokenWithOrganization, type RealServer, type TestUser } from "./helpers/server";
import { MiniApp, http } from "./helpers/mini-app";

let server: RealServer | null = null;
let app: MiniApp | null = null;
let user: TestUser;
let orgToken: string;

async function boot(app: MiniApp): Promise<void> {
  server = await startRealServer();
  user = await createUserWithSession(server);
  const orgId = await createOrganization(server, user.userId, "Acme");
  orgToken = await tokenWithOrganization(server, user, orgId);
  await app.listen();
}

afterEach(async () => {
  await app?.close();
  app = null;
  await server?.close();
  server = null;
});

describe("express middleware", () => {
  it("sets req.auth to the caller and continues", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    app = new MiniApp();
    app.get("/whoami", orbit.expressMiddleware(), (req, res) => {
      res.status(200).json({ userId: req.auth?.userId ?? null, sessionId: req.auth?.sessionId ?? null });
    });
    await app.listen();

    const authed = await http(`${app.url}/whoami`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(authed.status).toBe(200);
    expect(authed.body).toEqual({ userId: user.userId, sessionId: user.sessionId });

    const anonymous = await http(`${app.url}/whoami`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ userId: null, sessionId: null });
  });

  it("requireAuth answers 401 with the server's error shape", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    app = new MiniApp();
    app.get("/protected", orbit.requireAuth(), (req, res) => res.status(200).json({ userId: req.auth!.userId }));
    await app.listen();

    const missing = await http(`${app.url}/protected`);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] });
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(missing.headers.get("cache-control")).toBe("private, no-store");

    const ok = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: user.userId });
  });

  it("requireAuth accepts the __session cookie", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    app = new MiniApp();
    app.get("/protected", orbit.requireAuth(), (req, res) => res.status(200).json({ userId: req.auth!.userId }));
    await app.listen();

    const result = await http(`${app.url}/protected`, { headers: { cookie: `__session=${user.token}` } });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ userId: user.userId });
  });

  it("requireAuth treats an expired token as signed out, not as a server error", async () => {
    server = await startRealServer();
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, jwksCooldownMs: 0 });
    const { signJwt } = await import("../../server/src/services/tokens");
    const expired = await signJwt(server.context, { sub: "user_x", sid: "sess_x", nbf: Math.floor(Date.now() / 1000) - 120 }, { expiresInSeconds: -60, issuer: server.url });
    app = new MiniApp();
    app.get("/protected", orbit.requireAuth(), (req, res) => res.status(200).json({ userId: req.auth!.userId }));
    await app.listen();

    const result = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${expired}` } });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] });
  });

  it("requirePermission allows a granted permission and refuses a missing one with 403", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/members", orbit.requirePermission("org:sys_memberships:manage"), (req, res) => res.status(200).json({ ok: true, role: req.auth!.orgRole }));
    await app.listen();

    const allowed = await http(`${app.url}/members`, { headers: { authorization: `Bearer ${orgToken}` } });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ ok: true, role: "org:admin" });

    const denied = await http(`${app.url}/members`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      errors: [{ code: "org_permission_required", message: "You do not have permission to perform this action. Missing permission: org:sys_memberships:manage" }],
    });
  });

  it("requirePermission with an array requires every listed permission", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/two", orbit.requirePermission(["org:sys_memberships:manage", "org:billing:manage"]), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    // The admin has the first permission but not the second.
    const denied = await http(`${app.url}/two`, { headers: { authorization: `Bearer ${orgToken}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      errors: [{ code: "org_permission_required", message: "You do not have permission to perform this action. Missing permission: org:billing:manage" }],
    });
  });

  it("requirePermission honours a custom forbiddenMessage", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/members", orbit.requirePermission("org:sys_memberships:manage", { forbiddenMessage: "Admins only" }), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const denied = await http(`${app.url}/members`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ errors: [{ code: "org_permission_required", message: "Admins only" }] });
  });

  it("requirePermission answers 401 before 403 when signed out", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/members", orbit.requirePermission("org:sys_memberships:manage"), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/members`);
    expect(result.status).toBe(401);
  });

  it("requirePermission accepts a wildcard permission from claims", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const { signJwt } = await import("../../server/src/services/tokens");
    const wildcard = await signJwt(server.context, { sub: user.userId, sid: user.sessionId, org_permissions: ["org:billing:*"] }, { expiresInSeconds: 60, issuer: server.url });
    app = new MiniApp();
    app.get("/billing", orbit.requirePermission("org:billing:manage"), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/billing`, { headers: { authorization: `Bearer ${wildcard}` } });
    expect(result.status).toBe(200);
  });

  it("requireRole enforces the organization role", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/admin", orbit.requireRole("org:admin"), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    expect((await http(`${app.url}/admin`, { headers: { authorization: `Bearer ${orgToken}` } })).status).toBe(200);
    const denied = await http(`${app.url}/admin`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ errors: [{ code: "not_allowed_access", message: "This action requires a different role" }] });
  });

  it("answers 503 and reports the detail through onError when the JWKS is unreachable", async () => {
    const failures: unknown[] = [];
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "http://127.0.0.1:1", sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");

    app = new MiniApp();
    app.get("/protected", orbit.requireAuth({ onError: (error) => failures.push(error) }), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${header}.${payload}.sig` } });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ errors: [{ code: "authentication_unavailable", message: "Authentication is temporarily unavailable" }] });
    expect(result.text).not.toContain("127.0.0.1");
    expect(failures).toHaveLength(1);
  });

  it("treats an algorithm/key mismatch as signed out (401), not as an outage (503)", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url, jwksCooldownMs: 0 });
    const [header, payload, signature] = user.token.split(".");
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>;
    decoded.alg = "ES256";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${payload}.${signature}`;

    app = new MiniApp();
    app.get("/protected", orbit.requireAuth(), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${forged}` } });
    expect(result.status).toBe(401);
  });

  it("never leaks server internals in a 403 body", async () => {
    await boot(new MiniApp());
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });
    app = new MiniApp();
    app.get("/members", orbit.requirePermission("org:sys_domains:manage"), (_req, res) => res.status(200).json({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/members`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(result.status).toBe(403);
    expect(result.text).not.toContain(server!.secretKey);
    expect(result.text).not.toContain("sk_");
    expect(result.text).not.toContain(user.token);
  });
});

describe("getAuth", () => {
  it("returns the auth an adapter attached", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    let seen: string | null = null;
    app = new MiniApp();
    app.get("/me", orbit.requireAuth(), (req, res) => {
      seen = getAuth(req)?.userId ?? null;
      res.status(200).json({ ok: true });
    });
    await app.listen();

    await http(`${app.url}/me`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(seen).toBe(user.userId);
  });

  it("verifies on demand when given the SDK, for plain node:http handlers", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    app = new MiniApp();
    app.get("/raw", async (req, res) => {
      const auth = await getAuth(req, orbit);
      if (!auth) {
        res.status(401).json({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] });
        return;
      }
      res.status(200).json({ userId: auth.userId });
    });
    await app.listen();

    expect((await http(`${app.url}/raw`)).status).toBe(401);
    const ok = await http(`${app.url}/raw`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: user.userId });
  });
});
