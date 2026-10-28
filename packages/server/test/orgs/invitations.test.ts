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
import { acceptInvitationByTicket, onUserEmailVerified } from "../../src/services/orgs";
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
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
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

    const invitee = seedUser(ctx, { email: "invitee@acme.test", verified: true });
    const inviteeAuth = seedAuth(ctx, invitee.id);
    const acceptAfterRevoke = await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: inviteeAuth.cookie });
    expect(acceptAfterRevoke.status).toBe(409);
  });

  it("accepts an invitation when the matching email becomes verified", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const invitation = await invite(app, ownerAuth.cookie, org.id, "newcomer@acme.test");

    const newcomer = seedUser(ctx, { email: "newcomer@acme.test", verified: true });
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
    const late = seedUser(ctx, { email: "late@acme.test", verified: true });
    await onUserEmailVerified(ctx, late.id, "late@acme.test");
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === late.id)).toBe(false);
    expect(invitation.id).toBeTruthy();
  });

  it("accepts invitations from the user's own endpoints and via the ticket link", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const invitee = seedUser(ctx, { email: "invitee@acme.test", verified: true });
    const inviteeAuth = seedAuth(ctx, invitee.id);
    const invitation = await invite(app, ownerAuth.cookie, org.id, "invitee@acme.test");

    const mine = await api<{ response: OrganizationInvitationJSON[] }>(app, "GET", "/v1/client/me/organization_invitations", { cookie: inviteeAuth.cookie });
    expect(mine.body.response.map((i) => i.id)).toEqual([invitation.id]);

    // someone else's invitation cannot be accepted
    const stranger = seedUser(ctx, { email: "stranger@acme.test", verified: true });
    const strangerAuth = seedAuth(ctx, stranger.id);
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
    expect(anonymous.headers.get("location")).toContain("__orbit_ticket=");

    // authenticated matching user is joined before the redirect
    const linkUser = seedUser(ctx, { email: "link@acme.test", verified: true });
    const linkAuth = seedAuth(ctx, linkUser.id);
    const authenticated = await api(app, "GET", `/v1/client/organization_invitations/accept?ticket=${encodeURIComponent(ticket2)}`, { cookie: linkAuth.cookie });
    expect(authenticated.status).toBe(302);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === linkUser.id)).toBe(true);

    // service-level ticket acceptance
    const third = await invite(app, ownerAuth.cookie, org.id, "service@acme.test");
    const ticket3 = ticketFromInvitationEmail();
    const serviceUser = seedUser(ctx, { email: "service@acme.test", verified: true });
    await acceptInvitationByTicket(ctx, ticket3, serviceUser.id);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === serviceUser.id)).toBe(true);
    await expect(acceptInvitationByTicket(ctx, "not-a-ticket", serviceUser.id)).rejects.toThrow();
    expect(second.id).toBeTruthy();
    expect(third.id).toBeTruthy();
  });

  it("supports bulk invitations and skips duplicates", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
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
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    await invite(app, ownerAuth.cookie, org.id, "one@acme.test");
    const blocked = await api(app, "POST", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie, body: { email_address: "two@acme.test" } });
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked.body)).toBe("organization_membership_quota_exceeded");
  });
});
