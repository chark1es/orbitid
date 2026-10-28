import { describe, it, expect, vi } from "vitest";
import type { RecordedEmail } from "./mocks";

// vi.mock factories are hoisted above static imports, so the recorder module is loaded dynamically.
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

import type { OrganizationJSON, OrganizationMembershipJSON } from "@orbitid/shared";
import { signSessionToken } from "../../src/services/tokens";
import { seedRbac } from "../../src/services/orgs";
import { permissionsForRole } from "../../src/services/rbac";
import * as s from "../../src/db/schema";
import { setup, seedUser, seedAuth, createOrg, invite, api, backend, errorCode, memberships, membershipFor } from "./helpers";

async function adminAndMember(app: Parameters<typeof api>[0], ctx: Parameters<typeof seedUser>[0]) {
  const owner = seedUser(ctx, { email: "owner@acme.test" });
  const ownerAuth = seedAuth(ctx, owner.id);
  const org = await createOrg(app, ownerAuth.cookie, "Acme", "acme");
  const member = seedUser(ctx, { email: "member@acme.test" });
  const memberAuth = seedAuth(ctx, member.id);
  const invitation = await invite(app, ownerAuth.cookie, org.id, "member@acme.test");
  const accepted = await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: memberAuth.cookie });
  expect(accepted.status).toBe(200);
  return { owner, ownerAuth, org, member, memberAuth };
}

describe("organization RBAC", () => {
  it("gates every Frontend API endpoint on the caller's membership permissions", async () => {
    const { ctx, app } = await setup();
    const { org, memberAuth } = await adminAndMember(app, ctx);

    // member can read
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}`, { cookie: memberAuth.cookie })).status).toBe(200);
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/memberships`, { cookie: memberAuth.cookie })).status).toBe(200);
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/roles`, { cookie: memberAuth.cookie })).status).toBe(200);

    // member cannot write
    const rename = await api(app, "PATCH", `/v1/client/organizations/${org.id}`, { cookie: memberAuth.cookie, body: { name: "Nope" } });
    expect(rename.status).toBe(403);
    expect(errorCode(rename.body)).toBe("org_permission_required");

    const inviteAttempt = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: memberAuth.cookie, body: { email_address: "x@acme.test" } });
    expect(inviteAttempt.status).toBe(403);
    expect(errorCode(inviteAttempt.body)).toBe("org_permission_required");

    const removeAdmin = await api(app, "DELETE", `/v1/client/organizations/${org.id}/memberships/${(await memberships(app, memberAuth.cookie, org.id)).find((m) => m.role === "org:admin")!.public_user_data.user_id}`, { cookie: memberAuth.cookie });
    expect(removeAdmin.status).toBe(403);

    // read-only role may read domains but must not modify them
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/domains`, { cookie: memberAuth.cookie })).status).toBe(200);
    expect((await api(app, "POST", `/v1/client/organizations/${org.id}/domains`, { cookie: memberAuth.cookie, body: { name: "acme.test" } })).status).toBe(403);
    expect((await api(app, "DELETE", `/v1/client/organizations/${org.id}`, { cookie: memberAuth.cookie })).status).toBe(403);

    // non-members cannot read the organization at all
    const outsider = seedUser(ctx, { email: "outsider@acme.test" });
    const outsiderAuth = seedAuth(ctx, outsider.id);
    const outsiderGet = await api(app, "GET", `/v1/client/organizations/${org.id}`, { cookie: outsiderAuth.cookie });
    expect(outsiderGet.status).toBe(404);
    expect(errorCode(outsiderGet.body)).toBe("not_a_member_in_organization");
  });

  it("applies system permissions granted by a custom role and exposes custom permissions", async () => {
    const { ctx, app } = await setup();
    const { org, ownerAuth, member, memberAuth } = await adminAndMember(app, ctx);

    const role = await backend<{ id: string; key: string }>(app, "POST", "/v1/roles", {
      key: "org:viewer", name: "Viewer", permissions: ["org:sys_memberships:read"],
    });
    expect(role.status).toBe(200);
    const permission = await backend<{ id: string }>(app, "POST", "/v1/permissions", { key: "org:reports:read", name: "Read reports" });
    expect(permission.status).toBe(200);

    const assign = await backend(app, "POST", `/v1/roles/${role.body.id}/permissions`, {
      permissions: ["org:sys_memberships:read", "org:reports:read"],
    });
    expect(assign.status).toBe(200);

    const patch = await backend<{ role: string }>(app, "PATCH", `/v1/organizations/${org.id}/memberships/${member.id}`, { role: "org:viewer" });
    expect(patch.status).toBe(200);
    expect(patch.body.role).toBe("org:viewer");

    const list = await memberships(app, memberAuth.cookie, org.id);
    const self = membershipFor(list, member.id)!;
    expect(self.permissions).toEqual(expect.arrayContaining(["org:sys_memberships:read", "org:reports:read"]));
    expect(self.role_name).toBe("Viewer");

    // custom role's system permission unlocks the endpoint
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/memberships`, { cookie: memberAuth.cookie })).status).toBe(200);
    // but not the ones it does not hold
    expect((await api(app, "GET", `/v1/client/organizations/${org.id}/domains`, { cookie: memberAuth.cookie })).status).toBe(403);
    // admin still sees the custom permission in the role set
    const roles = await api<{ response: { key: string; permissions: { key: string }[] }[] }>(app, "GET", `/v1/client/organizations/${org.id}/roles`, { cookie: ownerAuth.cookie });
    expect(roles.body.response.find((r) => r.key === "org:viewer")!.permissions.map((p) => p.key)).toContain("org:reports:read");
  });

  it("protects the last admin from leaving, being demoted or being removed", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Solo");

    const leave = await api(app, "DELETE", `/v1/client/me/organization_memberships/${org.id}`, { cookie: ownerAuth.cookie });
    expect(leave.status).toBe(403);
    expect(errorCode(leave.body)).toBe("organization_minimum_permissions_needed");

    const demote = await api(app, "PATCH", `/v1/client/organizations/${org.id}/memberships/${owner.id}`, { cookie: ownerAuth.cookie, body: { role: "org:member" } });
    expect(demote.status).toBe(403);
    expect(errorCode(demote.body)).toBe("organization_minimum_permissions_needed");

    const remove = await api(app, "DELETE", `/v1/client/organizations/${org.id}/memberships/${owner.id}`, { cookie: ownerAuth.cookie });
    expect(remove.status).toBe(403);

    // second admin can take over
    const second = seedUser(ctx, { email: "second@acme.test" });
    const secondAuth = seedAuth(ctx, second.id);
    const invitation = await invite(app, ownerAuth.cookie, org.id, "second@acme.test", "org:admin");
    expect((await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: secondAuth.cookie })).status).toBe(200);

    const demoteFirst = await api<{ response: OrganizationMembershipJSON }>(app, "PATCH", `/v1/client/organizations/${org.id}/memberships/${owner.id}`, { cookie: secondAuth.cookie, body: { role: "org:member" } });
    expect(demoteFirst.status).toBe(200);
    expect(demoteFirst.body.response.role).toBe("org:member");

    // the remaining admin is protected
    const leaveLast = await api(app, "DELETE", `/v1/client/me/organization_memberships/${org.id}`, { cookie: secondAuth.cookie });
    expect(leaveLast.status).toBe(403);
    // a plain member may leave
    const memberLeave = await api(app, "DELETE", `/v1/client/me/organization_memberships/${org.id}`, { cookie: ownerAuth.cookie });
    expect(memberLeave.status).toBe(200);
  });

  it("seeds system roles and permissions idempotently", async () => {
    const { ctx } = await setup();
    const rolesBefore = ctx.db.select().from(s.roles).all();
    const linksBefore = ctx.db.select().from(s.rolePermissions).all().length;

    await seedRbac(ctx);
    await seedRbac(ctx);

    expect(ctx.db.select().from(s.roles).all().map((r) => r.key).sort()).toEqual(rolesBefore.map((r) => r.key).sort());
    expect(ctx.db.select().from(s.rolePermissions).all().length).toBe(linksBefore);
    expect(rolesBefore.filter((r) => r.isSystem).map((r) => r.key).sort()).toEqual(["org:admin", "org:member"]);
    expect(permissionsForRole(ctx, "org:admin")).toEqual([
      "org:sys_domains:manage", "org:sys_domains:read", "org:sys_memberships:manage", "org:sys_memberships:read",
      "org:sys_profile:delete", "org:sys_profile:manage",
    ]);
    expect(permissionsForRole(ctx, "org:member")).toEqual(["org:sys_domains:read", "org:sys_memberships:read"]);
  });

  it("lists the caller's memberships with the active organization first", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const first = seedAuth(ctx, owner.id);
    const alpha = await createOrg(app, first.cookie, "Alpha");
    const beta = await createOrg(app, first.cookie, "Beta");

    const active = seedAuth(ctx, owner.id, { activeOrganizationId: alpha.id });
    const list = await api<{ response: OrganizationMembershipJSON[] }>(app, "GET", "/v1/client/me/organization_memberships", { cookie: active.cookie });
    expect(list.status).toBe(200);
    expect(list.body.response).toHaveLength(2);
    expect(list.body.response[0]!.organization.id).toBe(alpha.id);

    const paginated = await api<{ data: OrganizationMembershipJSON[]; total_count: number }>(app, "GET", "/v1/client/me/organization_memberships?paginated=true&limit=1", { cookie: active.cookie });
    expect(paginated.body.total_count).toBe(2);
    expect(paginated.body.data).toHaveLength(1);
    expect(paginated.body.data[0]!.organization.id).toBe(alpha.id);
    expect(beta.id).not.toBe(alpha.id);
  });

  it("authenticates Frontend API calls with a session JWT bearer token", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const auth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, auth.cookie, "Acme");

    const jwt = await signSessionToken(ctx, auth.sessionId);
    expect(jwt.split(".")).toHaveLength(3);
    const viaJwt = await api(app, "GET", `/v1/client/organizations/${org.id}`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(viaJwt.status).toBe(200);

    const garbage = await api(app, "GET", `/v1/client/organizations/${org.id}`, { headers: { authorization: "Bearer aaa.bbb.ccc" } });
    expect(garbage.status).toBe(401);
    const noClient = await api(app, "GET", `/v1/client/organizations/${org.id}`, { cookie: "__client=irrelevant" });
    expect(noClient.status).toBe(401);
  });

  it("returns 403 organizations_disabled when organizations are turned off", async () => {
    const { ctx, app } = await setup({ organizations: { enabled: false } });
    const user = seedUser(ctx, { email: "user@acme.test" });
    const auth = seedAuth(ctx, user.id);
    const res = await api(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Acme" } });
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("organizations_disabled");
    const list = await api(app, "GET", "/v1/client/me/organization_memberships", { cookie: auth.cookie });
    expect(list.status).toBe(403);
  });

  it("enforces organization creation limits", async () => {
    const { ctx, app } = await setup({ organizations: { maxCreatedOrganizationsPerUser: 1 } });
    const user = seedUser(ctx, { email: "creator@acme.test" });
    const auth = seedAuth(ctx, user.id);
    expect((await api<{ response: OrganizationJSON }>(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "One" } })).status).toBe(200);
    const second = await api(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Two" } });
    expect(second.status).toBe(403);
    expect(errorCode(second.body)).toBe("organization_creation_not_allowed");

    const blockedUser = seedUser(ctx, { email: "blocked@acme.test", createOrganizationEnabled: false });
    const blockedAuth = seedAuth(ctx, blockedUser.id);
    const blocked = await api(app, "POST", "/v1/client/organizations", { cookie: blockedAuth.cookie, body: { name: "Nope" } });
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked.body)).toBe("organization_creation_not_allowed");
  });

  it("validates and de-duplicates slugs and enforces the membership quota", async () => {
    const { ctx, app } = await setup({ organizations: { maxAllowedMemberships: 2 } });
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme Inc", "acme-inc");
    expect(org.slug).toBe("acme-inc");

    const duplicate = await api(app, "POST", "/v1/client/organizations", { cookie: ownerAuth.cookie, body: { name: "Other", slug: "acme-inc" } });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe("organization_slug_taken");

    // derived slug is suffixed instead of failing
    const derived = await createOrg(app, ownerAuth.cookie, "Acme Inc");
    expect(derived.slug).toBe("acme-inc-2");

    const bad = await api(app, "POST", "/v1/client/organizations", { cookie: ownerAuth.cookie, body: { name: "Bad", slug: "Not A Slug" } });
    expect(bad.status).toBe(422);

    const invited = await invite(app, ownerAuth.cookie, org.id, "first@acme.test");
    expect(invited.status).toBe("pending");
    // 1 member + 1 pending invitation fills max_allowed_memberships=2
    const overQuota = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie, body: { email_address: "second@acme.test" } });
    expect(overQuota.status).toBe(403);
    expect(errorCode(overQuota.body)).toBe("organization_membership_quota_exceeded");
  });

  it("requires authentication and hides private metadata from the Frontend API", async () => {
    const { ctx, app } = await setup();
    const anonymous = await api(app, "GET", "/v1/client/me/organization_memberships");
    expect(anonymous.status).toBe(401);

    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const created = await api<{ response: OrganizationJSON }>(app, "POST", "/v1/client/organizations", {
      cookie: ownerAuth.cookie,
      body: { name: "Secret Org", public_metadata: { plan: "free" }, private_metadata: { secret: "shh" } },
    });
    expect(created.status).toBe(200);
    expect(created.body.response.public_metadata).toEqual({ plan: "free" });
    expect("private_metadata" in created.body.response).toBe(false);

    const fetched = await api<{ response: OrganizationJSON }>(app, "GET", `/v1/client/organizations/${created.body.response.id}`, { cookie: ownerAuth.cookie });
    expect("private_metadata" in fetched.body.response).toBe(false);

    const asBackend = await backend<OrganizationJSON>(app, "GET", `/v1/organizations/${created.body.response.id}`);
    expect(asBackend.body.private_metadata).toEqual({ secret: "shh" });
  });
});
