import { withOrganizationDataAliases, withPublicUserDataAliases } from "../../lib/resources";
import type {
  ApiKeyResource,
  OrganizationDomainResource,
  OrganizationInvitationResource,
  OrganizationMembershipRequestResource,
  OrganizationMembershipResource,
  OrganizationResource,
  OrganizationSuggestionResource,
  PaginatedResult,
  PaginationQuery,
  UserOrganizationInvitationResource,
  UserResource,
} from "../../provider/types";

const EMPTY = <T,>(): PaginatedResult<T> => ({ data: [], totalCount: 0 });

/**
 * Pagination envelopes have shipped in several shapes; accept `{ data, totalCount }`,
 * `{ data, total_count }`, `{ response: ... }` and bare arrays.
 */
export function normalizePaginated<T>(value: unknown): PaginatedResult<T> {
  if (Array.isArray(value)) {
    const rows = value as T[];
    return { data: rows, totalCount: rows.length };
  }
  if (value === null || typeof value !== "object") return EMPTY<T>();

  if ("data" in value && Array.isArray(value.data)) {
    const rows = value.data as T[];
    const total =
      "totalCount" in value && typeof value.totalCount === "number"
        ? value.totalCount
        : "total_count" in value && typeof value.total_count === "number"
          ? value.total_count
          : rows.length;
    return { data: rows, totalCount: total };
  }
  if ("response" in value) return normalizePaginated<T>(value.response);
  return EMPTY<T>();
}

/** SDK list endpoints return every row; slice locally so `usePagedResource` can page them. */
function paginateLocal<T>(rows: unknown, args: PaginationQuery): PaginatedResult<T> {
  const normalized = normalizePaginated<T>(rows);
  const offset = args.offset ?? 0;
  const limit = args.limit ?? normalized.data.length;
  return { data: normalized.data.slice(offset, offset + limit), totalCount: normalized.totalCount };
}

const paging = (args: PaginationQuery) => ({ limit: args.limit, offset: args.offset });

export async function fetchOrganizationMemberships(
  organization: OrganizationResource | null,
  args: PaginationQuery,
  extra?: { role?: string; query?: string },
): Promise<PaginatedResult<OrganizationMembershipResource>> {
  const method = organization?.getMemberships;
  if (!organization || typeof method !== "function") return EMPTY();
  const result = normalizePaginated<OrganizationMembershipResource>(
    await method.call(organization, { ...paging(args), ...extra }),
  );
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchOrganizationInvitations(
  organization: OrganizationResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<OrganizationInvitationResource>> {
  const method = organization?.getInvitations;
  if (!organization || typeof method !== "function") return EMPTY();
  return paginateLocal<OrganizationInvitationResource>(await method.call(organization), args);
}

export async function fetchOrganizationDomains(
  organization: OrganizationResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<OrganizationDomainResource>> {
  const method = organization?.getDomains;
  if (!organization || typeof method !== "function") return EMPTY();
  return paginateLocal<OrganizationDomainResource>(await method.call(organization), args);
}

export async function fetchOrganizationMembershipRequests(
  organization: OrganizationResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<OrganizationMembershipRequestResource>> {
  const method = organization?.getMembershipRequests;
  if (!organization || typeof method !== "function") return EMPTY();
  const result = paginateLocal<OrganizationMembershipRequestResource>(await method.call(organization), args);
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchOrganizationApiKeys(
  organization: OrganizationResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<ApiKeyResource>> {
  const list = organization?.apiKeys?.list;
  if (!organization || typeof list !== "function") return EMPTY();
  return normalizePaginated<ApiKeyResource>(await list.call(organization.apiKeys, paging(args)));
}

export async function fetchUserMemberships(
  user: UserResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<OrganizationMembershipResource>> {
  const method = user?.getOrganizationMemberships;
  if (!user || typeof method !== "function") return EMPTY();
  const result = normalizePaginated<OrganizationMembershipResource>(
    await method.call(user, { ...paging(args), page: args.page }),
  );
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchUserInvitations(
  user: UserResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<UserOrganizationInvitationResource>> {
  const method = user?.getOrganizationInvitations;
  if (!user || typeof method !== "function") return EMPTY();
  return paginateLocal<UserOrganizationInvitationResource>(await method.call(user), args);
}

export async function fetchUserSuggestions(
  user: UserResource | null,
  args: PaginationQuery,
): Promise<PaginatedResult<OrganizationSuggestionResource>> {
  const method = user?.getOrganizationSuggestions;
  if (!user || typeof method !== "function") return EMPTY();
  const result = paginateLocal<OrganizationSuggestionResource>(await method.call(user), args);
  result.data.forEach(withOrganizationDataAliases);
  return result;
}

/** Current user's membership in the active organization (backs `useOrganization().membership`). */
export async function fetchActiveMembership(
  user: UserResource | null,
  organizationId: string | null,
): Promise<OrganizationMembershipResource | null> {
  if (!user || !organizationId) return null;
  const page = await fetchUserMemberships(user, { limit: 100, offset: 0 });
  return page.data.find((membership) => membership.organization?.id === organizationId) ?? null;
}
