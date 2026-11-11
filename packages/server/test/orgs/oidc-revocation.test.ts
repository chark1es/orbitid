// Removing an organization membership (or deleting the organization, or demoting a role) must revoke the OIDC
// grants whose claims carry that organization/group authority. The user's OrbitID browser session must survive.
import { describe, expect, it, vi } from "vitest";
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

import { eq } from "drizzle-orm";
import { ID_PREFIX } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";
import { createApplication } from "../../src/services/oidc/applications";
import { api, backend, seedAuth, seedUser, setup } from "./helpers";

interface SeededGrant { id: string; applicationId: string }

async function seedGrant(ctx: Awaited<ReturnType<typeof setup>>["ctx"], applicationId: string, userId: string, label: string): Promise<SeededGrant> {
  const id = newId(ID_PREFIX.oauthGrant);
  const now = Date.now();
  await ctx.db.insert(s.oauthGrants).values({
    id, kind: "refresh", applicationId, userId, tokenHash: `hash_${label}_${id}`,
    scopes: "openid", familyId: `family_${label}_${id}`, revoked: false,
    expiresAt: now + 3_600_000, createdAt: now,
  });
  return { id, applicationId };
}

async function grantRow(ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: string) {
  return (await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.id, id)))[0]!;
}

describe("organization changes revoke organization-authority OIDC grants", () => {
  it("revokes only apps whose claims carry organization/group authority on membership removal", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const organization = (await backend<{ id: string }>(app, "POST", "/v1/organizations", { name: "Acme", created_by: owner.id })).body;
    await backend(app, "POST", `/v1/organizations/${organization.id}/memberships`, { user_id: member.id, role: "org:member" });
    const session = await seedAuth(ctx, member.id, { activeOrganizationId: organization.id });

    const authority = await createApplication(ctx, { name: "Authority", scopes: "openid groups organizations", groupsClaim: "all", redirectUris: [] });
    const unrelated = await createApplication(ctx, { name: "Unrelated", scopes: "openid profile email", redirectUris: [] });
    const groupsNone = await createApplication(ctx, { name: "Groups none", scopes: "openid groups", groupsClaim: "none", redirectUris: [] });
    const authorityGrant = await seedGrant(ctx, authority.row.id, member.id, "authority");
    const unrelatedGrant = await seedGrant(ctx, unrelated.row.id, member.id, "unrelated");
    const noneGrant = await seedGrant(ctx, groupsNone.row.id, member.id, "none");

    const removed = await backend(app, "DELETE", `/v1/organizations/${organization.id}/memberships/${member.id}`);
    expect(removed.status).toBe(200);

    expect((await grantRow(ctx, authorityGrant.id)).revoked).toBe(true);
    expect((await grantRow(ctx, unrelatedGrant.id)).revoked).toBe(false);
    expect((await grantRow(ctx, noneGrant.id)).revoked).toBe(false);
    // Only the OIDC grants end; the browser session stays signed in.
    expect((await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)))[0]!.status).toBe("active");
  });

  it("revokes on a client-side leave without ending the browser session", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner3@acme.test" });
    const member = await seedUser(ctx, { email: "member3@acme.test" });
    const organization = (await backend<{ id: string }>(app, "POST", "/v1/organizations", { name: "Gamma", created_by: owner.id })).body;
    await backend(app, "POST", `/v1/organizations/${organization.id}/memberships`, { user_id: member.id, role: "org:member" });
    const session = await seedAuth(ctx, member.id, { activeOrganizationId: organization.id });
    const application = await createApplication(ctx, { name: "Groups", scopes: "openid organizations", groupsClaim: "all", redirectUris: [] });
    const grant = await seedGrant(ctx, application.row.id, member.id, "client-leave");

    const left = await api(app, "DELETE", `/v1/client/me/organization_memberships/${organization.id}`, { cookie: session.cookie });
    expect(left.status).toBe(200);
    expect((await grantRow(ctx, grant.id)).revoked).toBe(true);
    expect((await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)))[0]!.status).toBe("active");
  });

  it("revokes on a role change and on organization deletion without ending sessions", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner2@acme.test" });
    const member = await seedUser(ctx, { email: "member2@acme.test" });
    const organization = (await backend<{ id: string }>(app, "POST", "/v1/organizations", { name: "Beta", created_by: owner.id })).body;
    await backend(app, "POST", `/v1/organizations/${organization.id}/memberships`, { user_id: member.id, role: "org:admin" });
    const session = await seedAuth(ctx, member.id, { activeOrganizationId: organization.id });
    const application = await createApplication(ctx, { name: "Groups", scopes: "openid groups", groupsClaim: "all", redirectUris: [] });

    const roleChangeGrant = await seedGrant(ctx, application.row.id, member.id, "role-change");
    const demoted = await backend(app, "PATCH", `/v1/organizations/${organization.id}/memberships/${member.id}`, { role: "org:member" });
    expect(demoted.status).toBe(200);
    expect((await grantRow(ctx, roleChangeGrant.id)).revoked).toBe(true);
    expect((await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)))[0]!.status).toBe("active");

    const deletionGrant = await seedGrant(ctx, application.row.id, member.id, "org-deletion");
    const deleted = await backend(app, "DELETE", `/v1/organizations/${organization.id}`);
    expect(deleted.status).toBe(200);
    expect((await grantRow(ctx, deletionGrant.id)).revoked).toBe(true);
    expect((await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, session.sessionId)))[0]!.status).toBe("active");
  });
});
