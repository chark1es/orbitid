import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { setup, authHeaders, insertUser, insertClientSession, insertOrganization, addMembership, grantPermissions } from "./helpers";

const emitEvent = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("../../src/services/webhooks", () => ({ emitEvent, startWebhookWorker: () => () => {} }));

type Harness = Awaited<ReturnType<typeof setup>>;

const json = (body: unknown) => JSON.stringify(body);

describe("api keys — backend API", () => {
  let h: Harness;
  let user: ReturnType<typeof insertUser>;
  beforeEach(async () => {
    h = await setup();
    user = insertUser(h.ctx);
    emitEvent.mockClear();
  });

  it("creates a key, shows the secret once, stores only its hash and prefix", async () => {
    const res = await h.app.request("/v1/api_keys", {
      method: "POST",
      headers: authHeaders(),
      body: json({ name: "CI deploy", subject: user.userId, scopes: ["read", "write"], claims: { env: "prod" }, seconds_until_expiration: 3600, description: "deploy bot" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("api_key");
    expect(body.id).toMatch(/^ak_/);
    expect(body.secret).toMatch(/^ak_live_[A-Za-z0-9_-]{32}$/);
    expect(body.prefix).toBe(body.secret.slice(0, 12));
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.claims).toEqual({ env: "prod" });
    expect(body.subject).toBe(user.userId);
    expect(body.expiration).toBeGreaterThan(Date.now());

    const row = h.ctx.db.select().from(s.apiKeys).where(eq(s.apiKeys.id, body.id)).get()!;
    expect(row.secretHash).not.toBe(body.secret);
    expect(row.secretHash).toMatch(/^[a-f0-9]{64}$/);

    const get = await h.app.request(`/v1/api_keys/${body.id}`, { headers: authHeaders() });
    expect(get.status).toBe(200);
    expect((await get.json()).secret).toBeUndefined();
    expect(emitEvent).toHaveBeenCalledWith(h.ctx, "apiKey.created", expect.objectContaining({ id: body.id }));
  });

  it("verifies a secret, records last_used_at and rejects unknown secrets", async () => {
    const created = await h.app.request("/v1/api_keys", {
      method: "POST", headers: authHeaders(), body: json({ name: "k", subject: user.userId }),
    });
    const key = await created.json();
    const ok = await h.app.request("/v1/api_keys/verify", { method: "POST", headers: authHeaders(), body: json({ secret: key.secret }) });
    expect(ok.status).toBe(200);
    const verified = await ok.json();
    expect(verified.id).toBe(key.id);
    expect(verified.last_used_at).toBeGreaterThan(0);

    const bad = await h.app.request("/v1/api_keys/verify", { method: "POST", headers: authHeaders(), body: json({ secret: "ak_live_not-a-real-key" }) });
    expect(bad.status).toBe(401);
    expect((await bad.json()).errors[0].code).toBe("api_key_invalid");
  });

  it("rejects expired and revoked keys, and filters them from lists unless include_invalid", async () => {
    const created = await h.app.request("/v1/api_keys", { method: "POST", headers: authHeaders(), body: json({ name: "short", subject: user.userId }) });
    const key = await created.json();
    h.ctx.db.update(s.apiKeys).set({ expiresAt: Date.now() - 1000 }).where(eq(s.apiKeys.id, key.id)).run();

    const expired = await h.app.request("/v1/api_keys/verify", { method: "POST", headers: authHeaders(), body: json({ secret: key.secret }) });
    expect(expired.status).toBe(401);

    const list = await h.app.request(`/v1/api_keys?subject=${user.userId}`, { headers: authHeaders() });
    expect((await list.json()).data).toHaveLength(0);
    const all = await h.app.request(`/v1/api_keys?subject=${user.userId}&include_invalid=true`, { headers: authHeaders() });
    const allBody = await all.json();
    expect(allBody.data).toHaveLength(1);
    expect(allBody.total_count).toBe(1);

    const second = await h.app.request("/v1/api_keys", { method: "POST", headers: authHeaders(), body: json({ name: "revocable", subject: user.userId }) });
    const secondKey = await second.json();
    const revoked = await h.app.request(`/v1/api_keys/${secondKey.id}/revoke`, { method: "POST", headers: authHeaders(), body: json({ revocation_reason: "leaked" }) });
    expect(revoked.status).toBe(200);
    const revokedBody = await revoked.json();
    expect(revokedBody.revoked).toBe(true);
    expect(h.ctx.db.select().from(s.apiKeys).where(eq(s.apiKeys.id, secondKey.id)).get()!.revocationReason).toBe("leaked");
    expect(emitEvent).toHaveBeenCalledWith(h.ctx, "apiKey.revoked", expect.objectContaining({ id: secondKey.id, revoked: true }));

    const afterRevoke = await h.app.request("/v1/api_keys/verify", { method: "POST", headers: authHeaders(), body: json({ secret: secondKey.secret }) });
    expect(afterRevoke.status).toBe(401);
  });

  it("updates metadata and deletes keys", async () => {
    const created = await h.app.request("/v1/api_keys", { method: "POST", headers: authHeaders(), body: json({ name: "old", subject: user.userId }) });
    const key = await created.json();
    const patched = await h.app.request(`/v1/api_keys/${key.id}`, { method: "PATCH", headers: authHeaders(), body: json({ name: "renamed", scopes: ["read"] }) });
    expect(patched.status).toBe(200);
    expect((await patched.json()).name).toBe("renamed");

    const deleted = await h.app.request(`/v1/api_keys/${key.id}`, { method: "DELETE", headers: authHeaders() });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ object: "api_key", id: key.id, deleted: true });
    const gone = await h.app.request(`/v1/api_keys/${key.id}`, { headers: authHeaders() });
    expect(gone.status).toBe(404);
  });

  it("validates the subject and requires the secret key", async () => {
    const bad = await h.app.request("/v1/api_keys", { method: "POST", headers: authHeaders(), body: json({ name: "x", subject: "wat_123" }) });
    expect(bad.status).toBe(422);
    const missing = await h.app.request("/v1/api_keys", { method: "POST", headers: authHeaders(), body: json({ name: "x", subject: "user_does_not_exist" }) });
    expect(missing.status).toBe(422);
    const unauth = await h.app.request("/v1/api_keys?subject=x", { headers: { "content-type": "application/json" } });
    expect(unauth.status).toBe(401);
  });
});

describe("api keys — Frontend API self-service", () => {
  let h: Harness;
  let user: ReturnType<typeof insertUser>;
  let session: ReturnType<typeof insertClientSession>;
  beforeEach(async () => {
    h = await setup();
    user = insertUser(h.ctx);
    session = insertClientSession(h.ctx, user.userId);
  });

  const fapi = (path: string, init: RequestInit = {}) => h.app.request(`/v1/client${path}`, {
    ...init,
    headers: { cookie: session.cookie, "content-type": "application/json", ...(init.headers ?? {}) },
  });

  it("creates and lists the signed-in user's keys", async () => {
    const created = await fapi("/me/api_keys", { method: "POST", body: json({ name: "Personal", seconds_until_expiration: 60 }) });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.response.subject).toBe(user.userId);
    expect(body.response.created_by).toBe(user.userId);
    expect(body.response.secret).toMatch(/^ak_live_/);

    const list = await fapi("/me/api_keys");
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.response).toHaveLength(1);
    expect(listed.response[0].secret).toBeUndefined();

    const renamed = await fapi(`/me/api_keys/${body.response.id}`, { method: "PATCH", body: json({ name: "Renamed" }) });
    expect((await renamed.json()).response.name).toBe("Renamed");

    const revoked = await fapi(`/me/api_keys/${body.response.id}/revoke`, { method: "POST", body: json({}) });
    expect((await revoked.json()).response.revoked).toBe(true);

    const deleted = await fapi(`/me/api_keys/${body.response.id}`, { method: "DELETE" });
    expect((await deleted.json()).response.deleted).toBe(true);
  });

  it("does not expose another user's key", async () => {
    const other = insertUser(h.ctx, { email: "other@example.com" });
    const otherSession = insertClientSession(h.ctx, other.userId);
    const created = await h.app.request("/v1/client/me/api_keys", {
      method: "POST", headers: { cookie: otherSession.cookie, "content-type": "application/json" }, body: json({ name: "theirs" }),
    });
    const key = (await created.json()).response;
    const attempt = await fapi(`/me/api_keys/${key.id}`);
    expect(attempt.status).toBe(404);
    const attemptRevoke = await fapi(`/me/api_keys/${key.id}/revoke`, { method: "POST", body: json({}) });
    expect(attemptRevoke.status).toBe(404);
  });

  it("requires a session", async () => {
    const res = await h.app.request("/v1/client/me/api_keys");
    expect(res.status).toBe(401);
  });

  it("gates organization keys on membership and the API-key permission", async () => {
    const org = insertOrganization(h.ctx);
    const outsider = await fapi(`/organizations/${org.orgId}/api_keys`);
    expect(outsider.status).toBe(403);
    expect((await outsider.json()).errors[0].code).toBe("not_a_member_in_organization");

    addMembership(h.ctx, org.orgId, user.userId, "org:member");
    const plainMember = await fapi(`/organizations/${org.orgId}/api_keys`);
    expect(plainMember.status).toBe(403);
    expect((await plainMember.json()).errors[0].code).toBe("org_permission_required");

    grantPermissions(h.ctx, "org:auditor", []);
    const auditorUser = insertUser(h.ctx, { email: "auditor@example.com" });
    const auditorSession = insertClientSession(h.ctx, auditorUser.userId);
    addMembership(h.ctx, org.orgId, auditorUser.userId, "org:auditor");
    const auditor = await h.app.request(`/v1/client/organizations/${org.orgId}/api_keys`, { headers: { cookie: auditorSession.cookie } });
    expect(auditor.status).toBe(403);
  });

  it.each([
    ["org:sys_profile:manage"],
    ["org:sys_api_keys:manage"],
  ])("allows a custom role holding %s to manage org keys", async (permission) => {
    const org = insertOrganization(h.ctx);
    const roleKey = `org:keymanager:${permission.split(":").pop()}`;
    grantPermissions(h.ctx, roleKey, [permission]);
    const manager = insertUser(h.ctx, { email: `manager-${permission.split(":").pop()}@example.com` });
    const managerSession = insertClientSession(h.ctx, manager.userId);
    addMembership(h.ctx, org.orgId, manager.userId, roleKey);
    const cookie = { cookie: managerSession.cookie, "content-type": "application/json" };

    const created = await h.app.request(`/v1/client/organizations/${org.orgId}/api_keys`, { method: "POST", headers: cookie, body: json({ name: "Org key" }) });
    expect(created.status).toBe(201);
    const key = (await created.json()).response;
    expect(key.subject).toBe(org.orgId);
    expect(key.created_by).toBe(manager.userId);

    const list = await h.app.request(`/v1/client/organizations/${org.orgId}/api_keys`, { headers: cookie });
    expect((await list.json()).response).toHaveLength(1);
  });

  it("allows org:admin members", async () => {
    const org = insertOrganization(h.ctx);
    addMembership(h.ctx, org.orgId, user.userId, "org:admin");
    const created = await fapi(`/organizations/${org.orgId}/api_keys`, { method: "POST", body: json({ name: "Admin key" }) });
    expect(created.status).toBe(201);
  });
});
