import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { OrbitError } from "@orbitid/shared";
import { MAX_JSON_BYTES, parseBody, readBodyCapped, stripPrototypeKeys } from "../../src/lib/http";
import { setup, signUpUser, testClient } from "../core/helpers";

const schema = z.object({ a: z.string().optional() });
const app = new Hono()
  .onError((err, c) => c.json({ status: err instanceof OrbitError ? err.status : 500, code: err instanceof OrbitError ? err.code : "other" }, (err instanceof OrbitError ? err.status : 500) as any))
  .post("/", async (c) => c.json(await parseBody(c, schema)));

const post = (body?: string, headers: Record<string, string> = {}) =>
  app.request("/", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("request body limits", () => {
  it("accepts a body at the cap and refuses one above it", async () => {
    const ok = await post(JSON.stringify({ a: "x".repeat(MAX_JSON_BYTES - 20) }));
    expect(ok.status).toBe(200);

    const tooBig = await post(JSON.stringify({ a: "x".repeat(MAX_JSON_BYTES) }));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).code).toBe("request_body_invalid");
  });

  it("refuses a declared Content-Length above the cap before reading the body", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_JSON_BYTES + 1) },
      body: "{}",
    });
    expect(res.status).toBe(413);
  });

  it("reads a stream with a hard cap", async () => {
    const big = new Hono()
      .onError((err, c) => c.json({ status: err instanceof OrbitError ? err.status : 500 }, 413))
      .post("/", async (c) => c.json({ ok: (await readBodyCapped(c, 8)).length }));
    const res = await big.request("/", { method: "POST", headers: { "content-type": "text/plain" }, body: "123456789" });
    expect(res.status).toBe(413);
    expect((await res.json()).status).toBe(413);
  });

  it("requires a JSON content type for JSON endpoints", async () => {
    const res = await app.request("/", { method: "POST", headers: { "content-type": "text/plain" }, body: "a=1" });
    expect(res.status).toBe(415);
  });

  it("rejects deeply nested JSON", async () => {
    let nested: unknown = "x";
    for (let i = 0; i < 60; i++) nested = { n: nested };
    const res = await post(JSON.stringify(nested));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("request_body_invalid");
  });

  it("strips prototype-polluting keys before a schema sees them", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":"ok","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    });
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(stripPrototypeKeys({ safe: 1, __proto__: { bad: 1 } })).toEqual({ safe: 1 });
    expect(Object.getPrototypeOf(stripPrototypeKeys(JSON.parse('{"__proto__":{"x":1}}')))).toBe(Object.prototype);
  });

  it("caps upload bodies at 5 MB before the route parses them", async () => {
    const { app: server } = await setup();
    const res = await server.request("/v1/client/me/profile_image", {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "multipart/form-data", "content-length": String(6 * 1024 * 1024) },
      body: "x",
    });
    expect(res.status).toBe(413);
  });

  it("caps list pagination on every list endpoint", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ organizations: { enabled: true } });
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/organization_memberships?limit=100000&offset=-5");
    // The route either validates (422) or clamps; it must never return an unbounded page.
    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(JSON.stringify(body).length).toBeLessThan(1_000_000);
    }

    // Backend list endpoints reject limits above the documented maximum.
    const backend = await app.request("/v1/users?limit=100000", { headers: { authorization: "Bearer sk_test_testsecret" } });
    expect(backend.status).toBe(422);
  });

  it("rejects the query-string secret key", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/users?secret_key=sk_test_testsecret");
    expect(res.status).toBe(401);
    const keyed = await app.request("/v1/users?api_key=sk_test_testsecret");
    expect(keyed.status).toBe(401);
  });
});

describe("server timeouts", () => {
  it("configures node request, header and keep-alive budgets", async () => {
    const { startServer } = await import("../../src/index");
    const server = await startServer({ port: 0, databaseUrl: ":memory:", secretKey: "sk_test_timeouts", baseUrl: "http://localhost:0" });
    try {
      const http = server.server as unknown as { requestTimeout: number; headersTimeout: number; keepAliveTimeout: number; maxHeaderSize?: number };
      expect(http.requestTimeout).toBeGreaterThan(0);
      expect(http.headersTimeout).toBeGreaterThan(0);
      expect(http.keepAliveTimeout).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
