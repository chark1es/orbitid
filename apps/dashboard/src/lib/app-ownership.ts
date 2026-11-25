import type { OAuthApplicationJSON, OrganizationJSON } from "@orbitid/shared";
import { apiAllPages, useApi } from "./api";

/** Every organization, for owner pickers and owner labels. Shares the `organizations` cache prefix. */
export function useAllOrganizations(enabled = true) {
  const query = useApi<{ data: OrganizationJSON[]; total_count: number }>(["organizations", "all"], "/organizations", {
    queryFn: ({ signal }) => apiAllPages<OrganizationJSON>("/organizations", { signal }),
    enabled,
  });
  return { ...query, organizations: query.data?.data ?? [] };
}

/** Every OAuth application. Shares the cache key the OAuth applications page refetches. */
export function useAllOAuthApplications(enabled = true) {
  const query = useApi<{ data: OAuthApplicationJSON[]; total_count: number }>(["oauth_applications"], "/oauth_applications", {
    queryFn: ({ signal }) => apiAllPages<OAuthApplicationJSON>("/oauth_applications", { signal }),
    enabled,
  });
  return { ...query, applications: query.data?.data ?? [] };
}

/** The owner shown for an application: the organization's name, or "Instance-wide" for applications any user may use. */
export function ownerLabel(organizationId: string | null | undefined, organizations: OrganizationJSON[]): string {
  if (!organizationId) return "Instance-wide";
  return organizations.find((organization) => organization.id === organizationId)?.name ?? organizationId;
}
