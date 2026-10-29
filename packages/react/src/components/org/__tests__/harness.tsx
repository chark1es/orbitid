import { cleanup, render, type RenderResult } from "@testing-library/react";
import { afterEach } from "vitest";
import type { ReactElement } from "react";
import { encodePublishableKey, type ApiKeyJSON } from "@orbitid/shared";
import { OrbitIDProvider } from "../../../provider";
import type {
  ApiKeyResource,
  OrbitIDInstance,
  OrbitIDState,
  OrganizationDomainResource,
  OrganizationInvitationResource,
  OrganizationMembershipResource,
  OrganizationMembershipRequestResource,
  OrganizationResource,
  OrganizationSuggestionResource,
  RoleResource,
  UserResource,
} from "../../../provider";

// ---------------------------------------------------------------------------------------------
// Backend fixtures
// ---------------------------------------------------------------------------------------------

export interface FakeUser {
  id: string;
  firstName: string;
  lastName: string;
  identifier: string;
}

export interface FakeOrg {
  id: string;
  name: string;
  slug: string;
  /** `created_by` of the organization; defaults to the fake signed-in user. */
  createdBy?: string | null;
  hasImage?: boolean;
  maxAllowedMemberships?: number;
  adminDeleteEnabled?: boolean;
}

export interface FakeMember {
  userId: string;
  firstName?: string;
  lastName?: string;
  identifier: string;
  role: string;
  permissions?: string[];
  createdAt?: number;
}

export interface FakeInvitation {
  id: string;
  emailAddress: string;
  organizationId: string;
  role: string;
  createdAt?: number;
  /** Denormalized label the server adds to `GET /me/organization_invitations`. */
  organizationName?: string;
  organizationImageUrl?: string;
}

export interface FakeDomain {
  id: string;
  name: string;
  enrollmentMode: string;
  verified: boolean;
  totalPendingInvitations?: number;
  totalPendingSuggestions?: number;
}

export interface FakeSuggestion {
  id: string;
  organizationId: string;
}

export interface ApiErrorPayload {
  errors: { code: string; message: string }[];
}

export interface BackendCalls {
  navigate: string[];
  setActive: (string | null)[];
  roleUpdates: { userId: string; role: string }[];
  memberRemovals: string[];
  invites: { emailAddresses: string[]; role: string }[];
  destroyedOrganizations: string[];
  leftOrganizations: string[];
  fetch: { method: string; path: string; body: unknown }[];
}

export interface FakeBackend {
  self: FakeUser;
  orgs: FakeOrg[];
  members: Record<string, FakeMember[]>;
  invitations: Record<string, FakeInvitation[]>;
  userInvitations: FakeInvitation[];
  domains: Record<string, FakeDomain[]>;
  membershipRequests: Record<string, FakeMember[]>;
  suggestions: FakeSuggestion[];
  apiKeys: ApiKeyJSON[];
  activeOrgId: string | null;
  organizationSettings: Record<string, unknown>;
  roles: RoleResource[];
  membershipRequestsEnabled?: boolean;
  /** Force a specific mutation to fail (e.g. `updateRole`). */
  failMutation?: {
    updateRole?: ApiErrorPayload;
    inviteMembers?: ApiErrorPayload;
    verifyCode?: boolean;
    leaveOrganization?: ApiErrorPayload;
  };
  calls: BackendCalls;
  /** Defaults applied to the auto-generated organization. */
  orgDefaults?: Partial<FakeOrg>;
  /** Last code the fake "sent" for each domain id. */
  verificationCodes: Record<string, string>;
}

export interface FakeInstance {
  instance: OrbitIDInstance;
  backend: FakeBackend;
  notify: () => void;
  unmountListeners: () => void;
}

const ADMIN_PERMISSIONS = [
  "org:sys_profile:manage",
  "org:sys_profile:delete",
  "org:sys_memberships:read",
  "org:sys_memberships:manage",
  "org:sys_domains:read",
  "org:sys_domains:manage",
];

const MEMBER_PERMISSIONS = ["org:sys_memberships:read", "org:sys_domains:read"];

// Keep each test isolated even if the package's vitest config disables globals.
afterEach(cleanup);

let orgCounter = 0;
let invitationCounter = 0;
let userCounter = 0;

// jsdom lacks these APIs; Radix (popover/dialog/select) touches them.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

export function createFakeBackend(overrides: Partial<FakeBackend> = {}): FakeBackend {
  orgCounter += 1;
  userCounter += 1;
  const org: FakeOrg = {
    id: `org_${orgCounter}`,
    name: "Acme",
    slug: `acme-${orgCounter}`,
    ...overrides.orgDefaults,
  };
  const self: FakeUser = {
    id: `user_self_${userCounter}`,
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

const roleName = (role: string): string =>
  role === "org:admin" ? "Admin" : role === "org:member" ? "Member" : role;

const apiError = (code: string, message = code): ApiErrorPayload => ({
  errors: [{ code, message }],
});

function paginate<T>(
  rows: T[],
  params?: { limit?: number; offset?: number; query?: string; role?: string },
  filter?: (row: T) => boolean,
): { data: T[]; totalCount: number } {
  const filtered = filter ? rows.filter(filter) : rows;
  const offset = params?.offset ?? 0;
  const limit = params?.limit ?? filtered.length;
  return { data: filtered.slice(offset, offset + limit), totalCount: filtered.length };
}

export function createFakeInstance(providedBackend?: Partial<FakeBackend>): FakeInstance {
  const backend = createFakeBackend(providedBackend);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const activeOrg = (): FakeOrg | undefined =>
    backend.orgs.find((org) => org.id === backend.activeOrgId);

  const selfMember = (orgId: string): FakeMember | undefined =>
    (backend.members[orgId] ?? []).find((member) => member.userId === backend.self.id);

  const buildApiKey = (params: {
    name: string;
    description?: string;
    expiration?: number | null;
    scopes?: string[];
  }): ApiKeyJSON => {
    const index = backend.apiKeys.length + 1;
    return {
      object: "api_key",
      id: `key_${index}`,
      name: params.name,
      description: params.description ?? null,
      subject: backend.self.id,
      prefix: `ak_live_${index}`,
      secret: `ak_live_secret_${index}`,
      scopes: params.scopes ?? [],
      claims: null,
      revoked: false,
      expiration: params.expiration ?? null,
      last_used_at: null,
      created_by: backend.self.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  };

  const apiKeyResource = (key: ApiKeyJSON): ApiKeyResource => ({
    id: key.id,
    name: key.name,
    description: key.description,
    subject: key.subject,
    prefix: key.prefix,
    scopes: key.scopes,
    claims: key.claims,
    revoked: key.revoked,
    expiration: key.expiration,
    lastUsedAt: key.last_used_at,
    createdAt: key.created_at,
    createdBy: key.created_by,
    updatedAt: key.updated_at,
    secret: key.secret,
    revoke: async () => {
      backend.apiKeys = backend.apiKeys.map((candidate) =>
        candidate.id === key.id ? { ...candidate, revoked: true } : candidate,
      );
      notify();
    },
  });

  const revokeKey = (id: string) => {
    backend.apiKeys = backend.apiKeys.map((key) =>
      key.id === id ? { ...key, revoked: true } : key,
    );
  };

  const orgResource = (org: FakeOrg): OrganizationResource => {
    const own = () => backend.members[org.id] ?? [];
    const fromJSON = (): OrganizationResource => orgResource(org);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      imageUrl: `https://img.test/${org.id}.png`,
      hasImage: Boolean(org.hasImage),
      membersCount: own().length,
      createdBy: org.createdBy ?? backend.self.id,
      maxAllowedMemberships: org.maxAllowedMemberships ?? 5,
      adminDeleteEnabled: org.adminDeleteEnabled ?? true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      update: async (params: { name?: string; slug?: string }) => {
        if (
          params.slug &&
          backend.orgs.some((candidate) => candidate.id !== org.id && candidate.slug === params.slug)
        ) {
          throw apiError("organization_slug_taken");
        }
        if (params.name) org.name = params.name;
        if (params.slug) org.slug = params.slug;
        notify();
        return fromJSON();
      },
      destroy: async () => {
        backend.calls.destroyedOrganizations.push(org.id);
        backend.orgs = backend.orgs.filter((candidate) => candidate.id !== org.id);
        if (backend.activeOrgId === org.id) backend.activeOrgId = null;
        notify();
      },
      setLogo: async ({ file }: { file: Blob | File | null }) => {
        org.hasImage = Boolean(file);
        notify();
        return fromJSON();
      },
      removeLogo: async () => {
        org.hasImage = false;
        notify();
        return fromJSON();
      },
      getMemberships: async (params?: { limit?: number; offset?: number; role?: string; query?: string }) =>
        paginate(
          own().map((member) => memberResource(org, member)),
          params,
          (membership) =>
            (!params?.role || membership.role === params.role) &&
            (!params?.query ||
              `${membership.publicUserData.firstName ?? ""} ${
                membership.publicUserData.lastName ?? ""
              } ${membership.publicUserData.identifier}`
                .toLowerCase()
                .includes(params.query.toLowerCase())),
        ),
      addMember: async ({ userId, role }: { userId: string; role: string }) => {
        const member: FakeMember = { userId, identifier: `${userId}@example.com`, role };
        backend.members[org.id] = [...own(), member];
        notify();
        return memberResource(org, member);
      },
      inviteMember: async ({ emailAddress, role }: { emailAddress: string; role: string }) => {
        const invitation = addInvitation(org.id, emailAddress, role);
        return invitationResource(invitation);
      },
      inviteMembers: async ({ emailAddresses, role }: { emailAddresses: string[]; role: string }) => {
        if (backend.failMutation?.inviteMembers) throw backend.failMutation.inviteMembers;
        backend.calls.invites.push({ emailAddresses, role });
        return emailAddresses.map((emailAddress) =>
          invitationResource(addInvitation(org.id, emailAddress, role)),
        );
      },
      getInvitations: async () => (backend.invitations[org.id] ?? []).map(invitationResource),
      createDomain: async ({ name }: { name: string }) => {
        const domain: FakeDomain = {
          id: `domain_${backend.domains[org.id]?.length ?? 0}_${Date.now()}`,
          name,
          enrollmentMode: "manual_invitation",
          verified: false,
        };
        backend.domains[org.id] = [...(backend.domains[org.id] ?? []), domain];
        notify();
        return domainResource(org.id, domain);
      },
      getDomains: async () => (backend.domains[org.id] ?? []).map((domain) => domainResource(org.id, domain)),
      getMembershipRequests: async () =>
        (backend.membershipRequests[org.id] ?? []).map((member) =>
          requestResource(org.id, member),
        ),
      getRoles: async () => backend.roles,
      apiKeys: {
        list: async () => ({
          data: backend.apiKeys.map(apiKeyResource),
          totalCount: backend.apiKeys.length,
        }),
        create: async (params: {
          name: string;
          description?: string;
          expiration?: number | null;
          scopes?: string[];
        }) => {
          const key = buildApiKey(params);
          backend.apiKeys = [key, ...backend.apiKeys];
          return apiKeyResource(key);
        },
      },
      requestMembership: async () =>
        requestResource(org.id, {
          userId: backend.self.id,
          firstName: backend.self.firstName,
          lastName: backend.self.lastName,
          identifier: backend.self.identifier,
          role: "org:member",
        }),
    } satisfies OrganizationResource;
  };

  const memberResource = (
    org: FakeOrg,
    member: FakeMember,
  ): OrganizationMembershipResource => ({
    id: `mem_${org.id}_${member.userId}`,
    role: member.role,
    roleName: roleName(member.role),
    permissions: member.permissions,
    organization: orgResource(org),
    publicUserData: {
      userId: member.userId,
      firstName: member.firstName ?? null,
      lastName: member.lastName ?? null,
      identifier: member.identifier,
      imageUrl: `https://img.test/${member.userId}.png`,
      hasImage: false,
    },
    createdAt: member.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    update: async ({ role }: { role: string }) => {
      if (backend.failMutation?.updateRole) throw backend.failMutation.updateRole;
      member.role = role;
      backend.calls.roleUpdates.push({ userId: member.userId, role });
      notify();
      return memberResource(org, member);
    },
    destroy: async () => {
      backend.members[org.id] = (backend.members[org.id] ?? []).filter(
        (candidate) => candidate.userId !== member.userId,
      );
      backend.calls.memberRemovals.push(member.userId);
      notify();
    },
  });

  const addInvitation = (orgId: string, emailAddress: string, role: string): FakeInvitation => {
    invitationCounter += 1;
    const invitation: FakeInvitation = {
      id: `inv_${invitationCounter}`,
      emailAddress,
      organizationId: orgId,
      role,
      createdAt: Date.now(),
    };
    backend.invitations[orgId] = [...(backend.invitations[orgId] ?? []), invitation];
    notify();
    return invitation;
  };

  const invitationResource = (invitation: FakeInvitation): OrganizationInvitationResource => ({
    id: invitation.id,
    emailAddress: invitation.emailAddress,
    organizationId: invitation.organizationId,
    organizationName: invitation.organizationName,
    organizationImageUrl: invitation.organizationImageUrl,
    role: invitation.role,
    roleName: roleName(invitation.role),
    status: "pending",
    createdAt: invitation.createdAt,
    revoke: async () => {
      backend.invitations[invitation.organizationId] = (
        backend.invitations[invitation.organizationId] ?? []
      ).filter((candidate) => candidate.id !== invitation.id);
      notify();
      return { ...invitationResource(invitation), status: "revoked" };
    },
  });

  const domainResource = (
    orgId: string,
    domain: FakeDomain,
  ): OrganizationDomainResource => ({
    id: domain.id,
    organizationId: orgId,
    name: domain.name,
    enrollmentMode: domain.enrollmentMode,
    verification: domain.verified
      ? { status: "verified", strategy: "email_code" }
      : { status: "unverified", strategy: "email_code" },
    affiliationEmailAddress: null,
    totalPendingInvitations: domain.totalPendingInvitations ?? 0,
    totalPendingSuggestions: domain.totalPendingSuggestions ?? 0,
    prepareAffiliationVerification: async ({ affiliationEmailAddress }: { affiliationEmailAddress: string }) => {
      backend.verificationCodes[domain.id] = "123456";
      backend.calls.fetch.push({
        method: "PREPARE_DOMAIN",
        path: domain.id,
        body: affiliationEmailAddress,
      });
      return domainResource(orgId, domain);
    },
    attemptAffiliationVerification: async ({ code }: { code: string }) => {
      if (code !== backend.verificationCodes[domain.id]) {
        throw apiError("form_code_incorrect");
      }
      domain.verified = true;
      notify();
      return domainResource(orgId, domain);
    },
    updateEnrollmentMode: async ({
      enrollmentMode,
      deletePending,
    }: {
      enrollmentMode: string;
      deletePending?: boolean;
    }) => {
      domain.enrollmentMode = enrollmentMode;
      backend.calls.fetch.push({
        method: "ENROLLMENT",
        path: domain.id,
        body: { enrollmentMode, deletePending },
      });
      notify();
      return domainResource(orgId, domain);
    },
    delete: async () => {
      backend.domains[orgId] = (backend.domains[orgId] ?? []).filter(
        (candidate) => candidate.id !== domain.id,
      );
      notify();
    },
  });

  const requestResource = (
    orgId: string,
    member: FakeMember,
  ): OrganizationMembershipRequestResource => ({
    id: `req_${orgId}_${member.userId}`,
    organizationId: orgId,
    status: "pending",
    publicUserData: {
      userId: member.userId,
      firstName: member.firstName ?? null,
      lastName: member.lastName ?? null,
      identifier: member.identifier,
      imageUrl: "",
      hasImage: false,
    },
    createdAt: Date.now(),
    accept: async () => {
      backend.membershipRequests[orgId] = (backend.membershipRequests[orgId] ?? []).filter(
        (candidate) => candidate.userId !== member.userId,
      );
      backend.members[orgId] = [...(backend.members[orgId] ?? []), { ...member, role: "org:member" }];
      notify();
      return requestResource(orgId, member);
    },
    reject: async () => {
      backend.membershipRequests[orgId] = (backend.membershipRequests[orgId] ?? []).filter(
        (candidate) => candidate.userId !== member.userId,
      );
      notify();
      return requestResource(orgId, member);
    },
  });

  const suggestionResource = (suggestion: FakeSuggestion): OrganizationSuggestionResource => {
    const org = backend.orgs.find((candidate) => candidate.id === suggestion.organizationId);
    return {
      id: suggestion.id,
      status: "pending",
      publicOrganizationData: {
        id: suggestion.organizationId,
        name: org?.name ?? suggestion.organizationId,
        slug: org?.slug ?? suggestion.organizationId,
        hasImage: false,
      },
      accept: async () => {
        const target = org;
        if (!target) throw apiError("organization_not_found");
        backend.members[target.id] = [
          ...(backend.members[target.id] ?? []),
          {
            userId: backend.self.id,
            firstName: backend.self.firstName,
            lastName: backend.self.lastName,
            identifier: backend.self.identifier,
            role: "org:member",
            permissions: MEMBER_PERMISSIONS,
          },
        ];
        backend.suggestions = backend.suggestions.filter((candidate) => candidate.id !== suggestion.id);
        notify();
        return { ...suggestionResource(suggestion), status: "accepted" };
      },
    };
  };

  const selfMemberships = (): OrganizationMembershipResource[] =>
    backend.orgs.flatMap((org) => {
      const member = selfMember(org.id);
      return member ? [memberResource(org, member)] : [];
    });

  const userResource = (): UserResource =>
    ({
      id: backend.self.id,
      firstName: backend.self.firstName,
      lastName: backend.self.lastName,
      fullName: `${backend.self.firstName} ${backend.self.lastName}`,
      username: null,
      imageUrl: "https://img.test/self.png",
      hasImage: false,
      primaryEmailAddressId: "idn_self",
      primaryEmailAddress: { id: "idn_self", emailAddress: backend.self.identifier },
      emailAddresses: [{ id: "idn_self", emailAddress: backend.self.identifier }],
      phoneNumbers: [],
      externalAccounts: [],
      passkeys: [],
      publicMetadata: {},
      unsafeMetadata: {},
      getOrganizationMemberships: async () => ({
        data: selfMemberships(),
        totalCount: selfMemberships().length,
      }),
      getOrganizationInvitations: async () => ({
        data: backend.userInvitations.map(invitationResource),
        totalCount: backend.userInvitations.length,
      }),
      getOrganizationSuggestions: async () => ({
        data: backend.suggestions.map(suggestionResource),
        totalCount: backend.suggestions.length,
      }),
      leaveOrganization: async (organizationId: string) => {
        if (backend.failMutation?.leaveOrganization) throw backend.failMutation.leaveOrganization;
        backend.members[organizationId] = (backend.members[organizationId] ?? []).filter(
          (member) => member.userId !== backend.self.id,
        );
        backend.calls.leftOrganizations.push(organizationId);
        notify();
      },
    }) as unknown as UserResource;

  const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v1\/client/, "");
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    backend.calls.fetch.push({ method, path, body });

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const invitationAccept = /^\/me\/organization_invitations\/([^/]+)\/accept$/.exec(path);
    if (method === "POST" && invitationAccept) {
      const invitation = backend.userInvitations.find(
        (candidate) => candidate.id === decodeURIComponent(invitationAccept[1]!),
      );
      if (!invitation) {
        return respond(apiError("resource_not_found"), 404);
      }
      backend.userInvitations = backend.userInvitations.filter(
        (candidate) => candidate.id !== invitation.id,
      );
      const org = backend.orgs.find((candidate) => candidate.id === invitation.organizationId);
      if (!org) return respond(apiError("organization_not_found"), 404);
      backend.members[org.id] = [
        ...(backend.members[org.id] ?? []),
        {
          userId: backend.self.id,
          firstName: backend.self.firstName,
          lastName: backend.self.lastName,
          identifier: backend.self.identifier,
          role: invitation.role,
          permissions: invitation.role === "org:admin" ? ADMIN_PERMISSIONS : MEMBER_PERMISSIONS,
        },
      ];
      notify();
      return respond({ response: memberResource(org, selfMember(org.id)!) });
    }

    const apiKeyRevoke = /^\/(?:me|organizations\/([^/]+))\/api_keys\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && apiKeyRevoke) {
      const id = decodeURIComponent(apiKeyRevoke[2]!);
      revokeKey(id);
      return respond({ response: backend.apiKeys.find((key) => key.id === id) });
    }

    const apiKeys = /^\/(?:me|organizations\/([^/]+))\/api_keys$/.exec(path);
    if (apiKeys) {
      if (method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? backend.apiKeys.length);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return respond({
          response: backend.apiKeys.slice(offset, offset + limit),
          total_count: backend.apiKeys.length,
        });
      }
      if (method === "POST") {
        const key = buildApiKey(
          (body ?? {}) as {
            name: string;
            description?: string;
            expiration?: number | null;
            scopes?: string[];
          },
        );
        backend.apiKeys = [key, ...backend.apiKeys];
        return respond({ response: key });
      }
    }

    return respond(apiError("resource_not_found"), 404);
  };

  let instance: OrbitIDInstance;
  const syncOrganization = () => {
    const org = activeOrg();
    instance.organization = org ? orgResource(org) : null;
  };

  instance = {
    loaded: true,
    publishableKey: encodePublishableKey("https://api.test"),
    client: { id: "client_1", sessions: [] } as unknown as OrbitIDInstance["client"],
    session: {
      id: "sess_1",
      status: "active",
      publicUserData: { userId: backend.self.id, identifier: backend.self.identifier },
      lastActiveOrganizationId: backend.activeOrgId,
    } as unknown as OrbitIDInstance["session"],
    user: userResource(),
    organization: null,
    environment: {
      organization_settings: backend.organizationSettings,
    } as unknown as OrbitIDInstance["environment"],
    signIn: undefined,
    signUp: undefined,
    options: { fetch: fakeFetch },
    addListener: (callback: (state: OrbitIDState) => void) => {
      listeners.add(callback as () => void);
      return () => {
        listeners.delete(callback as () => void);
      };
    },
    load: async () => {},
    setActive: async ({ organization }: { organization?: string | OrganizationResource | null }) => {
      const id = typeof organization === "string" ? organization : (organization?.id ?? null);
      backend.activeOrgId = id;
      backend.calls.setActive.push(id);
      instance.session = {
        ...(instance.session as unknown as Record<string, unknown>),
        lastActiveOrganizationId: id,
      } as unknown as OrbitIDInstance["session"];
      syncOrganization();
      notify();
    },
    signOut: async () => {},
    apiKeys: {
      list: async () => ({
        data: backend.apiKeys.map(apiKeyResource),
        totalCount: backend.apiKeys.length,
      }),
      create: async (params: {
        name: string;
        description?: string;
        expiration?: number | null;
        scopes?: string[];
      }) => {
        const key = buildApiKey(params);
        backend.apiKeys = [key, ...backend.apiKeys];
        return apiKeyResource(key);
      },
      revoke: async (id: string) => {
        revokeKey(id);
        notify();
      },
    },
    createOrganization: async ({ name, slug }: { name: string; slug?: string }) => {
      const resolvedSlug = slug ?? name.toLowerCase().replace(/\s+/g, "-");
      if (backend.orgs.some((candidate) => candidate.slug === resolvedSlug)) {
        throw apiError("organization_slug_taken");
      }
      const created: FakeOrg = {
        id: `org_${++orgCounter}`,
        name,
        slug: resolvedSlug,
      };
      backend.orgs = [...backend.orgs, created];
      backend.members[created.id] = [
        {
          userId: backend.self.id,
          firstName: backend.self.firstName,
          lastName: backend.self.lastName,
          identifier: backend.self.identifier,
          role: "org:admin",
          permissions: ADMIN_PERMISSIONS,
        },
      ];
      notify();
      return orgResource(created);
    },
    getOrganization: async (organizationId: string) => {
      const org = backend.orgs.find((candidate) => candidate.id === organizationId);
      if (!org) throw apiError("organization_not_found");
      return orgResource(org);
    },
    navigate: (to: string) => {
      backend.calls.navigate.push(to);
    },
  };

  syncOrganization();

  return {
    instance,
    backend,
    notify,
    unmountListeners: () => listeners.clear(),
  };
}

/** Renders `ui` inside the real provider with the fake instance. */
export function renderWithOrbit(
  ui: ReactElement,
  fake: FakeInstance = createFakeInstance(),
): RenderResult & { fake: FakeInstance } {
  const result = render(
    <OrbitIDProvider orbit={fake.instance} publishableKey="pk_test_harness">
      {ui}
    </OrbitIDProvider>,
  );
  return Object.assign(result, { fake });
}
