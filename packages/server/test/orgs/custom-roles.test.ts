import { describe, it, expect, vi } from "vitest";
import type { RecordedEmail } from "./mocks";

vi.mock("../../src/services/mail", async () => {
  const { mailOutbox } = await import("./mocks");
  return {
    sendEmail: async (_ctx: unknown, input: RecordedEmail) => { mailOutbox.push(input); },
    sendSms: async () => {},
  };
});
vi.mock("../../src/services/webhooks", async () => {
  const { events } = await import("./mocks");
  return {
    emitEvent: async (_ctx: unknown, type: string, data: unknown) => { events.push({ type, data }); },
    startWebhookWorker: () => () => {},
  };
});

import type { PermissionJSON, RoleJSON, UserJSON } from "@orbitid/shared";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { signSessionToken } from "../../src/services/tokens";
import { seedRbac } from "../../src/services/orgs";
import { roleScope } from "../../src/services/rbac";
import { api, backend, errorCode, seedAuth, seedUser, setup } from "./helpers";

/** Signs a session JWT through the real path, so the claims come from the database rather than a fixture. */
async function sessionClaims(app: Parameters<typeof api>[0], ctx: Parameters<typeof seedUser>[0], sessionId: string) {
  const jwt = await signSessionToken(ctx, sessionId);
  const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
  const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
  return payload;
}

describe("custom roles", () => {
  it("separates organization and instance scope by key", async () => {
    expect(roleScope("org:support")).toBe("organization");
    expect(roleScope("org:sys_memberships:read")).toBe("organization");
    expect(roleScope("app:support")).toBe("instance");
    expect(roleScope("app:sys_read")).toBe("instance");
  });

  it("creates an organization role and an instance role, and reports each scope", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const orgRole = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:billing", name: "Billing" });
    expect(orgRole.status).toBe(200);
    expect(orgRole.body.scope).toBe("organization");
    expect(orgRole.body.is_system).toBe(false);

    const instanceRole = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    expect(instanceRole.status).toBe(200);
    expect(instanceRole.body.scope).toBe("instance");

    const listed = await backend<{ data: RoleJSON[] }>(app, "GET", "/v1/roles?limit=100");
    expect(listed.body.data.map((r) => [r.key, r.scope])).toEqual(expect.arrayContaining([["org:billing", "organization"], ["app:support", "instance"]]));
  });

  it("manages instance roles while organizations are disabled", async () => {
    // Instance roles are independent of the organizations feature: an instance with no organizations still needs
    // `app:` roles, so the role endpoints (and the per-user assignment) must work with organizations off.
    const { ctx, app } = await setup({ organizations: { enabled: false } });
    await seedRbac(ctx);
    const user = await seedUser(ctx, { email: "solo@acme.test" });
    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    expect(role.status).toBe(200);
    expect(role.body.scope).toBe("instance");
    const listed = await backend<{ data: RoleJSON[] }>(app, "GET", "/v1/roles?query=app:");
    expect(listed.body.data.map((r) => r.key)).toContain("app:support");
    const assigned = await backend<{ roles: string[] }>(app, "PUT", `/v1/users/${user.id}/roles`, { roles: ["app:support"] });
    expect(assigned.status).toBe(200);
    expect(assigned.body.roles).toEqual(["app:support"]);
  });

  it("accepts the key shapes the dashboard's validator produces, including hyphens", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    // `org:team-lead` is what `roleKeyError` accepts in the dashboard; the server must not be stricter.
    for (const key of ["org:team-lead", "app:support-2", "org:support_2", "org:billing", "app:a1"]) {
      const res = await backend<RoleJSON>(app, "POST", "/v1/roles", { key, name: key });
      expect(res.status, key).toBe(200);
      expect(res.body.key).toBe(key);
    }
    // Multi-segment keys are still allowed where the server has always allowed them.
    expect((await backend(app, "POST", "/v1/roles", { key: "org:billing:read", name: "Billing reader" })).status).toBe(200);
    expect((await backend(app, "POST", "/v1/permissions", { key: "org:team-lead:view", name: "View team" })).status).toBe(200);
  });

  it("refuses an instance role as creator eligible", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const res = await backend(app, "POST", "/v1/roles", { key: "app:support", name: "Support", is_creator_eligible: true });
    expect(res.status).toBe(422);
    expect(errorCode(res.body)).toBe("form_param_value_invalid");
    // Nothing was created.
    const rows = (await ctx.db.select().from(s.roles).where(eq(s.roles.key, "app:support")));
    expect(rows).toHaveLength(0);

    const orgRole = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:owner", name: "Owner", is_creator_eligible: true });
    expect(orgRole.status).toBe(200);
    expect((await backend(app, "PATCH", `/v1/roles/${orgRole.body.id}`, { is_creator_eligible: true })).status).toBe(200);
  });

  it("rejects scope mixing before writing anything", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const instancePermission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "app:reports:read", name: "Read reports" });
    expect(instancePermission.status).toBe(200);
    const orgPermission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "org:notes:read", name: "Read notes" });
    expect(orgPermission.status).toBe(200);

    // A create whose permissions do not belong to the role's namespace must not leave a role row behind.
    const mixedCreate = await backend(app, "POST", "/v1/roles", { key: "org:billing", name: "Billing", permissions: ["app:reports:read"] });
    expect(mixedCreate.status).toBe(422);
    expect(await ctx.db.select().from(s.roles).where(eq(s.roles.key, "org:billing"))).toHaveLength(0);

    // A patch that mixes scopes leaves the previous name and permissions untouched.
    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:viewer", name: "Viewer", permissions: ["org:notes:read"] });
    expect(role.status).toBe(200);
    const mixedPatch = await backend(app, "PATCH", `/v1/roles/${role.body.id}`, { name: "Renamed", permissions: ["app:reports:read"] });
    expect(mixedPatch.status).toBe(422);
    const after = (await backend<RoleJSON>(app, "GET", `/v1/roles/${role.body.id}`)).body;
    expect(after.name).toBe("Viewer");
    expect(after.permissions.map((p) => p.key)).toEqual(["org:notes:read"]);
  });

  it("refuses to mix scopes between a role and its permissions", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const instancePermission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "app:reports:read", name: "Read reports" });
    expect(instancePermission.body.scope).toBe("instance");

    const orgRole = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:billing", name: "Billing" });
    const mixed = await backend(app, "POST", `/v1/roles/${orgRole.body.id}/permissions`, { permissions: ["app:reports:read"] });
    expect(mixed.status).toBe(422);
    expect(errorCode(mixed.body)).toBe("form_param_value_invalid");

    const good = await backend<RoleJSON>(app, "POST", `/v1/roles/${orgRole.body.id}/permissions`, { permissions: ["org:sys_memberships:read"] });
    expect(good.body.permissions.map((p) => p.key)).toEqual(["org:sys_memberships:read"]);
  });

  it("refuses reserved keys, system keys and a scope-less key", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    for (const key of ["support", "org:sys_x", "app:sys_x", "org:", "APP:BAD", "org:space name", "org:Support", "org:x::y", "org:-leading"]) {
      expect((await backend(app, "POST", "/v1/roles", { key, name: "X" })).status, key).toBe(422);
    }
    // System roles cannot be edited or deleted, and they cannot be assigned as instance roles.
    const roles = await backend<{ data: RoleJSON[] }>(app, "GET", "/v1/roles?limit=100");
    const admin = roles.body.data.find((r) => r.key === "org:admin")!;
    expect((await backend(app, "PATCH", `/v1/roles/${admin.id}`, { name: "Root" })).status).toBe(403);
    expect((await backend(app, "DELETE", `/v1/roles/${admin.id}`)).status).toBe(403);
  });

  it("assigns instance roles only through the operator route, and only app: roles", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const user = await seedUser(ctx, { email: "roles@acme.test" });
    await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    const permission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "app:reports:read", name: "Read reports" });
    const role = (await backend<{ data: RoleJSON[] }>(app, "GET", "/v1/roles?query=app:support")).body.data[0]!;
    await backend(app, "POST", `/v1/roles/${role.id}/permissions`, { permissions: [permission.body.key] });

    const assigned = await backend<{ user_id: string; roles: string[]; role_permissions: string[] }>(app, "PUT", `/v1/users/${user.id}/roles`, {
      roles: ["app:support"],
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.roles).toEqual(["app:support"]);
    expect(assigned.body.role_permissions).toEqual(["app:reports:read"]);

    // An organization role cannot be smuggled in as an instance role, and a missing role is a 422.
    const orgRole = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:billing", name: "Billing" });
    expect(orgRole.status).toBe(200);
    for (const roles of [["org:billing"], ["app:missing"], ["org:admin"]]) {
      const res = await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles });
      expect(res.status, JSON.stringify(roles)).toBe(422);
    }
    // The refusal did not clear the existing assignment.
    expect((await backend<{ roles: string[] }>(app, "GET", `/v1/users/${user.id}/roles`)).body.roles).toEqual(["app:support"]);
  });

  it("shows instance roles on UserJSON and in the session token, separate from org_role", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const user = await seedUser(ctx, { email: "claims@acme.test" });
    const auth = await seedAuth(ctx, user.id);
    await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles: ["app:support"] });

    const json = (await backend<UserJSON>(app, "GET", `/v1/users/${user.id}`)).body;
    expect(json.roles).toEqual(["app:support"]);
    expect(json.role_permissions).toEqual([]);

    // A fresh session token carries the claim; org_* stays absent because there is no active organization.
    const fresh = await seedAuth(ctx, user.id);
    const claims = await sessionClaims(app, ctx, fresh.sessionId);
    expect(claims.roles).toEqual(["app:support"]);
    expect(claims.role_permissions).toEqual([]);
    expect(claims.org_role).toBeUndefined();

    // Revoking the assignment does not sign the user out: instance roles are read on every mint, so the next
    // token simply carries no role. Ending sessions for a permission change is what we are avoiding.
    const cleared = await backend<{ roles: string[] }>(app, "PUT", `/v1/users/${user.id}/roles`, { roles: [] });
    expect(cleared.body.roles).toEqual([]);
    const sessions = await ctx.db.select().from(s.sessions).where(eq(s.sessions.userId, user.id));
    expect(sessions.some((row) => row.id === auth.sessionId && row.status === "active")).toBe(true);
    const after = await sessionClaims(app, ctx, auth.sessionId);
    expect(after.roles).toEqual([]);
  });

  it("keeps organization roles out of the instance claims and vice versa", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const user = await seedUser(ctx, { email: "both@acme.test" });
    const auth = await seedAuth(ctx, user.id);
    const org = (await api<{ response: { id: string } }>(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Acme" } })).body.response;

    await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles: ["app:support"] });
    // Assigning roles leaves existing sessions alone; this session was created afterwards with the org active.
    const session = await seedAuth(ctx, user.id, { activeOrganizationId: org.id });
    const claims = await sessionClaims(app, ctx, session.sessionId);
    expect(claims.org_role).toBe("org:admin");
    expect(claims.roles).toEqual(["app:support"]);
    // The two lists never overlap: an org permission is not an instance permission.
    expect(claims.role_permissions ?? []).not.toContain("org:sys_memberships:manage");
  });

  it("does not let a member assign themselves a role through any Frontend API call", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    const user = await seedUser(ctx, { email: "self@acme.test" });
    const auth = await seedAuth(ctx, user.id);
    const org = (await api<{ response: { id: string } }>(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Acme" } })).body.response;

    // There is no Frontend API route to write instance roles at all (an unknown path is a 404, and the one
    // membership route that exists refuses the instance key with a 422).
    for (const [method, path] of [
      ["PUT", `/v1/client/me/roles`],
      ["POST", `/v1/client/users/${user.id}/roles`],
    ] as const) {
      const res = await api(app, method, path, { cookie: auth.cookie, body: { roles: ["app:support"] } });
      // 404 (no such route) or 401 (the client middleware rejects an unknown path before routing): never a write.
      expect([401, 404, 405].includes(res.status), `${method} ${path} → ${res.status}`).toBe(true);
    }
    // The real update route is a PATCH and it refuses the instance key outright.
    const membership = await api(app, "PATCH", `/v1/client/organizations/${org.id}/memberships/${user.id}`, { cookie: auth.cookie, body: { role: "app:support" } });
    expect(membership.status, `membership → ${membership.status}`).toBe(422);
    expect(errorCode(membership.body)).toBe("form_param_value_invalid");
    expect((await backend<{ roles: string[] }>(app, "GET", `/v1/users/${user.id}/roles`)).body.roles).toEqual([]);
  });

  it("refuses an instance role on an organization membership or invitation", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const org = (await backend<{ id: string }>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id })).body;

    const add = await backend(app, "POST", `/v1/organizations/${org.id}/memberships`, { user_id: member.id, role: "app:support" });
    expect(add.status).toBe(422);
    expect(errorCode(add.body)).toBe("form_param_value_invalid");

    const invite = await backend(app, "POST", `/v1/organizations/${org.id}/invitations`, { email_address: "invitee@acme.test", role: "app:support" });
    expect(invite.status).toBe(422);

    // The Frontend API membership update refuses it too.
    const ownerAuth = await seedAuth(ctx, owner.id);
    const frontendPatch = await api(app, "PATCH", `/v1/client/organizations/${org.id}/memberships/${member.id}`, { cookie: ownerAuth.cookie, body: { role: "app:support" } });
    expect([422, 404].includes(frontendPatch.status)).toBe(true);
  });

  it("refuses to delete a role that is assigned as an instance role", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const user = await seedUser(ctx, { email: "assigned@acme.test" });
    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "app:support", name: "Support" });
    await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles: ["app:support"] });
    const del = await backend(app, "DELETE", `/v1/roles/${role.body.id}`);
    expect(del.status).toBe(403);
    await backend(app, "PUT", `/v1/users/${user.id}/roles`, { roles: [] });
    expect((await backend(app, "DELETE", `/v1/roles/${role.body.id}`)).status).toBe(200);
  });

  it("refuses to delete a role that a pending invitation would accept into", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const org = (await backend<{ id: string }>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id })).body;
    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:viewer", name: "Viewer" });
    const invite = await backend(app, "POST", `/v1/organizations/${org.id}/invitations`, { email_address: "invitee@acme.test", role: "org:viewer" });
    expect(invite.status).toBe(200);
    const del = await backend(app, "DELETE", `/v1/roles/${role.body.id}`);
    expect(del.status).toBe(403);
    expect(JSON.stringify(del.body)).toContain("pending invitation");
  });

  it("keeps a custom org role working end to end on an organization endpoint", async () => {
    const { ctx, app } = await setup();
    await seedRbac(ctx);
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = (await api<{ response: { id: string } }>(app, "POST", "/v1/client/organizations", { cookie: ownerAuth.cookie, body: { name: "Acme" } })).body.response;
    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:viewer", name: "Viewer" });
    await backend(app, "POST", `/v1/roles/${role.body.id}/permissions`, { permissions: ["org:sys_memberships:read"] });

    const member = await seedUser(ctx, { email: "viewer@acme.test" });
    const memberAuth = await seedAuth(ctx, member.id);
    await backend(app, "POST", `/v1/organizations/${org.id}/memberships`, { user_id: member.id, role: "org:viewer" });

    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/memberships`, { cookie: memberAuth.cookie })).status).toBe(200);
    expect((await api(app, "PATCH", `/v1/client/organizations/${org.id}`, { cookie: memberAuth.cookie, body: { name: "No" } })).status).toBe(403);
  });
});
