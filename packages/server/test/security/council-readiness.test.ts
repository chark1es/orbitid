import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { loadEnv } from "../../src/env";
import * as s from "../../src/db/schema";
import { signSessionToken } from "../../src/services/tokens";
import { getMembershipContext } from "../../src/services/orgs";
import { organizationClaims } from "../../src/services/oidc/tokens";
import { api, backend, seedAuth, seedUser, setup } from "../orgs/helpers";

async function claims(ctx: Awaited<ReturnType<typeof setup>>["ctx"], app: Awaited<ReturnType<typeof setup>>["app"], id: string) {
  const jwks = await (await app.request("/.well-known/jwks.json")).json() as { keys: JWK[] };
  return (await jwtVerify(await signSessionToken(ctx, id), createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl })).payload;
}

describe("production review regressions", () => {
  it("stops minting organization grants when the feature is disabled, while keeping instance grants", async () => {
    const { ctx, app } = await setup();
    const user = await seedUser(ctx);
    const auth = await seedAuth(ctx, user.id);
    const created = await api<{ response: { id: string } }>(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Claims test" } });
    const orgId = created.body.response.id;
    await backend(app, "POST", "/v1/roles", { key: "app:reader", name: "Reader" });
    await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles: ["app:reader"] });
    const active = await seedAuth(ctx, user.id, { activeOrganizationId: orgId });
    expect((await claims(ctx, app, active.sessionId)).org_role).toBe("org:admin");
    await ctx.settings.update({ organizations: { enabled: false } });
    const token = await claims(ctx, app, active.sessionId);
    expect(token.org_id).toBeUndefined();
    expect(token.org_role).toBeUndefined();
    expect(token.org_permissions).toBeUndefined();
    expect(token.roles).toEqual(["app:reader"]);
    expect(await getMembershipContext(ctx, user.id, orgId)).toBeNull();
    expect(await organizationClaims(ctx, user.id, active.sessionId)).toEqual({ active: null, memberships: [] });
  });

  it("refuses every system-role permission mutation", async () => {
    const { ctx, app } = await setup();
    const role = (await ctx.db.select().from(s.roles).where(eq(s.roles.key, "org:admin")))[0]!;
    const before = await ctx.db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id));
    expect((await backend(app, "POST", `/v1/roles/${role.id}/permissions`, { permissions: [] })).status).toBe(403);
    expect((await backend(app, "DELETE", `/v1/roles/${role.id}/permissions/${before[0]!.permissionId}`)).status).toBe(403);
    expect(await ctx.db.select().from(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id))).toEqual(before);
  });

  it("valid backend traffic does not consume the failed-guess budget, and a blocked address must wait", async () => {
    const { ctx, app } = await setup();
    const request = (key: string) => app.request("/v1/users?limit=1", { headers: { authorization: `Bearer ${key}` } });
    for (let i = 0; i < 15; i++) expect((await request(ctx.env.secretKey)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await request("sk_test_wrong")).status).toBe(401);
    expect((await request(ctx.env.secretKey)).status).toBe(429);
    await ctx.db.update(s.rateLimits).set({ resetAt: Date.now() - 1 });
    expect((await request(ctx.env.secretKey)).status).toBe(200);
  });

  it("requires a strong explicitly supplied production key without changing generated defaults", () => {
    const env = { nodeEnv: "production", encryptionKey: "e".repeat(40), databaseUrl: ":memory:", baseUrl: "https://auth.example.com" };
    expect(() => loadEnv({ ...env, secretKey: "sk_live_weak" })).toThrow(/SECRET_KEY must be at least 32/);
    expect(() => loadEnv({ ...env, secretKey: "sk_live_" + "x".repeat(32) })).not.toThrow();
    expect(loadEnv({ ...env, secretKey: "" }).secretKey).toBe("");
  });
});
