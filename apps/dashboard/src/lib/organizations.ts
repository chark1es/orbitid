import type { OrganizationMembershipJSON } from "@orbitid/shared";
import { useApi } from "./api";

export const DEFAULT_ORG_ROLES = [
  { key: "org:admin", name: "Admin" },
  { key: "org:member", name: "Member" },
] as const;

interface RolesResponse {
  data?: { key: string; name: string }[];
}

/** Role set for the org's role dropdowns; falls back to the two system roles if the endpoint is unavailable. */
export function useOrganizationRoles(orgId: string | undefined) {
  const query = useApi<RolesResponse>(
    ["org-roles", orgId],
    `/organizations/${orgId}/roles?limit=100`,
    { enabled: !!orgId },
  );
  const roles = (query.data?.data ?? [])
    .filter((role) => !!role?.key)
    .map((role) => ({ key: role.key, name: role.name || role.key }));
  return { roles: roles.length ? roles : DEFAULT_ORG_ROLES.map((role) => ({ ...role })), isLoading: query.isLoading };
}

export function roleLabel(roleKey: string): string {
  return DEFAULT_ORG_ROLES.find((role) => role.key === roleKey)?.name ?? roleKey.replace(/^org:/, "").replace(/[_-]/g, " ");
}

export function membershipUser(membership: OrganizationMembershipJSON) {
  return {
    id: membership.public_user_data.user_id,
    name:
      [membership.public_user_data.first_name, membership.public_user_data.last_name].filter(Boolean).join(" ") ||
      membership.public_user_data.identifier ||
      membership.public_user_data.user_id,
    email: membership.public_user_data.identifier,
    imageUrl: membership.public_user_data.image_url,
  };
}
