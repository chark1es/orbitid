import { useCallback, useContext, useMemo } from "react";
import { AuthContext, UserContext } from "../provider/contexts";
import type {
  CreateOrganizationParams,
  OrganizationMembershipResource,
  OrganizationResource,
  OrganizationSuggestionResource,
  PaginationQuery,
  UserOrganizationInvitationResource,
} from "../provider/types";
import { fetchUserInvitations, fetchUserMemberships, fetchUserSuggestions } from "./internal/adapters";
import { usePagedResource, type PagedResource } from "./internal/usePagedResource";
import { invalidateRequest } from "./internal/requestCache";
import { resolvePageOptions, type UseOrganizationParam } from "./internal/pageOptions";
import { useOrbitID } from "./useOrbitID";

export interface UseOrganizationListParams {
  userMemberships?: UseOrganizationParam;
  userInvitations?: UseOrganizationParam;
  userSuggestions?: UseOrganizationParam;
}

export interface SetActiveOrganizationParams {
  organization: string | OrganizationResource | null;
  beforeEmit?: () => void | Promise<void>;
}

export interface UseOrganizationListReturn {
  isLoaded: boolean;
  userMemberships: PagedResource<OrganizationMembershipResource>;
  userInvitations: PagedResource<UserOrganizationInvitationResource>;
  userSuggestions: PagedResource<OrganizationSuggestionResource>;
  /** Switch the active organization (`organization: null` → personal account). */
  setActive(params: SetActiveOrganizationParams): Promise<void>;
  createOrganization(params: CreateOrganizationParams): Promise<OrganizationResource>;
}

/** Every organization the current user belongs to (plus invitations and suggestions). */
export function useOrganizationList(params: UseOrganizationListParams = {}): UseOrganizationListReturn {
  const instance = useOrbitID();
  const user = useContext(UserContext);
  const { isLoaded, userId } = useContext(AuthContext);

  const membershipsOptions = resolvePageOptions(params.userMemberships, { enabled: true, pageSize: 10 });
  const invitationsOptions = resolvePageOptions(params.userInvitations, { enabled: true, pageSize: 10 });
  const suggestionsOptions = resolvePageOptions(params.userSuggestions, { enabled: true, pageSize: 10 });

  const fetchMembershipsPage = useCallback(
    (args: PaginationQuery) => fetchUserMemberships(user, args),
    [user],
  );
  const fetchInvitationsPage = useCallback(
    (args: PaginationQuery) => fetchUserInvitations(user, args),
    [user],
  );
  const fetchSuggestionsPage = useCallback(
    (args: PaginationQuery) => fetchUserSuggestions(user, args),
    [user],
  );

  const userMemberships = usePagedResource<OrganizationMembershipResource>({
    key: `user:${userId}:organization-memberships`,
    fetcher: fetchMembershipsPage,
    pageSize: membershipsOptions.pageSize,
    initialPage: membershipsOptions.initialPage,
    infinite: membershipsOptions.infinite,
    keepPreviousData: membershipsOptions.keepPreviousData,
    enabled: membershipsOptions.enabled && Boolean(userId),
  });

  const userInvitations = usePagedResource<UserOrganizationInvitationResource>({
    key: `user:${userId}:organization-invitations`,
    fetcher: fetchInvitationsPage,
    pageSize: invitationsOptions.pageSize,
    initialPage: invitationsOptions.initialPage,
    infinite: invitationsOptions.infinite,
    keepPreviousData: invitationsOptions.keepPreviousData,
    enabled: invitationsOptions.enabled && Boolean(userId),
  });

  const userSuggestions = usePagedResource<OrganizationSuggestionResource>({
    key: `user:${userId}:organization-suggestions`,
    fetcher: fetchSuggestionsPage,
    pageSize: suggestionsOptions.pageSize,
    initialPage: suggestionsOptions.initialPage,
    infinite: suggestionsOptions.infinite,
    keepPreviousData: suggestionsOptions.keepPreviousData,
    enabled: suggestionsOptions.enabled && Boolean(userId),
  });

  const revalidateMemberships = userMemberships.revalidate;
  const revalidateInvitations = userInvitations.revalidate;
  /** Drops every cached page for the user's membership/invitation/suggestion endpoints. */
  const invalidateUserOrganizationData = useCallback(() => {
    if (!userId) return;
    invalidateRequest(`user:${userId}:`);
  }, [userId]);

  const setActive = useCallback(
    async ({ organization, beforeEmit }: SetActiveOrganizationParams) => {
      await instance.setActive({ session: instance.session, organization, beforeEmit });
      invalidateUserOrganizationData();
      await Promise.all([revalidateMemberships(), revalidateInvitations()]);
    },
    [instance, invalidateUserOrganizationData, revalidateMemberships, revalidateInvitations],
  );

  const createOrganization = useCallback(
    async (params: CreateOrganizationParams) => {
      const organization = await instance.createOrganization(params);
      invalidateUserOrganizationData();
      return organization;
    },
    [instance, invalidateUserOrganizationData],
  );

  return useMemo(
    () => ({
      isLoaded,
      userMemberships,
      userInvitations,
      userSuggestions,
      setActive,
      createOrganization,
    }),
    [isLoaded, userMemberships, userInvitations, userSuggestions, setActive, createOrganization],
  );
}
