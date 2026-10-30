import { counters } from "./counters";
import type { createFakeApiKeys } from "./api-keys";
import type {
  OrganizationDomainResource,
  OrganizationInvitationResource,
  OrganizationMembershipResource,
  OrganizationMembershipRequestResource,
  OrganizationResource,
  OrganizationSuggestionResource,
  UserResource,
} from "../../../../provider";
import { MEMBER_PERMISSIONS, apiError, paginate, roleName } from "./backend";
import type {
  FakeBackend,
  FakeInvitation,
  FakeMember,
  FakeOrg,
  FakeSuggestion,
  FakeDomain,
} from "./types";

export function createFakeOrgResources(
  backend: FakeBackend,
  notify: () => void,
  keys: ReturnType<typeof createFakeApiKeys>,
) {
  const { buildApiKey, apiKeyResource } = keys;

  const activeOrg = (): FakeOrg | undefined =>
    backend.orgs.find((org) => org.id === backend.activeOrgId);

  const selfMember = (orgId: string): FakeMember | undefined =>
    (backend.members[orgId] ?? []).find((member) => member.userId === backend.self.id);


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
    counters.invitation += 1;
    const invitation: FakeInvitation = {
      id: `inv_${counters.invitation}`,
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


  return {
    activeOrg,
    selfMember,
    orgResource,
    memberResource,
    addInvitation,
    invitationResource,
    domainResource,
    requestResource,
    suggestionResource,
    selfMemberships,
    userResource,
  };
}
