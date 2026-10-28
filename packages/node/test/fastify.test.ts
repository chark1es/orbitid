import { afterEach, describe, expect, it } from "vitest";
import { createOrbitId } from "../src/client";
import {
  fastifyPlugin,
  fastifyRequireAuth,
  fastifyRequirePermission,
  fastifyRequireRole,
} from "../src/adapters/fastify";
import { startRealServer, createUserWithSession, createOrganization, tokenWithOrganization, type RealServer, type TestUser } from "./helpers/server";
import { FastifyHttpServer, http } from "./helpers/fastify-host";

let server: RealServer | null = null;
let app: FastifyHttpServer | null = null;
let user: TestUser;
let orgToken: string;

async function bootOrganization(): Promise<void> {
  server = await startRealServer();
  user = await createUserWithSession(server);
  const orgId = await createOrganization(server, user.userId, "Acme");
  orgToken = await tokenWithOrganization(server, user, orgId);
}

afterEach(async () => {
  await app?.close();
  app = null;
  await server?.close();
  server = null;
});

describe("fastify plugin (real node:http host)", () => {
  it("decorates request.auth and fills it from the session", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    app = new FastifyHttpServer();
    await new Promise<void>((resolve) => orbit.fastifyPlugin()(app!.instance, {}, () => resolve()));
    app.route("/whoami", [], (request, reply) => {
      reply.code(200).send({ userId: request.auth?.userId ?? null, sessionId: request.auth?.sessionId ?? null });
    });
    await app.listen();

    const authed = await http(`${app.url}/whoami`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(authed.status).toBe(200);
    expect(authed.body).toEqual({ userId: user.userId, sessionId: user.sessionId });

    const anonymous = await http(`${app.url}/whoami`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ userId: null, sessionId: null });
  });

  it("requireAuth answers 401 with the shared error shape and headers", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    app = new FastifyHttpServer();
    await new Promise<void>((resolve) => fastifyPlugin(orbit)(app!.instance, {}, () => resolve()));
    app.route("/protected", [fastifyRequireAuth(orbit)], (request, reply) => {
      reply.code(200).send({ userId: request.auth?.userId });
    });
    await app.listen();

    const missing = await http(`${app.url}/protected`);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ errors: [{ code: "authentication_invalid", message: "Authentication required" }] });
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const ok = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: user.userId });
  });

  it("requirePermission enforces organization permissions", async () => {
    await bootOrganization();
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });

    app = new FastifyHttpServer();
    await new Promise<void>((resolve) => orbit.fastifyPlugin()(app!.instance, {}, () => resolve()));
    app.route("/members", [fastifyRequirePermission(orbit, "org:sys_memberships:manage")], (_request, reply) => {
      reply.code(200).send({ ok: true });
    });
    await app.listen();

    expect((await http(`${app.url}/members`, { headers: { authorization: `Bearer ${orgToken}` } })).status).toBe(200);

    const denied = await http(`${app.url}/members`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({
      errors: [{ code: "org_permission_required", message: "You do not have permission to perform this action. Missing permission: org:sys_memberships:manage" }],
    });
  });

  it("requireRole enforces the organization role", async () => {
    await bootOrganization();
    const orbit = createOrbitId({ secretKey: server!.secretKey, apiUrl: server!.url });

    app = new FastifyHttpServer();
    await new Promise<void>((resolve) => fastifyPlugin(orbit)(app!.instance, {}, () => resolve()));
    app.route("/admin", [fastifyRequireRole(orbit, "org:admin")], (_request, reply) => reply.code(200).send({ ok: true }));
    await app.listen();

    expect((await http(`${app.url}/admin`, { headers: { authorization: `Bearer ${orgToken}` } })).status).toBe(200);
    const denied = await http(`${app.url}/admin`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ errors: [{ code: "not_allowed_access", message: "This action requires a different role" }] });
  });

  it("route hooks work without registering the plugin", async () => {
    server = await startRealServer();
    user = await createUserWithSession(server);
    const orbit = createOrbitId({ secretKey: server.secretKey, apiUrl: server.url });

    app = new FastifyHttpServer();
    app.route("/route-only", [fastifyRequireAuth(orbit)], (request, reply) => reply.code(200).send({ userId: request.auth?.userId }));
    await app.listen();

    const ok = await http(`${app.url}/route-only`, { headers: { authorization: `Bearer ${user.token}` } });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: user.userId });
    expect((await http(`${app.url}/route-only`)).status).toBe(401);
  });

  it("answers 503 when verification cannot run and keeps the detail out of the body", async () => {
    const orbit = createOrbitId({ secretKey: "sk_test_abc12345", apiUrl: "http://127.0.0.1:1", retries: 0, timeoutMs: 300 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "http://127.0.0.1:1", sub: "u", sid: "s", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");

    app = new FastifyHttpServer();
    app.route("/protected", [fastifyRequireAuth(orbit)], (_request, reply) => reply.code(200).send({ ok: true }));
    await app.listen();

    const result = await http(`${app.url}/protected`, { headers: { authorization: `Bearer ${header}.${payload}.sig` } });
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ errors: [{ code: "authentication_unavailable", message: "Authentication is temporarily unavailable" }] });
  });
});
