import { describe, expect, it } from "vitest";
import { createOrbitIdClient, type PasswordHasher } from "../src/client";
import { OrbitIdAPIError, isOrbitIdAPIError } from "../src/errors";

interface RecordedCall {
  url: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

class MockBackend {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly handler: Handler) {}

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    let body: unknown;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    const call: RecordedCall = {
      url: input,
      method: init.method ?? "GET",
      path: url.pathname,
      query: url.search,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    };
    this.calls.push(call);
    const result = await this.handler(call);
    const status = result.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(result.body ?? null), { status, headers: { "content-type": "application/json" } });
  };

  last(method: string, path: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((call) => call.method === method && call.path === path);
  }
}

const API_URL = "https://auth.example.com";

function client(handler: Handler) {
  const backend = new MockBackend(handler);
  const orbit = createOrbitIdClient({ secretKey: "sk_test_123", apiUrl: API_URL, fetch: backend.fetch });
  return { orbit, backend };
}

describe("createOrbitIdClient", () => {
  it("authenticates with the secret key and maps snake_case to camelCase", async () => {
    const { orbit, backend } = client((call) => {
      if (call.path === "/v1/users/user_1") {
        return {
          body: {
            object: "user",
            id: "user_1",
            first_name: "Ada",
            last_name: "Lovelace",
            primary_email_address_id: "idn_e1",
            email_addresses: [{ object: "email_address", id: "idn_e1", email_address: "ada@example.com", created_at: 1, updated_at: 1 }],
            public_metadata: { snake_key: "untouched", nested_thing: { also_snake: true } },
            created_at: 1,
            updated_at: 1,
          },
        };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });

    const user = await orbit.users.getUser("user_1");
    expect(backend.last("GET", "/v1/users/user_1")?.headers.Authorization).toBe("Bearer sk_test_123");
    expect(user.firstName).toBe("Ada");
    expect(user.primaryEmailAddressId).toBe("idn_e1");
    expect(user.emailAddresses[0]?.emailAddress).toBe("ada@example.com");
    expect(user.publicMetadata).toEqual({ snake_key: "untouched", nested_thing: { also_snake: true } });
    expect(orbit.apiUrl).toBe(API_URL);
  });

  it("maps paginated lists and serialises list filters", async () => {
    const { orbit, backend } = client((call) => ({
      body: { data: [{ object: "user", id: "user_1", first_name: "Ada" }, { object: "user", id: "user_2", first_name: "Grace" }], total_count: 42 },
    }));
    const result = await orbit.users.getUserList({
      limit: 10,
      offset: 20,
      emailAddress: ["a@example.com", "b@example.com"],
      username: ["ada"],
      orderBy: "-created_at",
    });
    expect(result.totalCount).toBe(42);
    expect(result.data.map((user) => user.id)).toEqual(["user_1", "user_2"]);
    const query = backend.last("GET", "/v1/users")?.query ?? "";
    expect(query).toContain("limit=10");
    expect(query).toContain("offset=20");
    expect(query).toContain("order_by=-created_at");
    expect(query).toContain("email_address=a%40example.com");
    expect(query).toContain("email_address=b%40example.com");
    expect(query).toContain("username=ada");
    expect(query).toContain("paginated=true");
  });

  it("sends snake_case bodies without touching metadata payloads", async () => {
    const { orbit, backend } = client(() => ({ body: { object: "user", id: "user_9", first_name: "Ada" } }));
    await orbit.users.createUser({
      emailAddress: ["ada@example.com"],
      firstName: "Ada",
      password: "secret",
      publicMetadata: { keep_me: { nested_ok: 1 } },
      privateMetadata: { internal_flag: true },
    });
    const body = backend.last("POST", "/v1/users")?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      email_address: ["ada@example.com"],
      first_name: "Ada",
      password: "secret",
      public_metadata: { keep_me: { nested_ok: 1 } },
      private_metadata: { internal_flag: true },
    });
  });

  it("covers organization, session, invitation and api-key endpoints", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/organizations") return { body: { data: [{ id: "org_1", name: "Acme", slug: "acme", members_count: 3 }], total_count: 1 } };
      if (key === "POST /v1/organizations") return { body: { id: "org_2", name: "New", slug: "new" } };
      if (key === "PATCH /v1/organizations/org_1/memberships/user_2") return { body: { id: "orgmem_1", role: "org:member", public_user_data: { user_id: "user_2" } } };
      if (key === "POST /v1/organizations/org_1/invitations") return { body: { id: "orginv_1", email_address: "x@example.com", role: "org:member", status: "pending" } };
      if (key === "POST /v1/organizations/org_1/invitations/orginv_1/revoke") return { body: { id: "orginv_1", status: "revoked" } };
      if (key === "GET /v1/organizations/org_1/roles") return { body: { data: [{ id: "role_1", key: "org:admin", permissions: [{ key: "org:sys_memberships:manage" }] }], total_count: 1 } };
      if (key === "POST /v1/sessions/sess_1/tokens") return { body: { jwt: "session.jwt.token" } };
      if (key === "POST /v1/sessions/sess_1/tokens/custom") return { body: { jwt: "custom.jwt.token" } };
      if (key === "POST /v1/api_keys/verify") return { body: { id: "ak_1", subject: "user_1", scopes: ["read"] } };
      if (key === "GET /v1/users/user_1/organization_memberships") return { body: { data: [{ id: "orgmem_1", role: "org:admin" }], total_count: 1 } };
      if (key === "GET /v1/users/count") return { body: { total_count: 7 } };
      if (key === "GET /v1/webhooks/endpoints") return { body: { data: [{ id: "we_1", url: "https://app/hook", event_types: ["user.created"] }], total_count: 1 } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const organizations = await orbit.organizations.getOrganizationList({ limit: 5, includeMembersCount: true });
    expect(organizations.data[0]?.membersCount).toBe(3);
    expect(backend.last("GET", "/v1/organizations")?.query).toContain("include_members_count=true");

    const created = await orbit.organizations.createOrganization({ name: "New", slug: "new" });
    expect(created.id).toBe("org_2");

    const membership = await orbit.organizations.updateOrganizationMembership({ organizationId: "org_1", userId: "user_2", role: "org:member" });
    expect(membership.publicUserData.userId).toBe("user_2");
    expect(backend.last("PATCH", "/v1/organizations/org_1/memberships/user_2")?.body).toEqual({ role: "org:member" });

    const invitation = await orbit.organizations.createOrganizationInvitation({
      organizationId: "org_1",
      emailAddress: "x@example.com",
      role: "org:member",
      redirectUrl: "/welcome",
    });
    expect(invitation.emailAddress).toBe("x@example.com");
    const invitationBody = backend.last("POST", "/v1/organizations/org_1/invitations")?.body as Record<string, unknown>;
    expect(invitationBody).toEqual({ email_address: "x@example.com", role: "org:member", redirect_url: "/welcome" });
    expect(invitationBody.organization_id).toBeUndefined();

    const revoked = await orbit.organizations.revokeOrganizationInvitation({ organizationId: "org_1", invitationId: "orginv_1" });
    expect(revoked.status).toBe("revoked");

    const roles = await orbit.organizations.getOrganizationRoleList({ organizationId: "org_1" });
    expect(roles.data[0]?.permissions[0]?.key).toBe("org:sys_memberships:manage");

    expect((await orbit.sessions.getToken("sess_1")).jwt).toBe("session.jwt.token");
    expect((await orbit.sessions.getToken("sess_1", { template: "custom" })).jwt).toBe("custom.jwt.token");
    // Possession of the session is forwarded so the server can refuse a bare secret key.
    await orbit.sessions.getToken("sess_1", { sessionToken: "user.jwt.token" });
    expect(backend.last("POST", "/v1/sessions/sess_1/tokens")?.headers["X-OrbitID-Session-Token"]).toBe("user.jwt.token");

    expect((await orbit.apiKeys.verifyApiKey({ secret: "ak_live_x" })).subject).toBe("user_1");
    expect(backend.last("POST", "/v1/api_keys/verify")?.body).toEqual({ secret: "ak_live_x" });

    const memberships = await orbit.users.getUserOrganizationMembershipList({ userId: "user_1" });
    expect(memberships.data[0]?.role).toBe("org:admin");

    expect((await orbit.users.getCount({ emailAddress: ["a@example.com"] })).totalCount).toBe(7);

    const endpoints = await orbit.webhooks.getWebhookEndpointList();
    expect(endpoints.data[0]?.eventTypes).toEqual(["user.created"]);
  });

  it("creates a user with a password digest and its typed hasher", async () => {
    const { orbit, backend } = client(() => ({ body: { object: "user", id: "user_9", first_name: "Ada" } }));
    const hashers: PasswordHasher[] = ["bcrypt", "argon2", "scrypt"];
    expect(hashers).toEqual(["bcrypt", "argon2", "scrypt"]);
    // The server refuses a digest without the hasher that produced it.
    await orbit.users.createUser({
      emailAddress: ["ada@example.com"],
      passwordDigest: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
      passwordHasher: "argon2",
    });
    expect(backend.last("POST", "/v1/users")?.body).toEqual({
      email_address: ["ada@example.com"],
      password_digest: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
      password_hasher: "argon2",
    });
  });

  it("covers organization membership request create, accept and reject", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "POST /v1/organizations/org_1/membership_requests") {
        return { body: { object: "organization_membership_request", id: "orgreq_1", organization_id: "org_1", status: "pending", public_user_data: { user_id: "user_2" } } };
      }
      if (key === "POST /v1/organizations/org_1/membership_requests/orgreq_1/accept") {
        return { body: { object: "organization_membership", id: "orgmem_1", role: "org:member", public_user_data: { user_id: "user_2" } } };
      }
      if (key === "POST /v1/organizations/org_1/membership_requests/orgreq_1/reject") {
        return { body: { object: "organization_membership_request", id: "orgreq_1", organization_id: "org_1", status: "rejected", public_user_data: { user_id: "user_2" } } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const request = await orbit.organizations.createOrganizationMembershipRequest({ organizationId: "org_1", userId: "user_2" });
    expect(request.status).toBe("pending");
    expect(request.publicUserData.userId).toBe("user_2");
    expect(backend.last("POST", "/v1/organizations/org_1/membership_requests")?.body).toEqual({ user_id: "user_2" });

    const membership = await orbit.organizations.acceptOrganizationMembershipRequest({ organizationId: "org_1", requestId: "orgreq_1" });
    expect(membership.publicUserData.userId).toBe("user_2");

    const rejected = await orbit.organizations.rejectOrganizationMembershipRequest({ organizationId: "org_1", requestId: "orgreq_1" });
    expect(rejected.status).toBe("rejected");
  });

  it("lists and revokes a user's trusted devices", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/users/user_1/trusted_devices") {
        return { body: [{ object: "trusted_device", id: "tdev_1", user_id: "user_1", label: "Chrome", expires_at: 123 }] };
      }
      if (key === "DELETE /v1/users/user_1/trusted_devices/tdev_1") {
        return { body: { object: "trusted_device", id: "tdev_1", deleted: true } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const devices = await orbit.users.getUserTrustedDeviceList({ userId: "user_1" });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe("Chrome");
    expect(devices[0]?.userId).toBe("user_1");

    const removed = await orbit.users.revokeUserTrustedDevice({ userId: "user_1", deviceId: "tdev_1" });
    expect(removed.deleted).toBe(true);
  });

  it("rotates the signing key and configures custom JWT template signing", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "POST /v1/instance/signing_keys/rotate") {
        return { body: { object: "signing_key", kid: "key_2", algorithm: "RS256", active: true } };
      }
      if (key === "POST /v1/jwt_templates") {
        return { body: { object: "jwt_template", id: "jwt_1", name: "custom", custom_signing_key: true, signing_algorithm: "HS256", signing_key: "secret" } };
      }
      if (key === "PATCH /v1/jwt_templates/jwt_1") {
        return { body: { object: "jwt_template", id: "jwt_1", name: "custom", custom_signing_key: true, signing_algorithm: "RS256", signing_key: { kty: "RSA" } } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const rotated = await orbit.instance.rotateSigningKey();
    expect(rotated).toEqual({ object: "signing_key", kid: "key_2", algorithm: "RS256", active: true });

    const created = await orbit.jwtTemplates.createJwtTemplate({ name: "custom", claims: { plan: "pro" }, customSigningKey: true, signingAlgorithm: "HS256" });
    expect(created.customSigningKey).toBe(true);
    expect(created.signingAlgorithm).toBe("HS256");
    expect(backend.last("POST", "/v1/jwt_templates")?.body).toEqual({
      name: "custom",
      claims: { plan: "pro" },
      custom_signing_key: true,
      signing_algorithm: "HS256",
    });

    const updated = await orbit.jwtTemplates.updateJwtTemplate("jwt_1", { customSigningKey: true, signingAlgorithm: "RS256" });
    expect(updated.signingAlgorithm).toBe("RS256");
    expect(backend.last("PATCH", "/v1/jwt_templates/jwt_1")?.body).toEqual({
      custom_signing_key: true,
      signing_algorithm: "RS256",
    });
  });

  it("calls the webhook routes the server actually serves", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/webhooks/endpoints/we_1/deliveries") return { body: { data: [{ id: "whd_1", endpoint_id: "we_1", status: "failed", attempt: 3 }], total_count: 1 } };
      if (key === "POST /v1/webhooks/endpoints/we_1/test") return { body: { id: "whd_2", status: "success" } };
      if (key === "POST /v1/webhooks/deliveries/whd_1/retry") return { body: { id: "whd_1", status: "pending" } };
      if (key === "GET /v1/webhooks/endpoints/we_1/secret") return { body: { object: "webhook_endpoint_secret", id: "we_1", secret: "whsec_abc" } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });
    const deliveries = await orbit.webhooks.getWebhookDeliveryList({ endpointId: "we_1", status: "failed" });
    expect(deliveries.data[0]?.endpointId).toBe("we_1");
    expect(backend.calls.find((c) => c.path.endsWith("/deliveries"))?.query).toBe("?status=failed");
    expect((await orbit.webhooks.sendTestWebhook("we_1")).status).toBe("success");
    expect((await orbit.webhooks.retryWebhookDelivery("whd_1")).status).toBe("pending");
    expect((await orbit.webhooks.getWebhookEndpointSecret("we_1")).secret).toBe("whsec_abc");
  });

  it("throws OrbitIdAPIError with status, codes and trace id", async () => {
    const { orbit } = client(() => ({
      status: 422,
      body: { errors: [{ code: "form_password_incorrect", message: "Wrong password", long_message: "The password is incorrect" }], trace_id: "trace_abc" },
    }));
    const error = await orbit.users.banUser("user_1").catch((err: unknown) => err);
    expect(isOrbitIdAPIError(error)).toBe(true);
    const apiError = error as OrbitIdAPIError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("form_password_incorrect");
    expect(apiError.longMessage).toBe("The password is incorrect");
    expect(apiError.traceId).toBe("trace_abc");
    expect(apiError.hasCode("form_password_incorrect")).toBe(true);
  });

  it("reads, assigns and resets a user's instance roles with their source", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      const body = (roles: string[], source: string) => ({ object: "user_roles", user_id: "user_1", roles, role_permissions: [], source, default_role: "app:member" });
      if (key === "GET /v1/users/user_1/roles") return { body: body(["app:member"], "default") };
      if (key === "PUT /v1/users/user_1/roles") return { body: body([], "assigned") };
      if (key === "DELETE /v1/users/user_1/roles") return { body: body(["app:member"], "default") };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });
    const read = await orbit.users.getUserRoles("user_1");
    expect(read).toMatchObject({ roles: ["app:member"], source: "default", defaultRole: "app:member" });
    const cleared = await orbit.users.setUserRoles("user_1", []);
    expect(cleared.source).toBe("assigned");
    expect(backend.last("PUT", "/v1/users/user_1/roles")?.body).toEqual({ roles: [] });
    const reset = await orbit.users.resetUserRoles("user_1");
    expect(reset).toMatchObject({ roles: ["app:member"], source: "default" });
    expect(backend.last("DELETE", "/v1/users/user_1/roles")).toBeTruthy();
  });

  it("maps role, permission, bulk-invitation and api-key payloads", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "POST /v1/roles") return { body: { object: "role", id: "role_1", key: "org:support", name: "Support", permissions: [] } };
      if (key === "PATCH /v1/roles/role_1") return { body: { object: "role", id: "role_1", key: "org:support", name: "Supporters" } };
      if (key === "DELETE /v1/roles/role_1") return { body: { object: "role", id: "role_1", deleted: true } };
      if (key === "POST /v1/permissions") return { body: { object: "permission", id: "perm_1", key: "org:docs:read", name: "Read docs", type: "user" } };
      if (key === "GET /v1/permissions") return { body: { data: [], total_count: 0 } };
      if (key === "POST /v1/organizations/org_1/invitations/bulk") return { body: [{ id: "orginv_1" }, { id: "orginv_2" }] };
      if (key === "POST /v1/invitations/bulk") return { body: [{ id: "inv_1" }, { id: "inv_2" }] };
      if (key === "POST /v1/api_keys") return { body: { id: "ak_1", subject: "user_1", expiration: 123 } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const role = await orbit.organizations.createOrganizationRole({ name: "Support", key: "org:support", permissions: ["org:sys_memberships:read"] });
    expect(role.id).toBe("role_1");
    expect(backend.last("POST", "/v1/roles")?.body).toEqual({
      key: "org:support",
      name: "Support",
      description: undefined,
      permissions: ["org:sys_memberships:read"],
      is_creator_eligible: undefined,
    });
    await orbit.organizations.updateOrganizationRole({ roleId: "role_1", name: "Supporters" });
    expect(backend.last("PATCH", "/v1/roles/role_1")?.body).toMatchObject({ name: "Supporters" });
    await orbit.organizations.deleteOrganizationRole({ roleId: "role_1" });

    const permission = await orbit.organizations.createPermission({ name: "Read docs", key: "org:docs:read" });
    expect(permission.key).toBe("org:docs:read");
    expect(backend.last("POST", "/v1/permissions")?.body).toEqual({ name: "Read docs", key: "org:docs:read", description: undefined });
    expect((await orbit.organizations.getPermissionList()).totalCount).toBe(0);

    const orgBulk = await orbit.organizations.createOrganizationInvitationBulk("org_1", [
      { emailAddress: "a@example.com", role: "org:member" },
      { emailAddress: "b@example.com", role: "org:member" },
    ]);
    expect(orgBulk).toHaveLength(2);
    expect(backend.last("POST", "/v1/organizations/org_1/invitations/bulk")?.body).toEqual({
      email_addresses: ["a@example.com", "b@example.com"],
      role: "org:member",
      inviter_user_id: undefined,
      redirect_url: undefined,
      expires_at: undefined,
      public_metadata: undefined,
      private_metadata: undefined,
    });

    const bulk = await orbit.invitations.createInvitationBulk([{ emailAddress: "x@example.com" }, { emailAddress: "y@example.com" }]);
    expect(bulk).toHaveLength(2);
    expect(backend.last("POST", "/v1/invitations/bulk")?.body).toEqual({
      email_addresses: ["x@example.com", "y@example.com"],
      redirect_url: undefined,
      public_metadata: undefined,
      notify: undefined,
      ignore_existing: undefined,
      expires_in_days: undefined,
    });

    await orbit.apiKeys.createApiKey({ name: "CI", subject: "user_1", secondsUntilExpiration: 3600 });
    expect(backend.last("POST", "/v1/api_keys")?.body).toEqual({ name: "CI", subject: "user_1", seconds_until_expiration: 3600 });
  });

  it("calls the organization domain affiliation verification routes", async () => {
    const { orbit, backend } = client((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "POST /v1/organizations/org_1/domains/orgdom_1/prepare_affiliation_verification") {
        return { body: { object: "organization_domain", id: "orgdom_1", affiliation_email_address: "admin@acme.test", verification: { status: "unverified" } } };
      }
      if (key === "POST /v1/organizations/org_1/domains/orgdom_1/attempt_affiliation_verification") {
        return { body: { object: "organization_domain", id: "orgdom_1", affiliation_email_address: "admin@acme.test", verification: { status: "verified" } } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });

    const prepared = await orbit.organizations.prepareOrganizationDomainAffiliationVerification({
      organizationId: "org_1",
      domainId: "orgdom_1",
      affiliationEmailAddress: "admin@acme.test",
    });
    expect(prepared.affiliationEmailAddress).toBe("admin@acme.test");
    expect(backend.last("POST", "/v1/organizations/org_1/domains/orgdom_1/prepare_affiliation_verification")?.body).toEqual({
      affiliation_email_address: "admin@acme.test",
    });

    const verified = await orbit.organizations.attemptOrganizationDomainAffiliationVerification({
      organizationId: "org_1",
      domainId: "orgdom_1",
      code: "123456",
    });
    expect(verified.verification?.status).toBe("verified");
    expect(backend.last("POST", "/v1/organizations/org_1/domains/orgdom_1/attempt_affiliation_verification")?.body).toEqual({ code: "123456" });
  });

  it("handles 204 responses and empty lists", async () => {
    const { orbit } = client(() => ({ status: 204 }));
    const deleted = await orbit.users.deleteUser("user_1");
    expect(deleted).toBeUndefined();

    const { orbit: empty } = client(() => ({ body: { data: [], total_count: 0 } }));
    const list = await empty.organizations.getOrganizationList();
    expect(list).toEqual({ data: [], totalCount: 0 });
  });
});
