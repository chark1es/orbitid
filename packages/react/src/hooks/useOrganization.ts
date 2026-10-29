import { useCallback, useContext, useMemo } from "react";
import { AuthContext, OrganizationContext, UserContext } from "../provider/contexts";
import type {
  ApiKeyResource,
  OrganizationDomainResource,
  OrganizationInvitationResource,
  OrganizationMembershipRequestResource,
  OrganizationMembershipResource,
  OrganizationResource,
  PaginationQuery,
} from "../provider/types";
import {
  fetchActiveMembership,
  fetchOrganizationApiKeys,
  fetchOrganizationDomains,
  fetchOrganizationInvitations,
  fetchOrganizationMembershipRequests,
  fetchOrganizationMemberships,
} from "./internal/adapters";
import { resolvePageOptions, type UseOrganizationParam } from "./internal/pageOptions";
import { useAsyncValue } from "./internal/useAsyncValue";
import { usePagedResource, type PagedResource } from "./internal/usePagedResource";

export type { UseOrganizationPaginationOptions, UseOrganizationParam } from "./internal/pageOptions";

export interface UseOrganizationParams {
  memberships?: UseOrganizationParam;
  invitations?: UseOrganizationParam;
  domains?: UseOrganizationParam;
  membershipRequests?: UseOrganizationParam;
  /** `false` (default) skips the request entirely. */
  apiKeys?: UseOrganizationParam;
}

export interface UseOrganizationReturn {
  isLoaded: boolean;
  organization: OrganizationResource | null;
  /** The current user's membership in the active organization. */
  membership: OrganizationMembershipResource | null;
  memberships: PagedResource<OrganizationMembershipResource>;
  invitations: PagedResource<OrganizationInvitationResource>;
  domains: PagedResource<OrganizationDomainResource>;
  membershipRequests: PagedResource<OrganizationMembershipRequestResource>;
  apiKeys: PagedResource<ApiKeyResource>;
}

/**
 * Active organization + its paginated collections.
 *
 * ```tsx
 * const { organization, membership, memberships, invitations } = useOrganization({
 *   memberships: { pageSize: 20, infinite: true },
 * });
 * await memberships.fetchNext();
 * ```
 */
export function useOrganization(params: UseOrganizationParams = {}): UseOrganizationReturn {
  const organization = useContext(OrganizationContext);
  const user = useContext(UserContext);
  const { isLoaded } = useContext(AuthContext);

  const membershipsOptions = resolvePageOptions(params.memberships, { enabled: true, pageSize: 10 });
  const invitationsOptions = resolvePageOptions(params.invitations, { enabled: true, pageSize: 10 });
  const domainsOptions = resolvePageOptions(params.domains, { enabled: true, pageSize: 10 });
  const requestsOptions = resolvePageOptions(params.membershipRequests, { enabled: true, pageSize: 10 });
  const apiKeysOptions = resolvePageOptions(params.apiKeys, { enabled: false, pageSize: 10 });

  const organizationId = organization?.id ?? null;
  const userId = user?.id ?? null;

  const fetchMembershipsPage = useCallback(
    (args: PaginationQuery) =>
      fetchOrganizationMemberships(organization, args, {
        role: membershipsOptions.role,
        query: membershipsOptions.query,
      }),
    [organization, membershipsOptions.role, membershipsOptions.query],
  );
  const fetchInvitationsPage = useCallback(
    (args: PaginationQuery) => fetchOrganizationInvitations(organization, args),
    [organization],
  );
  const fetchDomainsPage = useCallback(
    (args: PaginationQuery) => fetchOrganizationDomains(organization, args),
    [organization],
  );
  const fetchRequestsPage = useCallback(
    (args: PaginationQuery) => fetchOrganizationMembershipRequests(organization, args),
    [organization],
  );
  const fetchApiKeysPage = useCallback(
    (args: PaginationQuery) => fetchOrganizationApiKeys(organization, args),
    [organization],
  );

  const memberships = usePagedResource<OrganizationMembershipResource>({
    key: `org:${organizationId}:memberships`,
    fetcher: fetchMembershipsPage,
    params: { role: membershipsOptions.role, query: membershipsOptions.query },
    pageSize: membershipsOptions.pageSize,
    initialPage: membershipsOptions.initialPage,
    infinite: membershipsOptions.infinite,
    keepPreviousData: membershipsOptions.keepPreviousData,
    enabled: membershipsOptions.enabled && Boolean(organizationId),
  });

  const invitations = usePagedResource<OrganizationInvitationResource>({
    key: `org:${organizationId}:invitations`,
    fetcher: fetchInvitationsPage,
    params: { query: invitationsOptions.query },
    pageSize: invitationsOptions.pageSize,
    initialPage: invitationsOptions.initialPage,
    infinite: invitationsOptions.infinite,
    keepPreviousData: invitationsOptions.keepPreviousData,
    enabled: invitationsOptions.enabled && Boolean(organizationId),
  });

  const domains = usePagedResource<OrganizationDomainResource>({
    key: `org:${organizationId}:domains`,
    fetcher: fetchDomainsPage,
    pageSize: domainsOptions.pageSize,
    initialPage: domainsOptions.initialPage,
    infinite: domainsOptions.infinite,
    keepPreviousData: domainsOptions.keepPreviousData,
    enabled: domainsOptions.enabled && Boolean(organizationId),
  });

  const membershipRequests = usePagedResource<OrganizationMembershipRequestResource>({
    key: `org:${organizationId}:membership-requests`,
    fetcher: fetchRequestsPage,
    pageSize: requestsOptions.pageSize,
    initialPage: requestsOptions.initialPage,
    infinite: requestsOptions.infinite,
    keepPreviousData: requestsOptions.keepPreviousData,
    enabled: requestsOptions.enabled && Boolean(organizationId),
  });

  const apiKeys = usePagedResource<ApiKeyResource>({
    key: `org:${organizationId}:api-keys`,
    fetcher: fetchApiKeysPage,
    pageSize: apiKeysOptions.pageSize,
    initialPage: apiKeysOptions.initialPage,
    infinite: apiKeysOptions.infinite,
    keepPreviousData: apiKeysOptions.keepPreviousData,
    enabled: apiKeysOptions.enabled && Boolean(organizationId),
  });

  const fetchMembership = useCallback(
    (options: { force?: boolean }) =>
      userId && organizationId
        ? fetchActiveMembership(user, organizationId, options)
        : Promise.resolve(null),
    [userId, organizationId, user],
  );
  const activeMembership = useAsyncValue<OrganizationMembershipResource>({
    key: `org:${organizationId}:membership:${userId}`,
    fetcher: userId && organizationId ? fetchMembership : null,
    enabled: Boolean(userId && organizationId),
  });

  return useMemo(
    () => ({
      isLoaded,
      organization,
      membership: activeMembership.data,
      memberships,
      invitations,
      domains,
      membershipRequests,
      apiKeys,
    }),
    [isLoaded, organization, activeMembership.data, memberships, invitations, domains, membershipRequests, apiKeys],
  );
}
