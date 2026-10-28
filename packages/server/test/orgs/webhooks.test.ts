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

import type { OrganizationDomainJSON, OrganizationJSON, PermissionJSON, RoleJSON } from "@orbitid/shared";
import { onUserDeleted } from "../../src/services/orgs";
import { api, backend, createOrg, eventsOf, invite, lastMail, seedAuth, seedUser, setup } from "./helpers";
import * as s from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { first } from "../../src/lib/db";

describe("organization webhooks", () => {
  it("emits organization and membership events with backend payloads", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);

    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const created = eventsOf("organization.created") as OrganizationJSON[];
    expect(created).toHaveLength(1);
    expect(created[0]!.id).toBe(org.id);
    expect("private_metadata" in created[0]!).toBe(true);

    const creatorMembership = eventsOf("organizationMembership.created") as { role: string; organization: OrganizationJSON }[];
    expect(creatorMembership).toHaveLength(1);
    expect(creatorMembership[0]!.role).toBe("org:admin");
    expect(creatorMembership[0]!.organization.id).toBe(org.id);

    await api(app, "PATCH", `/v1/client/organizations/${org.id}`, { cookie: ownerAuth.cookie, body: { name: "Acme Renamed" } });
    expect((eventsOf("organization.updated") as OrganizationJSON[]).at(-1)!.name).toBe("Acme Renamed");

    const invitee = await seedUser(ctx, { email: "invitee@acme.test", verified: true });
    const inviteeAuth = await seedAuth(ctx, invitee.id);
    const invitation = await invite(app, ownerAuth.cookie, org.id, "invitee@acme.test");
    expect(eventsOf("organizationInvitation.created")).toHaveLength(1);
    await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: inviteeAuth.cookie });
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    expect((eventsOf("organizationMembership.created") as { public_user_data: { user_id: string } }[]).some((m) => m.public_user_data.user_id === invitee.id)).toBe(true);

    await api(app, "PATCH", `/v1/client/organizations/${org.id}/memberships/${invitee.id}`, { cookie: ownerAuth.cookie, body: { role: "org:admin" } });
    expect((eventsOf("organizationMembership.updated") as { role: string }[]).at(-1)!.role).toBe("org:admin");

    await api(app, "DELETE", `/v1/client/organizations/${org.id}/memberships/${invitee.id}`, { cookie: ownerAuth.cookie });
    expect(eventsOf("organizationMembership.deleted")).toHaveLength(1);

    await api(app, "DELETE", `/v1/client/organizations/${org.id}`, { cookie: ownerAuth.cookie });
    expect(eventsOf("organization.deleted")).toHaveLength(1);
  });

  it("emits invitation, domain, role and permission events", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const invitation = await invite(app, ownerAuth.cookie, org.id, "pending@acme.test");
    await api(app, "POST", `/v1/client/organizations/${org.id}/invitations/${invitation.id}/revoke`, { cookie: ownerAuth.cookie });
    expect(eventsOf("organizationInvitation.revoked")).toHaveLength(1);

    const domain = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${org.id}/domains`, { cookie: ownerAuth.cookie, body: { name: "acme.test" } });
    await api(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.body.response.id}/prepare_affiliation_verification`, {
      cookie: ownerAuth.cookie, body: { affiliation_email_address: "admin@acme.test" },
    });
    const code = String(lastMail("domain_verification_code").vars.code);
    await api(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.body.response.id}/attempt_affiliation_verification`, { cookie: ownerAuth.cookie, body: { code } });
    await api(app, "DELETE", `/v1/client/organizations/${org.id}/domains/${domain.body.response.id}`, { cookie: ownerAuth.cookie });
    expect(eventsOf("organizationDomain.created")).toHaveLength(1);
    expect(eventsOf("organizationDomain.updated")).toHaveLength(1);
    expect(eventsOf("organizationDomain.deleted")).toHaveLength(1);

    const role = await backend<RoleJSON>(app, "POST", "/v1/roles", { key: "org:support", name: "Support", permissions: ["org:sys_memberships:read"] });
    await backend(app, "PATCH", `/v1/roles/${role.body.id}`, { name: "Support Team" });
    await backend(app, "DELETE", `/v1/roles/${role.body.id}`);
    expect(eventsOf("role.created")).toHaveLength(1);
    expect(eventsOf("role.updated")).toHaveLength(1);
    expect(eventsOf("role.deleted")).toHaveLength(1);

    const permission = await backend<PermissionJSON>(app, "POST", "/v1/permissions", { key: "org:invoices:manage", name: "Manage invoices" });
    await backend(app, "PATCH", `/v1/permissions/${permission.body.id}`, { name: "Manage billing" });
    await backend(app, "DELETE", `/v1/permissions/${permission.body.id}`);
    expect(eventsOf("permission.created")).toHaveLength(1);
    expect(eventsOf("permission.updated")).toHaveLength(1);
    expect(eventsOf("permission.deleted")).toHaveLength(1);
  });

  it("cleans up organizations when the user row was already deleted (cascade order)", async () => {
    const { ctx, app } = await setup();
    const admin = await seedUser(ctx, { email: "admin@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const promoteOrg = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Cascade Inc", created_by: admin.id });
    await backend(app, "POST", `/v1/organizations/${promoteOrg.body.id}/memberships`, { user_id: member.id, role: "org:member" });
    const orphanOrg = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Gone Inc", created_by: admin.id });

    // users.deleteUser removes the row first; memberships cascade away before the hook runs.
    await ctx.db.delete(s.users).where(eq(s.users.id, admin.id));
    await onUserDeleted(ctx, admin.id);

    expect(first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orphanOrg.body.id)))).toBeUndefined();
    const remaining = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, promoteOrg.body.id)));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.roleKey).toBe("org:admin");
  });

  it("cleans up memberships and promotes or deletes organizations when a user is deleted", async () => {
    const { ctx, app } = await setup();
    const admin = await seedUser(ctx, { email: "admin@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });

    // org with one admin + one member: admin deletion promotes the member
    const promoteOrg = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Promote Inc", created_by: admin.id });
    await backend(app, "POST", `/v1/organizations/${promoteOrg.body.id}/memberships`, { user_id: member.id, role: "org:member" });
    // org owned only by the deleted admin: organization is removed
    const orphanOrg = await backend<OrganizationJSON>(app, "POST", "/v1/organizations", { name: "Orphan Inc", created_by: admin.id });

    await onUserDeleted(ctx, admin.id);

    const rows = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, admin.id)));
    expect(rows).toHaveLength(0);
    const promoted = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, promoteOrg.body.id)));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.roleKey).toBe("org:admin");
    expect(first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orphanOrg.body.id)))).toBeUndefined();

    const deletedMemberships = eventsOf("organizationMembership.deleted") as { public_user_data: { user_id: string } }[];
    expect(deletedMemberships.filter((m) => m.public_user_data.user_id === admin.id)).toHaveLength(2);
    expect(eventsOf("organizationMembership.updated")).toHaveLength(1);
    expect(eventsOf("organization.deleted")).toHaveLength(1);
  });
});
