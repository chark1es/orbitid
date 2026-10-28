import { describe, it, expect, beforeEach, vi } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { setup, authHeaders } from "./helpers";
import { TEST_PUBLIC_JWK } from "./fake-tokens";

vi.mock("../../src/services/tokens", () => import("./fake-tokens"));

type Harness = Awaited<ReturnType<typeof setup>>;
const json = (body: unknown) => JSON.stringify(body);

async function createMachine(h: Harness, name = "worker-1", extra: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/m2m/machines", { method: "POST", headers: authHeaders(), body: json({ name, ...extra }) });
  expect(res.status).toBe(201);
  return res.json();
}

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

describe("m2m — machines", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("creates a machine with a one-time mk_ secret and lists it", async () => {
    const machine = await createMachine(h, "ci");
    expect(machine.object).toBe("machine");
    expect(machine.id).toMatch(/^mch_/);
    expect(machine.secret).toMatch(/^mk_[A-Za-z0-9_-]{32}$/);
    expect(machine.default_token_ttl).toBe(3600);
    expect(machine.scoped_machines).toEqual([]);

    const row = h.ctx.db.select().from(s.machines).where(eq(s.machines.id, machine.id)).get()!;
    expect(row.secretHash).not.toBe(machine.secret);

    const list = await h.app.request("/v1/m2m/machines", { headers: authHeaders() });
    const body = await list.json();
    expect(body.total_count).toBe(1);
    expect(body.data[0].secret).toBeUndefined();

    const patched = await h.app.request(`/v1/m2m/machines/${machine.id}`, { method: "PATCH", headers: authHeaders(), body: json({ name: "ci-renamed", default_token_ttl: 60 }) });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: "ci-renamed", default_token_ttl: 60 });
  });

  it("rotates the secret so the old one stops working", async () => {
    const machine = await createMachine(h);
    const rotated = await h.app.request(`/v1/m2m/machines/${machine.id}/secret/rotate`, { method: "POST", headers: authHeaders() });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json();
    expect(rotatedBody.secret).toMatch(/^mk_/);
    expect(rotatedBody.secret).not.toBe(machine.secret);

    const oldSecret = await h.app.request("/oauth/m2m/token", {
      method: "POST", headers: { authorization: basic(machine.id, machine.secret), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    expect(oldSecret.status).toBe(401);
    expect((await oldSecret.json()).error).toBe("invalid_client");

    const newSecret = await h.app.request("/oauth/m2m/token", {
      method: "POST", headers: { authorization: basic(machine.id, rotatedBody.secret), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    expect(newSecret.status).toBe(200);
    expect((await newSecret.json()).access_token).toMatch(/^mt_/);
  });

  it("adds scope links to other machines", async () => {
    const a = await createMachine(h, "a");
    const b = await createMachine(h, "b");
    const linked = await h.app.request(`/v1/m2m/machines/${a.id}/scopes`, { method: "POST", headers: authHeaders(), body: json({ scoped_machine_id: b.id }) });
    expect(linked.status).toBe(200);
    expect((await linked.json()).scoped_machines).toEqual([b.id]);
    const again = await h.app.request(`/v1/m2m/machines/${a.id}/scopes`, { method: "POST", headers: authHeaders(), body: json({ machine_id: b.id }) });
    expect((await again.json()).scoped_machines).toEqual([b.id]);
    const self = await h.app.request(`/v1/m2m/machines/${a.id}/scopes`, { method: "POST", headers: authHeaders(), body: json({ scoped_machine_id: a.id }) });
    expect(self.status).toBe(422);
  });
});

describe("m2m — tokens", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("issues opaque mt_ tokens with the secret key + machine_id, verifies and revokes them", async () => {
    const machine = await createMachine(h);
    const created = await h.app.request("/v1/m2m/tokens", {
      method: "POST", headers: authHeaders(), body: json({ machine_id: machine.id, seconds_until_expiration: 600, claims: { run: "42" } }),
    });
    expect(created.status).toBe(201);
    const token = await created.json();
    expect(token.token).toMatch(/^mt_[A-Za-z0-9_-]{32}$/);
    expect(token.machine_id).toBe(machine.id);
    expect(token.claims).toMatchObject({ run: "42", sub: machine.id });

    const stored = h.ctx.db.select().from(s.m2mTokens).where(eq(s.m2mTokens.id, token.id)).get()!;
    expect(stored.tokenHash).not.toBe(token.token);

    const verified = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(verified.status).toBe(200);
    const verifiedBody = await verified.json();
    expect(verifiedBody.valid).toBe(true);
    expect(verifiedBody.machine_id).toBe(machine.id);

    const listed = await h.app.request(`/v1/m2m/tokens?machine_id=${machine.id}`, { headers: authHeaders() });
    expect((await listed.json()).total_count).toBe(1);

    const revoked = await h.app.request(`/v1/m2m/tokens/${token.id}/revoke`, { method: "POST", headers: authHeaders() });
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).revoked).toBe(true);
    const after = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(after.status).toBe(401);
    expect((await after.json()).errors[0].code).toBe("authorization_invalid");
  });

  it("issues RS256 JWTs (sub = machine id, scopes) verifiable with the instance JWKS", async () => {
    const other = await createMachine(h, "target");
    const machine = await createMachine(h, "issuer", { scoped_machines: [other.id] });
    const created = await h.app.request("/v1/m2m/tokens", {
      method: "POST", headers: authHeaders(), body: json({ machine_id: machine.id, token_format: "jwt", seconds_until_expiration: 300 }),
    });
    expect(created.status).toBe(201);
    const token = await created.json();
    expect(token.token.split(".")).toHaveLength(3);

    const header = decodeProtectedHeader(token.token);
    expect(header.alg).toBe("RS256");
    const { payload } = await jwtVerify(token.token, TEST_PUBLIC_JWK);
    expect(payload.sub).toBe(machine.id);
    expect(payload.scopes).toEqual([other.id]);
    expect(payload.iss).toBe(h.baseUrl);

    const verified = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(verified.status).toBe(200);
    expect((await verified.json()).machine_id).toBe(machine.id);

    // A JWT is revocable because the token record is keyed by its hash.
    await h.app.request(`/v1/m2m/tokens/${token.id}/revoke`, { method: "POST", headers: authHeaders() });
    const after = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(after.status).toBe(401);
  });

  it("rejects expired tokens and garbage", async () => {
    const machine = await createMachine(h);
    const created = await h.app.request("/v1/m2m/tokens", { method: "POST", headers: authHeaders(), body: json({ machine_id: machine.id }) });
    const token = await created.json();
    h.ctx.db.update(s.m2mTokens).set({ expiresAt: Date.now() - 1 }).where(eq(s.m2mTokens.id, token.id)).run();

    const expired = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(expired.status).toBe(401);
    const garbage = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: "mt_nope" }) });
    expect(garbage.status).toBe(401);
  });

  it("mints tokens from a machine secret at /oauth/m2m/token (Basic auth) and in the body", async () => {
    const other = await createMachine(h, "other");
    const machine = await createMachine(h, "machine", { scoped_machines: [other.id] });
    const res = await h.app.request("/oauth/m2m/token", {
      method: "POST",
      headers: { authorization: basic(machine.id, machine.secret), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", token_format: "opaque", seconds_until_expiration: "120" }).toString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^mt_/);
    expect(body.token_type).toBe("Bearer");
    expect(body.token_format).toBe("opaque");
    expect(body.scope).toBe(other.id);
    expect(body.expires_in).toBeGreaterThan(100);

    const viaBody = await h.app.request("/oauth/m2m/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: json({ machine_id: machine.id, machine_secret: machine.secret, token_format: "jwt" }),
    });
    expect(viaBody.status).toBe(200);
    expect((await viaBody.json()).access_token.split(".")).toHaveLength(3);

    const wrongSecret = await h.app.request("/oauth/m2m/token", {
      method: "POST", headers: { authorization: basic(machine.id, "mk_wrong"), "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).error).toBe("invalid_client");

    const wrongGrant = await h.app.request("/oauth/m2m/token", {
      method: "POST", headers: { authorization: basic(machine.id, machine.secret), "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=password",
    });
    expect(wrongGrant.status).toBe(400);
    expect((await wrongGrant.json()).error).toBe("unsupported_grant_type");
  });

  it("requires the secret key for /v1/m2m and deletes machines with their tokens", async () => {
    const machine = await createMachine(h);
    const unauthenticated = await h.app.request("/v1/m2m/machines");
    expect(unauthenticated.status).toBe(401);

    const token = await (await h.app.request("/v1/m2m/tokens", { method: "POST", headers: authHeaders(), body: json({ machine_id: machine.id }) })).json();
    const deleted = await h.app.request(`/v1/m2m/machines/${machine.id}`, { method: "DELETE", headers: authHeaders() });
    expect(deleted.status).toBe(200);
    expect(h.ctx.db.select().from(s.m2mTokens).where(eq(s.m2mTokens.id, token.id)).get()).toBeUndefined();

    const verify = await h.app.request("/v1/m2m/tokens/verify", { method: "POST", headers: authHeaders(), body: json({ token: token.token }) });
    expect(verify.status).toBe(401);
  });
});
