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
  OrganizationDomainJSON, OrganizationInvitationJSON, OrganizationMembershipJSON, OrganizationMembershipRequestJSON, OrganizationSuggestionJSON,
} from "@orbitid/shared";
import { onUserEmailVerified } from "../../src/services/orgs";
import {
  api, createOrg, errorCode, eventsOf, invite, lastMail, memberships, seedAuth, seedUser, setup,
} from "./helpers";

const codeFromMail = () => String(lastMail("domain_verification_code").vars.code);

async function addDomain(
  app: Parameters<typeof api>[0], cookie: string, orgId: string, name: string, enrollmentMode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion",
) {
  const res = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${orgId}/domains`, {
    cookie, body: { name, enrollment_mode: enrollmentMode },
  });
  expect(res.status).toBe(200);
  return res.body.response;
}

async function verifyDomain(
  app: Parameters<typeof api>[0], cookie: string, orgId: string, domain: OrganizationDomainJSON, affiliation = `admin@${domain.name}`,
) {
  const prepared = await api(app, "POST", `/v1/client/organizations/${orgId}/domains/${domain.id}/prepare_affiliation_verification`, {
    cookie, body: { affiliation_email_address: affiliation },
  });
  expect(prepared.status).toBe(200);
  const code = codeFromMail();
  const attempted = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${orgId}/domains/${domain.id}/attempt_affiliation_verification`, {
    cookie, body: { code },
  });
  expect(attempted.status).toBe(200);
  expect(attempted.body.response.verification?.status).toBe("verified");
  return attempted.body.response;
}

describe("organization domains", () => {
  it("adds a domain, sends and verifies the affiliation code", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "Acme-Test.com", "manual_invitation");
    expect(domain.name).toBe("acme-test.com");
    expect(domain.verification?.status).toBe("unverified");
    expect(domain.enrollment_mode).toBe("manual_invitation");

    const dnsLookalike = await api(app, "POST", `/v1/client/organizations/${org.id}/domains`, { cookie: ownerAuth.cookie, body: { name: "not a domain" } });
    expect(dnsLookalike.status).toBe(422);
    const duplicate = await api(app, "POST", `/v1/client/organizations/${org.id}/domains`, { cookie: ownerAuth.cookie, body: { name: "acme-test.com" } });
    expect(duplicate.status).toBe(409);

    const mismatch = await api(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.id}/prepare_affiliation_verification`, {
      cookie: ownerAuth.cookie, body: { affiliation_email_address: "admin@other.com" },
    });
    expect(mismatch.status).toBe(422);
    expect(errorCode(mismatch.body)).toBe("form_param_value_invalid");

    const prepared = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.id}/prepare_affiliation_verification`, {
      cookie: ownerAuth.cookie, body: { affiliation_email_address: "Admin@Acme-Test.com" },
    });
    expect(prepared.status).toBe(200);
    expect(prepared.body.response.affiliation_email_address).toBe("admin@acme-test.com");
    const mail = lastMail("domain_verification_code");
    expect(mail.to).toBe("admin@acme-test.com");
    const code = String(mail.vars.code);

    const wrong = await api(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.id}/attempt_affiliation_verification`, {
      cookie: ownerAuth.cookie, body: { code: code === "000000" ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(422);
    expect(errorCode(wrong.body)).toBe("form_code_incorrect");

    const verified = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.id}/attempt_affiliation_verification`, {
      cookie: ownerAuth.cookie, body: { code },
    });
    expect(verified.status).toBe(200);
    expect(verified.body.response.verification?.status).toBe("verified");
    expect(eventsOf("organizationDomain.created")).toHaveLength(1);
    expect(eventsOf("organizationDomain.updated")).toHaveLength(1);

    const removed = await api(app, "DELETE", `/v1/client/organizations/${org.id}/domains/${domain.id}`, { cookie: ownerAuth.cookie });
    expect(removed.status).toBe(200);
    expect(eventsOf("organizationDomain.deleted")).toHaveLength(1);
  });

  it("auto-joins existing and future users for automatic_invitation domains", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const existing = seedUser(ctx, { email: "existing@auto.test", verified: true });
    seedUser(ctx, { email: "unverified@auto.test", verified: false });
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "auto.test", "automatic_invitation");
    await verifyDomain(app, ownerAuth.cookie, org.id, domain);

    const list = await memberships(app, ownerAuth.cookie, org.id);
    expect(list.some((m) => m.public_user_data.user_id === existing.id)).toBe(true);
    expect(list).toHaveLength(2); // creator + existing verified user (unverified email does not qualify)

    const newcomer = seedUser(ctx, { email: "newcomer@auto.test", verified: true });
    await onUserEmailVerified(ctx, newcomer.id, "newcomer@auto.test");
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === newcomer.id)).toBe(true);
  });

  it("does not auto-join for manual_invitation domains", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "manual.test", "manual_invitation");
    await verifyDomain(app, ownerAuth.cookie, org.id, domain);

    const user = seedUser(ctx, { email: "person@manual.test", verified: true });
    await onUserEmailVerified(ctx, user.id, "person@manual.test");
    const list = await memberships(app, ownerAuth.cookie, org.id);
    expect(list.some((m) => m.public_user_data.user_id === user.id)).toBe(false);
  });

  it("offers suggestions for automatic_suggestion domains and lets users join", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Suggestion Inc");
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "suggest.test", "automatic_suggestion");
    await verifyDomain(app, ownerAuth.cookie, org.id, domain);

    const user = seedUser(ctx, { email: "person@suggest.test", verified: true });
    const userAuth = seedAuth(ctx, user.id);

    const suggestions = await api<{ response: OrganizationSuggestionJSON[] }>(app, "GET", "/v1/client/me/organization_suggestions", { cookie: userAuth.cookie });
    expect(suggestions.body.response).toHaveLength(1);
    expect(suggestions.body.response[0]!.public_organization_data.id).toBe(org.id);
    expect(suggestions.body.response[0]!.status).toBe("pending");

    const accepted = await api<{ response: OrganizationMembershipJSON }>(app, "POST", `/v1/client/me/organization_suggestions/${suggestions.body.response[0]!.id}/accept`, { cookie: userAuth.cookie });
    expect(accepted.status).toBe(200);
    expect(accepted.body.response.organization.id).toBe(org.id);

    const after = await api<{ response: OrganizationSuggestionJSON[] }>(app, "GET", "/v1/client/me/organization_suggestions", { cookie: userAuth.cookie });
    expect(after.body.response).toHaveLength(0);

    // joining a suggested organization through /me/organization_memberships
    const colleague = seedUser(ctx, { email: "colleague@suggest.test", verified: true });
    const colleagueAuth = seedAuth(ctx, colleague.id);
    const joined = await api<{ response: OrganizationMembershipJSON }>(app, "POST", "/v1/client/me/organization_memberships", { cookie: colleagueAuth.cookie, body: { organization_id: org.id } });
    expect(joined.status).toBe(200);
    expect(joined.body.response.organization.id).toBe(org.id);
    const duplicateJoin = await api(app, "POST", "/v1/client/me/organization_memberships", { cookie: colleagueAuth.cookie, body: { organization_id: org.id } });
    expect(duplicateJoin.status).toBe(409);
  });

  it("handles membership requests from suggestion domains", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Requests Inc");
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "requests.test", "automatic_suggestion");
    await verifyDomain(app, ownerAuth.cookie, org.id, domain);

    const applicant = seedUser(ctx, { email: "applicant@requests.test", verified: true });
    const applicantAuth = seedAuth(ctx, applicant.id);
    const request = await api<{ response: OrganizationMembershipRequestJSON }>(app, "POST", `/v1/client/organizations/${org.id}/membership_requests`, { cookie: applicantAuth.cookie });
    expect(request.status).toBe(200);
    expect(request.body.response.status).toBe("pending");
    expect(request.body.response.public_user_data.user_id).toBe(applicant.id);

    const duplicate = await api<{ response: OrganizationMembershipRequestJSON }>(app, "POST", `/v1/client/organizations/${org.id}/membership_requests`, { cookie: applicantAuth.cookie });
    expect(duplicate.body.response.id).toBe(request.body.response.id);

    const pending = await api<{ response: OrganizationMembershipRequestJSON[] }>(app, "GET", `/v1/client/organizations/${org.id}/membership_requests?status=pending`, { cookie: ownerAuth.cookie });
    expect(pending.body.response).toHaveLength(1);

    const accepted = await api<{ response: OrganizationMembershipJSON }>(app, "POST", `/v1/client/organizations/${org.id}/membership_requests/${request.body.response.id}/accept`, { cookie: ownerAuth.cookie });
    expect(accepted.status).toBe(200);
    expect(accepted.body.response.public_user_data.user_id).toBe(applicant.id);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === applicant.id)).toBe(true);

    // a user from an unrelated domain cannot request membership
    const outsider = seedUser(ctx, { email: "outsider@elsewhere.test", verified: true });
    const outsiderAuth = seedAuth(ctx, outsider.id);
    const blocked = await api(app, "POST", `/v1/client/organizations/${org.id}/membership_requests`, { cookie: outsiderAuth.cookie });
    expect(blocked.status).toBe(403);

    // rejection path
    const rejectee = seedUser(ctx, { email: "rejectee@requests.test", verified: true });
    const rejecteeAuth = seedAuth(ctx, rejectee.id);
    const toReject = await api<{ response: OrganizationMembershipRequestJSON }>(app, "POST", `/v1/client/organizations/${org.id}/membership_requests`, { cookie: rejecteeAuth.cookie });
    const rejected = await api<{ response: OrganizationMembershipRequestJSON }>(app, "POST", `/v1/client/organizations/${org.id}/membership_requests/${toReject.body.response.id}/reject`, { cookie: ownerAuth.cookie });
    expect(rejected.body.response.status).toBe("rejected");
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === rejectee.id)).toBe(false);
  });

  it("changes enrollment mode and deletes pending invitations on request", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Switch Inc");
    const domain = await addDomain(app, ownerAuth.cookie, org.id, "switch.test", "manual_invitation");
    await verifyDomain(app, ownerAuth.cookie, org.id, domain);

    const member = seedUser(ctx, { email: "member@switch.test", verified: true });
    const invitation = await invite(app, ownerAuth.cookie, org.id, "pending@switch.test");
    expect(invitation.status).toBe("pending");

    const updated = await api<{ response: OrganizationDomainJSON }>(app, "POST", `/v1/client/organizations/${org.id}/domains/${domain.id}/update_enrollment_mode`, {
      cookie: ownerAuth.cookie, body: { enrollment_mode: "automatic_invitation", delete_pending: true },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.response.enrollment_mode).toBe("automatic_invitation");

    const invitations = await api<{ response: OrganizationInvitationJSON[] }>(app, "GET", `/v1/client/organizations/${org.id}/invitations`, { cookie: ownerAuth.cookie });
    expect(invitations.body.response).toHaveLength(0);
    expect((await memberships(app, ownerAuth.cookie, org.id)).some((m) => m.public_user_data.user_id === member.id)).toBe(true);
  });

  it("is gated by settings.organizations.domainsEnabled", async () => {
    const { ctx, app } = await setup({ organizations: { domainsEnabled: false } });
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const res = await api(app, "POST", `/v1/client/organizations/${org.id}/domains`, { cookie: ownerAuth.cookie, body: { name: "acme.test" } });
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("not_allowed_access");
  });
});
