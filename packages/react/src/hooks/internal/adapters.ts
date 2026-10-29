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
import { cachedRequest, resourceIdentity } from "./requestCache";

/** Page arguments plus the cache bypass used by `revalidate()`. */
export type FetchArgs = PaginationQuery & { force?: boolean };

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
const pageKey = (args: PaginationQuery) => `${args.limit ?? "all"}:${args.offset ?? 0}`;
/** `id#instance` segment: same resource name, different SDK instance → different cache entry. */
const identity = (resource: { id: string }) => `${resource.id}:${resourceIdentity(resource)}`;

export async function fetchOrganizationMemberships(
  organization: OrganizationResource | null,
  args: FetchArgs,
  extra?: { role?: string; query?: string },
): Promise<PaginatedResult<OrganizationMembershipResource>> {
  const method = organization?.getMemberships;
  if (!organization || typeof method !== "function") return EMPTY();
  const key = `org:${identity(organization)}:memberships:${pageKey(args)}:${extra?.role ?? ""}:${extra?.query ?? ""}`;
  const result = await cachedRequest(
    key,
    async () =>
      normalizePaginated<OrganizationMembershipResource>(
        await method.call(organization, { ...paging(args), ...extra }),
      ),
    { force: args.force },
  );
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchOrganizationInvitations(
  organization: OrganizationResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<OrganizationInvitationResource>> {
  const method = organization?.getInvitations;
  if (!organization || typeof method !== "function") return EMPTY();
  const rows = await cachedRequest(
    `org:${identity(organization)}:invitations`,
    async () => normalizePaginated<OrganizationInvitationResource>(await method.call(organization)).data,
    { force: args.force },
  );
  return paginateLocal<OrganizationInvitationResource>(rows, args);
}

export async function fetchOrganizationDomains(
  organization: OrganizationResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<OrganizationDomainResource>> {
  const method = organization?.getDomains;
  if (!organization || typeof method !== "function") return EMPTY();
  const rows = await cachedRequest(
    `org:${identity(organization)}:domains`,
    async () => normalizePaginated<OrganizationDomainResource>(await method.call(organization)).data,
    { force: args.force },
  );
  return paginateLocal<OrganizationDomainResource>(rows, args);
}

export async function fetchOrganizationMembershipRequests(
  organization: OrganizationResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<OrganizationMembershipRequestResource>> {
  const method = organization?.getMembershipRequests;
  if (!organization || typeof method !== "function") return EMPTY();
  const rows = await cachedRequest(
    `org:${identity(organization)}:membership_requests`,
    async () =>
      normalizePaginated<OrganizationMembershipRequestResource>(await method.call(organization)).data,
    { force: args.force },
  );
  const result = paginateLocal<OrganizationMembershipRequestResource>(rows, args);
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchOrganizationApiKeys(
  organization: OrganizationResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<ApiKeyResource>> {
  const list = organization?.apiKeys?.list;
  if (!organization || typeof list !== "function") return EMPTY();
  return cachedRequest(
    `org:${identity(organization)}:api_keys:${pageKey(args)}`,
    async () => normalizePaginated<ApiKeyResource>(await list.call(organization.apiKeys, paging(args))),
    { force: args.force },
  );
}

export async function fetchUserMemberships(
  user: UserResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<OrganizationMembershipResource>> {
  const method = user?.getOrganizationMemberships;
  if (!user || typeof method !== "function") return EMPTY();
  const result = await cachedRequest(
    `user:${identity(user)}:organization_memberships:${pageKey(args)}`,
    async () =>
      normalizePaginated<OrganizationMembershipResource>(
        await method.call(user, { ...paging(args), page: args.page }),
      ),
    { force: args.force },
  );
  result.data.forEach(withPublicUserDataAliases);
  return result;
}

export async function fetchUserInvitations(
  user: UserResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<UserOrganizationInvitationResource>> {
  const method = user?.getOrganizationInvitations;
  if (!user || typeof method !== "function") return EMPTY();
  const rows = await cachedRequest(
    `user:${identity(user)}:organization_invitations`,
    async () =>
      normalizePaginated<UserOrganizationInvitationResource>(await method.call(user)).data,
    { force: args.force },
  );
  return paginateLocal<UserOrganizationInvitationResource>(rows, args);
}

export async function fetchUserSuggestions(
  user: UserResource | null,
  args: FetchArgs,
): Promise<PaginatedResult<OrganizationSuggestionResource>> {
  const method = user?.getOrganizationSuggestions;
  if (!user || typeof method !== "function") return EMPTY();
  const rows = await cachedRequest(
    `user:${identity(user)}:organization_suggestions`,
    async () =>
      normalizePaginated<OrganizationSuggestionResource>(await method.call(user)).data,
    { force: args.force },
  );
  const result = paginateLocal<OrganizationSuggestionResource>(rows, args);
  result.data.forEach(withOrganizationDataAliases);
  return result;
}

/** Current user's membership in the active organization (backs `useOrganization().membership`). */
export async function fetchActiveMembership(
  user: UserResource | null,
  organizationId: string | null,
  options: { force?: boolean } = {},
): Promise<OrganizationMembershipResource | null> {
  if (!user || !organizationId) return null;
  const page = await fetchUserMemberships(user, { limit: 100, offset: 0, force: options.force });
  return page.data.find((membership) => membership.organization?.id === organizationId) ?? null;
}
