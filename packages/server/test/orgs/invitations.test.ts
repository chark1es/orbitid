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

import type { OrganizationInvitationJSON, OrganizationMembershipJSON } from "@orbitid/shared";
import { acceptInvitation, acceptInvitationByTicket, onUserEmailVerified } from "../../src/services/orgs";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import {
  api, createOrg, errorCode, eventsOf, invite, lastMail, mailOutbox, memberships, seedAuth, seedUser, setup,
} from "./helpers";

function ticketFromInvitationEmail(): string {
  const mail = lastMail("organization_invitation");
  expect(mail).toBeTruthy();
  const url = new URL(String(mail.vars.invitation_url));
  const ticket = url.searchParams.get("ticket");
  expect(ticket).toBeTruthy();
  return ticket!;
}

describe("organization invitations", () => {
  it("creates, lists, revokes and protects invitations", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const invitation = await invite(app, ownerAuth.cookie, org.id, "Invitee@Acme.test", "org:member");
    expect(invitation.email_address).toBe("invitee@acme.test");
    expect(invitation.status).toBe("pending");
    expect(invitation.role).toBe("org:member");
    expect(invitation.role_name).toBe("Member");
    expect("url" in invitation).toBe(false);

    const mail = lastMail("organization_invitation");
    expect(mail.to).toBe("invitee@acme.test");
    expect(String(mail.vars.invitation_url)).toContain("/v1/client/organization_invitations/accept?ticket=");
    expect(mail.vars.organization_name).toBe("Acme");

    // duplicate protection
    const duplicate = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie, body: { email_address: "invitee@acme.test" } });
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe("duplicate_record");

    // invalid role
    const badRole = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie, body: { email_address: "other@acme.test", role: "org:nope" } });
    expect(badRole.status).toBe(422);
    expect(errorCode(badRole.body)).toBe("org_role_not_found");

    const list = await api<{ response: OrganizationInvitationJSON[] }>(app, "GET", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie });
    expect(list.body.response).toHaveLength(1);
    expect(list.body.response[0]!.id).toBe(invitation.id);

    const revoked = await api<{ response: OrganizationInvitationJSON }>(app, "POST", `/v1/client/organizations/${org.id}/invitations/${invitation.id}/revoke`, { cookie: ownerAuth.cookie });
    expect(revoked.status).toBe(200);
    expect(revoked.body.response.status).toBe("revoked");
    expect(eventsOf("organizationInvitation.revoked")).toHaveLength(1);

    const invitee = await seedUser(ctx, { email: "invitee@acme.test", verified: true });
    const inviteeAuth = await seedAuth(ctx, invitee.id);
    const acceptAfterRevoke = await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: inviteeAuth.cookie });
    expect(acceptAfterRevoke.status).toBe(409);
  });

  it("accepts an invitation when the matching email becomes verified", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const invitation = await invite(app, ownerAuth.cookie, org.id, "newcomer@acme.test");

    const newcomer = await seedUser(ctx, { email: "newcomer@acme.test", verified: true });
    await onUserEmailVerified(ctx, newcomer.id, "newcomer@acme.test");

    const list = await memberships(app, ownerAuth.cookie, org.id);
    expect(list.some((m) => m.public_user_data.user_id === newcomer.id)).toBe(true);
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    expect(eventsOf("organizationMembership.created")).toHaveLength(2); // creator + newcomer

    // idempotent: verifying again does not duplicate or fail
    await onUserEmailVerified(ctx, newcomer.id, "newcomer@acme.test");
    expect((await memberships(app, ownerAuth.cookie, org.id)).filter((m) => m.public_user_data.user_id === newcomer.id)).toHaveLength(1);

    // a revoked invitation is not accepted on verification
    const second = await invite(app, ownerAuth.cookie, org.id, "late@acme.test");
    await api(app, "POST", `/v1/client/organizations/${org.id}/invitations/${second.id}/revoke`, { cookie: ownerAuth.cookie });
    const late = await seedUser(ctx, { email: "late@acme.test", verified: true });
    await onUserEmailVerified(ctx, late.id, "late@acme.test");
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === late.id)).toBe(false);
    expect(invitation.id).toBeTruthy();
  });

  it("accepts invitations from the user's own endpoints and via the ticket link", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const invitee = await seedUser(ctx, { email: "invitee@acme.test", verified: true });
    const inviteeAuth = await seedAuth(ctx, invitee.id);
    const invitation = await invite(app, ownerAuth.cookie, org.id, "invitee@acme.test");

    const mine = await api<{ response: OrganizationInvitationJSON[] }>(app, "GET", "/v1/client/me/organization_invitations", { cookie: inviteeAuth.cookie });
    expect(mine.body.response.map((i) => i.id)).toEqual([invitation.id]);

    // someone else's invitation cannot be accepted
    const stranger = await seedUser(ctx, { email: "stranger@acme.test", verified: true });
    const strangerAuth = await seedAuth(ctx, stranger.id);
    const stolen = await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: strangerAuth.cookie });
    expect(stolen.status).toBe(403);

    const accepted = await api<{ response: OrganizationMembershipJSON }>(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: inviteeAuth.cookie });
    expect(accepted.status).toBe(200);
    expect(accepted.body.response.organization.id).toBe(org.id);
    expect(accepted.body.response.role).toBe("org:member");
    expect(accepted.body.response.permissions).toContain("org:sys_memberships:read");

    // ticket link: unauthenticated → redirect carrying the ticket, no membership
    const ticket = ticketFromInvitationEmail();
    const second = await invite(app, ownerAuth.cookie, org.id, "link@acme.test");
    const ticket2 = ticketFromInvitationEmail();
    expect(ticket).toBeTruthy();

    const anonymous = await api(app, "GET", `/v1/client/organization_invitations/accept?ticket=${encodeURIComponent(ticket2)}`);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).not.toContain("__orbit_ticket=");

    // the ticket is never sent to an origin the instance does not trust
    const hostile = await api(app, "GET", `/v1/client/organization_invitations/accept?ticket=${encodeURIComponent(ticket2)}&redirect_url=${encodeURIComponent("https://evil.example/steal")}`);
    expect(hostile.status).toBe(422);
    expect(hostile.headers.get("location")).toBeNull();

    // authenticated matching user is joined before the redirect
    const linkUser = await seedUser(ctx, { email: "link@acme.test", verified: true });
    const linkAuth = await seedAuth(ctx, linkUser.id);
    const authenticated = await api(app, "GET", `/v1/client/organization_invitations/accept?ticket=${encodeURIComponent(ticket2)}`, { cookie: linkAuth.cookie });
    expect(authenticated.status).toBe(302);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === linkUser.id)).toBe(true);

    // service-level ticket acceptance
    const third = await invite(app, ownerAuth.cookie, org.id, "service@acme.test");
    const ticket3 = ticketFromInvitationEmail();
    const serviceUser = await seedUser(ctx, { email: "service@acme.test", verified: true });
    await acceptInvitationByTicket(ctx, ticket3, serviceUser.id);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === serviceUser.id)).toBe(true);
    await expect(acceptInvitationByTicket(ctx, "not-a-ticket", serviceUser.id)).rejects.toThrow();
    expect(second.id).toBeTruthy();
    expect(third.id).toBeTruthy();
  });

  it("supports bulk invitations and skips duplicates", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const before = mailOutbox.length;
    const bulk = await api<{ response: OrganizationInvitationJSON[] }>(app, "POST", `/v1/client/organizations/${org.id}/invitations`, {
      cookie: ownerAuth.cookie,
      body: { email_addresses: ["a@acme.test", "b@acme.test"], role: "org:admin" },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.response).toHaveLength(2);
    expect(bulk.body.response.every((i) => i.role === "org:admin")).toBe(true);
    expect(mailOutbox.length - before).toBe(2);

    const again = await api<{ response: OrganizationInvitationJSON[] }>(app, "POST", `/v1/client/organizations/${org.id}/invitations`, {
      cookie: ownerAuth.cookie,
      body: { email_addresses: ["a@acme.test", "b@acme.test"] },
    });
    expect(again.body.response).toHaveLength(0);
  });

  it("counts pending invitations against the organization membership limit", async () => {
    const { ctx, app } = await setup({ organizations: { maxAllowedMemberships: 2 } });
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    await invite(app, ownerAuth.cookie, org.id, "one@acme.test");
    const blocked = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie, body: { email_address: "two@acme.test" } });
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked.body)).toBe("organization_membership_quota_exceeded");
  });

  it("does not create a membership for an invitation revoked after it was read", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const invitee = await seedUser(ctx, { email: "late@acme.test" });
    const created = await invite(app, ownerAuth.cookie, org.id, "late@acme.test", "org:member");

    const stale = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    await ctx.db.update(schema.organizationInvitations).set({ status: "revoked" }).where(eq(schema.organizationInvitations.id, created.id));

    expect(await acceptInvitation(ctx, stale, invitee.id)).toBeNull();
    expect((await ctx.db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, invitee.id))).length).toBe(0);
    expect(eventsOf("organizationMembership.created")).toHaveLength(1); // the owner only
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(0);
  });

  it("keeps the invitation pending when the organization is full", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const created = await invite(app, ownerAuth.cookie, org.id, "full@acme.test");
    const invitee = await seedUser(ctx, { email: "full@acme.test", verified: true });

    // The invitation was issued while there was room; the organization filled up since.
    await ctx.db.update(schema.organizations).set({ maxAllowedMemberships: 1 }).where(eq(schema.organizations.id, org.id));
    const stale = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    await expect(acceptInvitation(ctx, stale, invitee.id)).rejects.toMatchObject({ code: "organization_membership_quota_exceeded" });

    const invitation = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    expect(invitation.status).toBe("pending");
    expect(await ctx.db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, invitee.id))).toHaveLength(0);
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(0);

    // Once there is room again the same invitation can be accepted.
    await ctx.db.update(schema.organizations).set({ maxAllowedMemberships: 5 }).where(eq(schema.organizations.id, org.id));
    const retry = await acceptInvitation(ctx, invitation, invitee.id);
    expect(retry?.userId).toBe(invitee.id);
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
  });

  it("is idempotent when the same invitation is accepted twice", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const created = await invite(app, ownerAuth.cookie, org.id, "twice@acme.test");
    const invitee = await seedUser(ctx, { email: "twice@acme.test", verified: true });

    const fresh = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    const firstResult = await acceptInvitation(ctx, fresh, invitee.id);
    // A second caller that read the invitation before the first one finished holds the same stale row.
    const secondResult = await acceptInvitation(ctx, fresh, invitee.id);

    expect(firstResult?.id).toBe(secondResult?.id);
    expect(await ctx.db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, invitee.id))).toHaveLength(1);
    expect(eventsOf("organizationMembership.created")).toHaveLength(2); // owner + invitee, once each
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    const invitation = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    expect(invitation.status).toBe("accepted");
  });

  it("recovers from a crash between the membership insert and the status flip", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const created = await invite(app, ownerAuth.cookie, org.id, "crash@acme.test");
    const invitee = await seedUser(ctx, { email: "crash@acme.test", verified: true });
    const invitation = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;

    // Simulate a process killed right after the membership INSERT: the flip never runs.
    const real = ctx.db;
    let armed = true;
    const crashy = new Proxy(real as never, {
      get(target, prop, receiver) {
        if (prop === "update" && armed) {
          return (table: unknown) => {
            if (table === schema.organizationInvitations) {
              armed = false;
              throw new Error("simulated process death");
            }
            return (target as unknown as { update(table: unknown): unknown }).update(table);
          };
        }
        const value = Reflect.get(target as object, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(ctx, "db", { value: crashy, configurable: true });
    await expect(acceptInvitation(ctx, invitation, invitee.id)).rejects.toThrow("simulated process death");
    Object.defineProperty(ctx, "db", { value: real, configurable: true });

    // The damaged state: a membership exists, the invitation is still pending, nothing was announced.
    const membershipsAfterCrash = await ctx.db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, invitee.id));
    expect(membershipsAfterCrash).toHaveLength(1);
    expect((await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!.status).toBe("pending");
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(0);
    expect(eventsOf("organizationMembership.created")).toHaveLength(1); // the owner only

    // A retry reuses the orphaned membership and completes the acceptance.
    const pending = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;
    const retried = await acceptInvitation(ctx, pending, invitee.id);
    expect(retried?.id).toBe(membershipsAfterCrash[0]!.id);
    expect((await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!.status).toBe("accepted");
    expect(await ctx.db.select().from(schema.organizationMemberships).where(eq(schema.organizationMemberships.userId, invitee.id))).toHaveLength(1);
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    // The retry reused the membership instead of creating it, so it does not announce creation again; the
    // alternative (announcing on reuse) would double up for parallel accepts.
    expect(eventsOf("organizationMembership.created")).toHaveLength(1);
  });

  it("creates the membership before it consumes the invitation", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const created = await invite(app, ownerAuth.cookie, org.id, "order@acme.test");
    const invitee = await seedUser(ctx, { email: "order@acme.test", verified: true });
    const invitation = (await ctx.db.select().from(schema.organizationInvitations).where(eq(schema.organizationInvitations.id, created.id)))[0]!;

    // Observe the order of writes: the membership INSERT must precede the invitation UPDATE, so a crash
    // in between can never leave an accepted invitation without a membership.
    const order: string[] = [];
    const real = ctx.db;
    const observed = new Proxy(real as never, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === schema.organizationMemberships) order.push("membership");
            return (target as unknown as { insert(table: unknown): unknown }).insert(table);
          };
        }
        if (prop === "update") {
          return (table: unknown) => {
            if (table === schema.organizationInvitations) order.push("invitation");
            return (target as unknown as { update(table: unknown): unknown }).update(table);
          };
        }
        const value = Reflect.get(target as object, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    Object.defineProperty(ctx, "db", { value: observed, configurable: true });
    await acceptInvitation(ctx, invitation, invitee.id);
    Object.defineProperty(ctx, "db", { value: real, configurable: true });

    expect(order).toEqual(["membership", "invitation"]);
    // The membership webhook is emitted only after the gate passed.
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    expect(eventsOf("organizationMembership.created")).toHaveLength(2);
  });

  it("treats an idle session as signed out on organization routes", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "idle@acme.test" });
    const auth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, auth.cookie, "Idle Co");
    await ctx.settings.update({ session: { inactivityTimeoutSeconds: 60 } });
    await ctx.db.update(schema.sessions).set({ lastActiveAt: Date.now() - 120_000 }).where(eq(schema.sessions.id, auth.sessionId));

    const res = await api(app, "PATCH", `/v1/client/organizations/${org.id}`, { cookie: auth.cookie, body: { name: "Renamed" } });
    expect(res.status).toBe(401);
  });
});
