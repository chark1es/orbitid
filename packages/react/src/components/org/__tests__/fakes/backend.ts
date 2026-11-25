import { counters } from "./counters";
import type { ApiErrorPayload, FakeBackend, FakeOrg, FakeUser } from "./types";

export const ADMIN_PERMISSIONS = [
  "org:sys_profile:manage",
  "org:sys_profile:delete",
  "org:sys_memberships:read",
  "org:sys_memberships:manage",
  "org:sys_domains:read",
  "org:sys_domains:manage",
  "org:sys_billing:manage",
];

export const MEMBER_PERMISSIONS = ["org:sys_memberships:read", "org:sys_domains:read"];


export function createFakeBackend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  counters.org += 1;
  counters.user += 1;
  const org: FakeOrg = {
    id: `org_${counters.org}`,
    name: "Acme",
    slug: `acme-${counters.org}`,
    ...overrides.orgDefaults,
  };
  const self: FakeUser = {
    id: `user_self_${counters.user}`,
    firstName: "Ada",
    lastName: "Lovelace",
    identifier: "ada@example.com",
  };
  const backend: FakeBackend = {
    self,
    orgs: [org],
    members: {
      [org.id]: [
        {
          userId: self.id,
          firstName: self.firstName,
          lastName: self.lastName,
          identifier: self.identifier,
          role: "org:admin",
          permissions: ADMIN_PERMISSIONS,
        },
        {
          userId: "user_member",
          firstName: "Grace",
          lastName: "Hopper",
          identifier: "grace@example.com",
          role: "org:member",
          permissions: MEMBER_PERMISSIONS,
        },
      ],
    },
    invitations: { [org.id]: [] },
    userInvitations: [],
    domains: { [org.id]: [] },
    membershipRequests: { [org.id]: [] },
    suggestions: [],
    apiKeys: [],
    activeOrgId: org.id,
    organizationSettings: {
      enabled: true,
      creationEnabled: true,
      slugEnabled: true,
      domainsEnabled: true,
      membershipRequestsEnabled: false,
      max_allowed_memberships: 5,
    },
    roles: [
      { key: "org:admin", name: "Admin" },
      { key: "org:member", name: "Member" },
    ],
    calls: {
      navigate: [],
      setActive: [],
      roleUpdates: [],
      memberRemovals: [],
      invites: [],
      destroyedOrganizations: [],
      leftOrganizations: [],
      fetch: [],
    },
    verificationCodes: {},
  };
  return {
    ...backend,
    ...overrides,
    calls: backend.calls,
    organizationSettings: {
      ...backend.organizationSettings,
      ...(overrides.organizationSettings ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Resource factories (fresh objects per call, so refetches see mutations)
// ---------------------------------------------------------------------------------------------

export const roleName = (role: string): string =>
  role === "org:admin" ? "Admin" : role === "org:member" ? "Member" : role;

export const apiError = (code: string, message = code): ApiErrorPayload => ({
  errors: [{ code, message }],
});

export function paginate<T>(
  rows: T[],
  params?: { limit?: number; offset?: number; query?: string; role?: string },
  filter?: (row: T) => boolean,
): { data: T[]; totalCount: number } {
  const filtered = filter ? rows.filter(filter) : rows;
  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? filtered.length;
  return { data: filtered.slice(offset, offset + limit), totalCount: filtered.length };
}
