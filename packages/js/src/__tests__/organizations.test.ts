import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrbitID } from "../orbit";
import {
  ApiMock,
  clearCookies,
  clientJSON,
  environmentJSON,
  fakeJwt,
  membershipJSON,
  organizationJSON,
  publishableKey,
  sessionJSON,
} from "./helpers";

const now = Date.now();

function invitationJSON(overrides: Record<string, unknown> = {}) {
  return {
    object: "organization_invitation",
    id: "orginv_1",
    email_address: "invitee@example.com",
    organization_id: "org_1",
    role: "org:member",
    role_name: "Member",
    status: "pending",
    public_metadata: {},
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function domainJSON(overrides: Record<string, unknown> = {}) {
  return {
    object: "organization_domain",
    id: "orgdmn_1",
    organization_id: "org_1",
    name: "example.com",
    enrollment_mode: "manual_invitation",
    verification: { status: "unverified", strategy: "domain_verification", attempts: 0, expire_at: null },
    affiliation_email_address: null,
    total_pending_invitations: 0,
    total_pending_suggestions: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function roleJSON() {
  return {
    object: "role",
    id: "role_1",
    key: "org:admin",
    name: "Admin",
    description: "Full access",
    is_creator_eligible: true,
    permissions: [
      {
        object: "permission",
        id: "perm_1",
        key: "org:sys_memberships:manage",
        name: "Manage memberships",
        description: "",
        type: "system",
        created_at: now,
        updated_at: now,
      },
    ],
    created_at: now,
    updated_at: now,
  };
}

function suggestionJSON() {
  return {
    object: "organization_suggestion",
    id: "orgsug_1",
    public_organization_data: { id: "org_9", name: "Suggested", slug: "suggested", image_url: "", has_image: false },
    status: "pending",
    created_at: now,
    updated_at: now,
  };
}

function requestJSON(status: "pending" | "accepted" | "rejected") {
  return {
    object: "organization_membership_request",
    id: "orgmreq_1",
    organization_id: "org_1",
    status,
    public_user_data: { user_id: "user_2", first_name: "Grace", last_name: "Hopper", image_url: "", has_image: false, identifier: "grace@example.com" },
    created_at: now,
    updated_at: now,
  };
}

function apiKeyJSON(overrides: Record<string, unknown> = {}) {
  return {
    object: "api_key",
    id: "ak_1",
    name: "CI key",
    description: null,
    subject: "user_1",
    prefix: "ak_live_ab",
    scopes: ["read"],
    claims: null,
    revoked: false,
    expiration: null,
    last_used_at: null,
    created_by: "user_1",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("organizations", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  async function setup() {
    const client = clientJSON({ sessions: [sessionJSON({ last_active_organization_id: "org_1" })], last_active_session_id: "sess_1" });
    const api = new ApiMock((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/client") return { body: { response: client, client } };
      if (key === "GET /v1/client/environment") return { body: { response: environmentJSON() } };
      if (key === "GET /v1/client/organizations/org_1") return { body: { response: organizationJSON() } };
      if (key === "POST /v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt() } };
      if (key === "POST /v1/client/organizations") return { body: { response: organizationJSON({ id: "org_new", name: "New Co", slug: "new-co" }) } };
      if (key === "PATCH /v1/client/organizations/org_1") return { body: { response: organizationJSON({ name: "Acme Renamed" }) } };
      if (key === "DELETE /v1/client/organizations/org_1") return { body: { response: { object: "organization", id: "org_1", deleted: true } } };
      if (key === "GET /v1/client/organizations/org_1/memberships") {
        return { body: { response: { data: [membershipJSON()], total_count: 3 } } };
      }
      if (key === "POST /v1/client/organizations/org_1/memberships") return { body: { response: membershipJSON() } };
      if (key.startsWith("PATCH /v1/client/organizations/org_1/memberships/")) return { body: { response: membershipJSON({ role: "org:member", role_name: "Member" }) } };
      if (key.startsWith("DELETE /v1/client/organizations/org_1/memberships/")) return { body: { response: { object: "organization_membership", id: "orgmem_1", deleted: true } } };
      if (key === "GET /v1/client/organizations/org_1/invitations") return { body: { response: [invitationJSON()] } };
      if (key === "POST /v1/client/organizations/org_1/invitations") {
        if (Array.isArray(call.body?.email_addresses)) {
          return { body: { response: [invitationJSON({ id: "orginv_1" }), invitationJSON({ id: "orginv_2", email_address: "two@example.com" })] } };
        }
        return { body: { response: invitationJSON() } };
      }
      if (key === "POST /v1/client/organizations/org_1/invitations/orginv_1/revoke") return { body: { response: invitationJSON({ status: "revoked" }) } };
      if (key === "GET /v1/client/organizations/org_1/domains") return { body: { response: [domainJSON()] } };
      if (key === "POST /v1/client/organizations/org_1/domains") return { body: { response: domainJSON({ id: "orgdmn_2", name: "acme.com" }) } };
      if (key.endsWith("/prepare_affiliation_verification")) return { body: { response: domainJSON({ affiliation_email_address: "owner@example.com" }) } };
      if (key.endsWith("/attempt_affiliation_verification")) {
        return { body: { response: domainJSON({ verification: { status: "verified", strategy: "domain_verification", attempts: null, expire_at: null } }) } };
      }
      if (key.endsWith("/update_enrollment_mode")) return { body: { response: domainJSON({ enrollment_mode: "automatic_invitation" }) } };
      if (key.startsWith("DELETE /v1/client/organizations/org_1/domains/")) return { body: { response: { object: "organization_domain", id: "orgdmn_1", deleted: true } } };
      if (key === "GET /v1/client/organizations/org_1/membership_requests") return { body: { response: [requestJSON("pending")] } };
      if (key === "POST /v1/client/organizations/org_1/membership_requests") return { body: { response: requestJSON("pending") } };
      if (key.endsWith("/membership_requests/orgmreq_1/accept")) return { body: { response: requestJSON("accepted") } };
      if (key.endsWith("/membership_requests/orgmreq_1/reject")) return { body: { response: requestJSON("rejected") } };
      if (key === "GET /v1/client/organizations/org_1/roles") return { body: { response: [roleJSON()] } };
      if (key === "GET /v1/client/organizations/org_1/billing") {
        return { body: { response: { object: "organization_billing", organization_id: "org_1", portal_url: "https://pay.example.com/acme" } } };
      }
      if (key === "GET /v1/client/me/organization_memberships") return { body: { response: { data: [membershipJSON()], total_count: 2 } } };
      if (key === "DELETE /v1/client/me/organization_memberships/org_1") return { body: { response: { object: "organization_membership", id: "orgmem_1", deleted: true } } };
      if (key === "GET /v1/client/me/organization_invitations") {
        return {
          body: {
            response: [
              invitationJSON({
                organization: organizationJSON(),
                organization_name: "Acme",
                organization_image_url: "https://img.test/acme.png",
              }),
              invitationJSON({ id: "orginv_2", organization: organizationJSON() }),
            ],
          },
        };
      }
      if (key === "POST /v1/client/me/organization_invitations/orginv_1/accept") return { body: { response: invitationJSON({ status: "accepted" }) } };
      if (key === "GET /v1/client/me/organization_suggestions") return { body: { response: [suggestionJSON()] } };
      if (key === "POST /v1/client/me/organization_suggestions/orgsug_1/accept") return { body: { response: suggestionJSON() } };
      if (key === "GET /v1/client/me/api_keys") return { body: { response: { data: [apiKeyJSON()], total_count: 1 } } };
      if (key === "POST /v1/client/me/api_keys") return { body: { response: apiKeyJSON({ secret: "ak_live_secret" }) } };
      if (key === "POST /v1/client/me/api_keys/ak_1/revoke") return { body: { response: apiKeyJSON({ revoked: true }) } };
      if (key === "GET /v1/client/organizations/org_1/api_keys") return { body: { response: { data: [apiKeyJSON()], total_count: 1 } } };
      if (key === "POST /v1/client/organizations/org_1/api_keys") return { body: { response: apiKeyJSON({ subject: "org_1", secret: "ak_live_org" }) } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    return { orbit, api };
  }

  it("creates and fetches organizations", async () => {
    const { orbit, api } = await setup();
    const created = await orbit.createOrganization({ name: "New Co", slug: "new-co" });
    expect(created.id).toBe("org_new");
    expect(api.lastCall("POST", "/v1/client/organizations")?.body).toEqual({ name: "New Co", slug: "new-co" });

    const fetched = await orbit.getOrganization("org_1");
    expect(fetched.slug).toBe("acme");
    expect(orbit.organization?.id).toBe("org_1");
    orbit.dispose();
  });

  it("updates membership lists and roles", async () => {
    const { orbit, api } = await setup();
    const organization = orbit.organization!;
    const memberships = await organization.getMemberships({ limit: 2, offset: 1, role: "org:admin" });
    expect(memberships.totalCount).toBe(3);
    expect(memberships.data[0]?.userId).toBe("user_2");
    expect(memberships.data[0]?.organization.id).toBe("org_1");
    expect(memberships.data[0]?.permissions).toContain("org:sys_memberships:manage");
    const query = api.lastCall("GET", "/v1/client/organizations/org_1/memberships")?.query ?? "";
    expect(query).toContain("limit=2");
    expect(query).toContain("offset=1");
    expect(query).toContain("paginated=true");
    expect(query).toContain("role=org%3Aadmin");

    const added = await organization.addMember({ userId: "user_2", role: "org:admin" });
    expect(api.lastCall("POST", "/v1/client/organizations/org_1/memberships")?.body).toEqual({ user_id: "user_2", role: "org:admin" });
    expect(added.userId).toBe("user_2");

    await added.update({ role: "org:member" });
    expect(api.lastCall("PATCH", "/v1/client/organizations/org_1/memberships/user_2")?.body).toEqual({ role: "org:member" });
    expect(added.role).toBe("org:member");

    await added.destroy();
    expect(api.lastCall("DELETE", "/v1/client/organizations/org_1/memberships/user_2")).toBeDefined();

    const roles = await organization.getRoles();
    expect(roles[0]?.key).toBe("org:admin");
    expect(roles[0]?.permissions[0]?.key).toBe("org:sys_memberships:manage");

    const billing = await organization.getBilling();
    expect(billing).toEqual({ organizationId: "org_1", portalUrl: "https://pay.example.com/acme" });
    orbit.dispose();
  });

  it("invites, lists and revokes organization invitations", async () => {
    const { orbit, api } = await setup();
    const organization = orbit.organization!;
    const invitation = await organization.inviteMember({ emailAddress: "invitee@example.com", role: "org:member", redirectUrl: "/welcome" });
    expect(api.lastCall("POST", "/v1/client/organizations/org_1/invitations")?.body).toEqual({
      email_address: "invitee@example.com",
      role: "org:member",
      redirect_url: "/welcome",
    });
    expect(invitation.status).toBe("pending");
    expect(invitation.organizationId).toBe("org_1");

    const bulk = await organization.inviteMembers({ emailAddresses: ["one@example.com", "two@example.com"], role: "org:member" });
    expect(bulk).toHaveLength(2);
    expect(bulk[1]?.emailAddress).toBe("two@example.com");

    const list = await organization.getInvitations();
    expect(list[0]?.emailAddress).toBe("invitee@example.com");
    await list[0]!.revoke();
    expect(list[0]?.status).toBe("revoked");
    expect(api.lastCall("POST", "/v1/client/organizations/org_1/invitations/orginv_1/revoke")).toBeDefined();
    orbit.dispose();
  });

  it("manages domains, membership requests and roles", async () => {
    const { orbit, api } = await setup();
    const organization = orbit.organization!;
    const domains = await organization.getDomains();
    expect(domains[0]?.name).toBe("example.com");
    expect(domains[0]?.isVerified).toBe(false);

    const created = await organization.createDomain({ name: "acme.com", enrollmentMode: "automatic_invitation" });
    expect(created.id).toBe("orgdmn_2");
    expect(api.lastCall("POST", "/v1/client/organizations/org_1/domains")?.body).toEqual({ name: "acme.com", enrollment_mode: "automatic_invitation" });

    const domain = domains[0]!;
    await domain.prepareAffiliationVerification({ affiliationEmailAddress: "owner@example.com" });
    expect(domain.affiliationEmailAddress).toBe("owner@example.com");
    await domain.attemptAffiliationVerification({ code: "123456" });
    expect(domain.isVerified).toBe(true);
    await domain.updateEnrollmentMode({ enrollmentMode: "automatic_invitation", deletePending: true });
    expect(domain.enrollmentMode).toBe("automatic_invitation");
    await domain.delete();
    expect(api.calls.some((call) => call.method === "DELETE" && call.path === "/v1/client/organizations/org_1/domains/orgdmn_1")).toBe(true);

    const requests = await organization.getMembershipRequests();
    expect(requests[0]?.status).toBe("pending");
    await requests[0]!.accept();
    expect(requests[0]?.status).toBe("accepted");

    const requested = await organization.requestMembership();
    await requested.reject();
    expect(requested.status).toBe("rejected");
    orbit.dispose();
  });

  it("handles user memberships, invitations, suggestions and leaving", async () => {
    const { orbit } = await setup();
    const user = orbit.user!;
    const memberships = await user.getOrganizationMemberships({ limit: 5 });
    expect(memberships.totalCount).toBe(2);
    expect(memberships.data[0]?.organization.slug).toBe("acme");

    const invitations = await user.getOrganizationInvitations();
    expect(invitations[0]?.organization?.id).toBe("org_1");
    expect(invitations[0]?.organizationName).toBe("Acme");
    expect(invitations[0]?.organizationImageUrl).toBe("https://img.test/acme.png");
    // Servers that only embed `organization` still get a label.
    expect(invitations[1]?.organizationName).toBe("Acme");
    await invitations[0]!.accept();
    expect(invitations[0]?.status).toBe("accepted");

    const suggestions = await user.getOrganizationSuggestions();
    expect(suggestions[0]?.publicOrganizationData.name).toBe("Suggested");
    await suggestions[0]!.accept();
    expect(suggestions[0]?.status).toBe("accepted");

    await user.leaveOrganization("org_1");
    orbit.dispose();
  });

  it("supports user and organization API keys", async () => {
    const { orbit } = await setup();
    const list = await orbit.apiKeys.list({ limit: 10 });
    expect(list.totalCount).toBe(1);
    expect(list.data[0]?.prefix).toBe("ak_live_ab");

    const created = await orbit.apiKeys.create({ name: "CI key", scopes: ["read"] });
    expect(created.secret).toBe("ak_live_secret");
    await created.revoke();
    expect(created.revoked).toBe(true);

    const orgList = await orbit.organization!.apiKeys.list();
    expect(orgList.data[0]?.id).toBe("ak_1");
    const orgKey = await orbit.organization!.apiKeys.create({ name: "org key" });
    expect(orgKey.secret).toBe("ak_live_org");
    expect(orgKey.subject).toBe("org_1");
    orbit.dispose();
  });
});
