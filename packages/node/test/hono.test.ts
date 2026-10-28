import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createOrbitId } from "../src/client";
import {
  honoMiddleware,
  honoRequireAuth,
  honoRequirePermission,
  honoRequireRole,
  type HonoContextLike,
  type OrbitIdHonoVariables,
} from "../src/adapters/hono";
import { startRealServer, createUserWithSession, createOrganization, tokenWithOrganization, type RealServer, type TestUser } from "./helpers/server";
import { http } from "./helpers/mini-app";

let server: RealServer | null = null;
let listening: Server | null = null;
let baseUrl = "";
let user: TestUser;
let orgToken: string;

/** Hono's `Context` is structurally compatible with the adapter's `HonoContextLike`. */
const adapt = (middleware: ReturnType<typeof honoRequireAuth>, app: Hono<{ Variables: OrbitIdHonoVariables }>) => {
  app.use("*", middleware as unknown as Parameters<typeof app.use>[1]);
};

async function serve(app: Hono<{ Variables: OrbitIdHonoVariables }>): Promise<void> {
  const httpServer = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  listening = httpServer;
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => listening?.close(() => resolve()) ?? resolve());
  listening = null;
  await server?.close();
  server = null;
});

describe("hono middleware (real Hono app on node:http)", () => {
  it("sets c.get('auth') and continues for both states", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    adapt(honoMiddleware(orbit), app);
    app.get("/whoami", (c) => c.json({ userId: c.get("auth")?.userId ?? null, sessionId: c.get("auth")?.sessionId ?? null }));
    await serve(app);

    const authed = await http(`${baseUrl}/whoami`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(authed.status).toBe(200);
    expect(authed.body).toEqual({ userId: user.userId, sessionId: user.sessionId });

    const anonymous = await http(`${baseUrl}/whoami`);
    expect(anonymous.body).toEqual({ userId: null, sessionId: null });
  });

  it("reads the __session cookie", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    adapt(honoMiddleware(orbit), app);
    app.get("/me", (c) => c.json({ userId: c.get("auth")?.userId ?? null }));
    await serve(app);

    const result = await http(`${baseUrl}/me`, { headers: { cookie: `__session=${user.token}` } });
    expect(result.body).toEqual({ userId: user.userId });
  });

  it("honoRequireAuth stops the chain with a 401 body and header", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    let reached = false;
    app.use("*", honoRequireAuth(orbit) as unknown as Parameters<typeof app.use>[1]);
    app.get("/protected", (c) => {
      reached = true;
      return c.json({ userId: c.get("auth")?.userId });
    });
    await serve(app);

    const missing = await http(`${baseUrl}/protected`);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] });
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(reached).toBe(false);

    const ok = await http(`${baseUrl}/protected`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: user.userId });
    expect(reached).toBe(true);
  });

  it("honoRequirePermission enforces organization permissions", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orgId = await createOrganization(server, user.userId, "Acme");
    orgToken = await tokenWithOrganization(server, user, orgId);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    app.use("*", honoRequirePermission(orbit, "org:sys_memberships:manage") as unknown as Parameters<typeof app.use>[1]);
    app.get("/members", (c) => c.json({ ok: true, role: c.get("auth")?.orgRole }));
    await serve(app);

    const allowed = await http(`${baseUrl}/members`, { headers: { authorization: `Bearer ${orgToken}` } });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ ok: true, role: "org:admin" });

    const denied = await http(`${baseUrl}/members`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      errors: [{ code: "org_permission_required", message: "You do not have permission to perform this action. Missing permission: org:sys_memberships:manage" }],
    });
  });

  it("honoRequireRole enforces the organization role", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orgId = await createOrganization(server, user.userId, "Acme");
    orgToken = await tokenWithOrganization(server, user, orgId);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    app.use("*", honoRequireRole(orbit, "org:admin") as unknown as Parameters<typeof app.use>[1]);
    app.get("/admin", (c) => c.json({ ok: true }));
    await serve(app);

    expect((await http(`${baseUrl}/admin`, { headers: { authorization: `Bearer ${orgToken}` } })).status).toBe(200);
    const denied = await http(`${baseUrl}/admin`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ errors: [{ code: "not_allowed_access", message: "This action requires a different role" }] });
  });

  it("answers 503 when verification cannot run", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "http://127.0.0.1:1", sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");

    const app = new Hono<{ Variables: OrbitIdHonoVariables }>();
    app.use("*", honoRequireAuth(orbit) as unknown as Parameters<typeof app.use>[1]);
    app.get("/protected", (c) => c.json({ ok: true }));
    await serve(app);

    const result = await http(`${baseUrl}/protected`, { headers: { authorization: `Bearer ${header}.${payload}.sig` } });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ errors: [{ code: "authentication_unavailable", message: "Authentication is temporarily unavailable" }] });
  });

  it("falls back to the headers Hono exposes when c.req.raw is absent", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });
    const headers: Record<string, string> = { authorization: `Bearer ${user.token}` };
    const context: HonoContextLike = {
      req: { header: (name: string) => headers[name.toLowerCase()] },
      set: () => undefined,
      json: (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    };
    let nextCalled = false;
    await honoMiddleware(orbit)(context, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
