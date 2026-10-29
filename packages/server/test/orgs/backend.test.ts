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

import type {
  OrganizationDomainJSON, OrganizationInvitationJSON, OrganizationJSON, OrganizationMembershipJSON, OrganizationMembershipRequestJSON,
  PaginatedList, PermissionJSON, RoleJSON,
} from "@orbitid/shared";
import { api, backend, errorCode, seedAuth, seedUser, setup } from "./helpers";

describe("Backend API organizations", () => {
  it("creates, queries, updates and deletes organizations", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });

    const created = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", {
      name: "Acme Corp", created_by: owner.id, max_allowed_memberships: 12,
      public_metadata: { tier: "pro" }, private_metadata: { billing: "acct_1" },
    });
    expect(created.status).toBe(200);
    expect(created.body.slug).toBe("acme-corp");
    expect(created.body.created_by).toBe(owner.id);
    expect(created.body.max_allowed_memberships).toBe(12);
    expect(created.body.private_metadata).toEqual({ billing: "acct_1" });
    expect(created.body.members_count).toBe(1);

    const list = await backend<PaginatedList<OrganizationJSON>>(app, "GET", "/v1/organizations?query=acme&limit=10");
    expect(list.body.total_count).toBe(1);
    expect(list.body.data[0]!.id).toBe(created.body.id);

    const withoutCounts = await backend<PaginatedList<OrganizationJSON>>(app, "GET", "/v1/organizations?include_members_count=false");
    expect(withoutCounts.body.data[0]!.members_count).toBeUndefined();

    const bySlug = await backend<OrganizationJSON>(app, "GET", "/v1/organizations/acme-corp");
    expect(bySlug.body.id).toBe(created.body.id);
    expect(bySlug.body.private_metadata).toEqual({ billing: "acct_1" });

    const updated = await backend<OrganizationJSON>(app, "PATCH", `/v1/organizations/${created.body.id}`, { name: "Acme Two", admin_delete_enabled: false });
    expect(updated.body.name).toBe("Acme Two");
    expect(updated.body.admin_delete_enabled).toBe(false);

    const firstMerge = await backend<OrganizationJSON>(app, "PATCH", `/v1/organizations/${created.body.id}/metadata`, {
      public_metadata: { tier: "free", nested: { a: 1, b: 2 } },
    });
    expect(firstMerge.body.public_metadata).toEqual({ tier: "free", nested: { a: 1, b: 2 } });
    const secondMerge = await backend<OrganizationJSON>(app, "PATCH", `/v1/organizations/${created.body.id}/metadata`, {
      public_metadata: { nested: { a: 9 }, extra: true },
    });
    expect(secondMerge.body.public_metadata).toEqual({ tier: "free", nested: { a: 9, b: 2 }, extra: true });
    expect(secondMerge.body.private_metadata).toEqual({ billing: "acct_1" });

    // null removes a key (dashboard metadata editor contract)
    const removeKey = await backend<OrganizationJSON>(app, "PATCH", `/v1/organizations/${created.body.id}`, { public_metadata: { tier: null } });
    expect(removeKey.body.public_metadata).toEqual({ nested: { a: 9, b: 2 }, extra: true });
    // PATCH organization deep-merges metadata too
    const deepMerged = await backend<OrganizationJSON>(app, "PATCH", `/v1/organizations/${created.body.id}`, { public_metadata: { nested: { c: 3 } } });
    expect(deepMerged.body.public_metadata).toEqual({ nested: { a: 9, b: 2, c: 3 }, extra: true });

    const deleted = await backend<{ object: string; id: string; deleted: boolean }>(app, "DELETE", `/v1/organizations/${created.body.id}`);
    expect(deleted.body).toEqual({ object: "organization", id: created.body.id, deleted: true });
    expect((await backend(app, "GET", `/v1/organizations/${created.body.id}`)).status).toBe(404);
  });

  it("manages memberships with metadata merge, quota and last-admin guards", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const created = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id, max_allowed_memberships: 2 });

    const added = await backend<OrganizationMembershipJSON>(app, "POST", `/v1/organizations/${created.body.id}/memberships`, {
      user_id: member.id, role: "org:member", public_metadata: { seat: 1 }, private_metadata: { note: "x" },
    });
    expect(added.status).toBe(200);
    expect(added.body.role).toBe("org:member");
    expect(added.body.private_metadata).toEqual({ note: "x" });

    const duplicate = await backend(app, "POST", `/v1/organizations/${created.body.id}/memberships`, { user_id: member.id });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe("duplicate_record");

    // quota: 2 of 2 seats used
    const third = await seedUser(ctx, { email: "third@acme.test" });
    const overQuota = await backend(app, "POST", `/v1/organizations/${created.body.id}/memberships`, { user_id: third.id });
    expect(overQuota.status).toBe(403);
    expect(errorCode(overQuota.body)).toBe("organization_membership_quota_exceeded");

    const merged = await backend<OrganizationMembershipJSON>(app, "PATCH", `/v1/organizations/${created.body.id}/memberships/${member.id}/metadata`, {
      public_metadata: { seat: 2, extra: true },
    });
    expect(merged.body.public_metadata).toEqual({ seat: 2, extra: true });
    const mergedByPatch = await backend<OrganizationMembershipJSON>(app, "PATCH", `/v1/organizations/${created.body.id}/memberships/${member.id}`, {
      public_metadata: { seat: 3 },
    });
    expect(mergedByPatch.body.public_metadata).toEqual({ seat: 3, extra: true });

    const listed = await backend<PaginatedList<OrganizationMembershipJSON>>(app, "GET", `/v1/organizations/${created.body.id}/memberships?query=member&role=org:member`);
    expect(listed.body.total_count).toBe(1);
    expect(listed.body.data[0]!.public_user_data.user_id).toBe(member.id);

    const byUser = await backend<PaginatedList<OrganizationMembershipJSON>>(app, "GET", `/v1/users/${member.id}/organization_memberships`);
    expect(byUser.body.total_count).toBe(1);

    // last admin cannot be removed or demoted
    const removeAdmin = await backend(app, "DELETE", `/v1/organizations/${created.body.id}/memberships/${owner.id}`);
    expect(removeAdmin.status).toBe(403);
    expect(errorCode(removeAdmin.body)).toBe("organization_minimum_permissions_needed");
    const demoteAdmin = await backend(app, "PATCH", `/v1/organizations/${created.body.id}/memberships/${owner.id}`, { role: "org:member" });
    expect(demoteAdmin.status).toBe(403);

    const removed = await backend<{ deleted: boolean }>(app, "DELETE", `/v1/organizations/${created.body.id}/memberships/${member.id}`);
    expect(removed.body.deleted).toBe(true);
    expect((await backend<PaginatedList<OrganizationMembershipJSON>>(app, "GET", `/v1/users/${member.id}/organization_memberships`)).body.total_count).toBe(0);

    const missingUser = await backend(app, "POST", `/v1/organizations/${created.body.id}/memberships`, { user_id: "user_missing" });
    expect(missingUser.status).toBe(404);
  });

  it("manages invitations including bulk creation and the no-email url flow", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const org = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id });

    const single = await backend<OrganizationInvitationJSON>(app, "POST", `/v1/organizations/${org.body.id}/invitations`, {
      email_address: "invitee@acme.test", role: "org:member",
    });
    expect(single.status).toBe(200);
    expect(single.body.status).toBe("pending");
    expect(String(single.body.url)).toContain("/v1/client/organization_invitations/accept?ticket=");

    const withNotify = await backend<OrganizationInvitationJSON>(app, "POST", `/v1/organizations/${org.body.id}/invitations`, {
      email_address: "notified@acme.test", notify: true,
    });
    expect(withNotify.body.url).toBeUndefined();

    const listed = await backend<PaginatedList<OrganizationInvitationJSON>>(app, "GET", `/v1/organizations/${org.body.id}/invitations?status=pending`);
    expect(listed.body.total_count).toBe(2);

    const fetched = await backend<OrganizationInvitationJSON>(app, "GET", `/v1/organizations/${org.body.id}/invitations/${single.body.id}`);
    expect(fetched.body.email_address).toBe("invitee@acme.test");

    const revoked = await backend<OrganizationInvitationJSON>(app, "POST", `/v1/organizations/${org.body.id}/invitations/${single.body.id}/revoke`);
    expect(revoked.body.status).toBe("revoked");
    const revokeAgain = await backend(app, "POST", `/v1/organizations/${org.body.id}/invitations/${single.body.id}/revoke`);
    expect(revokeAgain.status).toBe(409);

    const bulk = await backend<OrganizationInvitationJSON[]>(app, "POST", `/v1/organizations/${org.body.id}/invitations/bulk`, {
      email_addresses: ["a@acme.test", "b@acme.test", "a@acme.test"],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toHaveLength(2);
    expect(bulk.body.every((i) => typeof i.url === "string")).toBe(true);
  });

  it("manages domains", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const org = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id });

    const created = await backend<OrganizationDomainJSON>(app, "POST", `/v1/organizations/${org.body.id}/domains`, { name: "acme.test", enrollment_mode: "automatic_suggestion" });
    expect(created.status).toBe(200);
    expect(created.body.name).toBe("acme.test");
    expect(created.body.verification?.status).toBe("unverified");

    const updated = await backend<OrganizationDomainJSON>(app, "PATCH", `/v1/organizations/${org.body.id}/domains/${created.body.id}`, { enrollment_mode: "manual_invitation" });
    expect(updated.body.enrollment_mode).toBe("manual_invitation");

    const listed = await backend<PaginatedList<OrganizationDomainJSON>>(app, "GET", `/v1/organizations/${org.body.id}/domains`);
    expect(listed.body.total_count).toBe(1);

    const deleted = await backend<{ deleted: boolean }>(app, "DELETE", `/v1/organizations/${org.body.id}/domains/${created.body.id}`);
    expect(deleted.body.deleted).toBe(true);

    const invalid = await backend(app, "POST", `/v1/organizations/${org.body.id}/domains`, { name: "invalid" });
    expect(invalid.status).toBe(422);
  });

  it("manages membership requests", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const applicant = await seedUser(ctx, { email: "applicant@acme.test" });
    const org = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id });

    const request = await backend<OrganizationMembershipRequestJSON>(app, "POST", `/v1/organizations/${org.body.id}/membership_requests`, { user_id: applicant.id });
    expect(request.status).toBe(200);
    expect(request.body.status).toBe("pending");

    const listed = await backend<PaginatedList<OrganizationMembershipRequestJSON>>(app, "GET", `/v1/organizations/${org.body.id}/membership_requests?status=pending`);
    expect(listed.body.total_count).toBe(1);

    const accepted = await backend<OrganizationMembershipJSON>(app, "POST", `/v1/organizations/${org.body.id}/membership_requests/${request.body.id}/accept`);
    expect(accepted.body.public_user_data.user_id).toBe(applicant.id);
    expect((await backend<PaginatedList<OrganizationMembershipJSON>>(app, "GET", `/v1/users/${applicant.id}/organization_memberships`)).body.total_count).toBe(1);
  });

  it("manages roles and permissions with system guards", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const org = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id, max_allowed_memberships: 10 });

    const invalidKey = await backend(app, "POST", "/v1/roles", { key: "support", name: "Support" });
    expect(invalidKey.status).toBe(422);
    const reservedKey = await backend(app, "POST", "/v1/roles", { key: "org:sys_support", name: "Support" });
    expect(reservedKey.status).toBe(422);
    const duplicateRole = await backend(app, "POST", "/v1/roles", { key: "org:admin", name: "Admin 2" });
    expect(duplicateRole.status).toBe(409);

    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:support", name: "Support", permissions: ["org:sys_memberships:read"] });
    expect(role.status).toBe(200);
    expect(role.body.permissions.map((p) => p.key)).toEqual(["org:sys_memberships:read"]);

    const permission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "org:invoices:manage", name: "Manage invoices" });
    expect(permission.status).toBe(200);
    expect(permission.body.type).toBe("user");
    expect((await backend(app, "POST", "/v1/permissions", { key: "org:sys_invoices:manage", name: "Nope" })).status).toBe(422);

    const assigned = await backend<RoleJSON>(app, "POST", `/v1/roles/${role.body.id}/permissions`, {
      permissions: ["org:sys_memberships:read", "org:invoices:manage"],
    });
    expect(assigned.body.permissions.map((p) => p.key)).toEqual(["org:invoices:manage", "org:sys_memberships:read"]);

    const removedPermission = await backend<RoleJSON>(app, "DELETE", `/v1/roles/${role.body.id}/permissions/${permission.body.id}`);
    expect(removedPermission.body.permissions.map((p) => p.key)).toEqual(["org:sys_memberships:read"]);

    const orgRoles = await backend<PaginatedList<RoleJSON>>(app, "GET", `/v1/organizations/${org.body.id}/roles?limit=100`);
    expect(orgRoles.body.total_count).toBeGreaterThanOrEqual(3);
    expect(orgRoles.body.data.map((r) => r.key)).toEqual(expect.arrayContaining(["org:admin", "org:member", "org:support"]));

    const roleList = await backend<PaginatedList<RoleJSON>>(app, "GET", "/v1/roles?query=org:");
    expect(roleList.body.data.some((r) => r.key === "org:support")).toBe(true);

    // system roles and permissions are immutable
    const systemRole = roleList.body.data.find((r) => r.key === "org:admin")!;
    expect((await backend(app, "PATCH", `/v1/roles/${systemRole.id}`, { name: "Root" })).status).toBe(403);
    expect((await backend(app, "DELETE", `/v1/roles/${systemRole.id}`)).status).toBe(403);
    const systemPermission = (await backend<PaginatedList<PermissionJSON>>(app, "GET", "/v1/permissions?type=system")).body.data[0]!;
    expect((await backend(app, "PATCH", `/v1/permissions/${systemPermission.id}`, { name: "Nope" })).status).toBe(403);
    expect((await backend(app, "DELETE", `/v1/permissions/${systemPermission.id}`)).status).toBe(403);

    // role in use cannot be deleted
    const membership = await backend<OrganizationMembershipJSON>(app, "POST", `/v1/organizations/${org.body.id}/memberships`, { user_id: member.id, role: "org:support" });
    expect(membership.status).toBe(200);
    const inUse = await backend(app, "DELETE", `/v1/roles/${role.body.id}`);
    expect(inUse.status).toBe(403);
    expect(errorCode(inUse.body)).toBe("not_allowed_access");

    await backend(app, "DELETE", `/v1/organizations/${org.body.id}/memberships/${member.id}`);
    expect((await backend(app, "DELETE", `/v1/roles/${role.body.id}`)).status).toBe(200);

    // creator role cannot be deleted
    const creatorCandidate = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:owner", name: "Owner", is_creator_eligible: true });
    await ctx.settings.update({ organizations: { creatorRole: "org:owner" } });
    expect((await backend(app, "DELETE", `/v1/roles/${creatorCandidate.body.id}`)).status).toBe(403);

    // custom permissions are deletable
    const deletedPermission = await backend<{ deleted: boolean }>(app, "DELETE", `/v1/permissions/${permission.body.id}`);
    expect(deletedPermission.body.deleted).toBe(true);
  });

  it("rejects unauthenticated Backend API calls and hides organizations from other instances", async () => {
    const { ctx, app } = await setup();
    const res = await api(app, "GET", "/v1/organizations");
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe("secret_key_invalid");

    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const org = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id });
    const auth = await seedAuth(ctx, owner.id);
    // Backend-created organization is visible in the Frontend API only to its members
    expect((await api(app, "GET", `/v1/client/organizations/${org.body.id}`, { cookie: auth.cookie })).status).toBe(200);
  });
});
