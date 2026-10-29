import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAsyncValue,
  useAuth,
  useOrbitID,
  useOrganization,
  useOrganizationList,
  useUser,
  type PagedResource,
  type UseOrganizationListReturn,
  type UseOrganizationReturn,
} from "../../../hooks";
import { getErrorMessage, isErrorCode } from "../../../lib/errors";
import { useLocalizations } from "../../../localization";
import type {
  OrganizationMembershipResource,
  OrganizationResource,
  RoleResource,
  UserResource,
} from "../../../provider";
import {
  DEFAULT_PAGE_SIZE,
  hasPermission,
  readOrgSettings,
  roleLabel,
  sortRoleKeys,
  type OrgEnvironmentSettings,
} from "./utils";
import type { RoleOption } from "./types";

// ---------------------------------------------------------------------------------------------
// Active organization, its collections and environment settings
// ---------------------------------------------------------------------------------------------

export interface OrgScope {
  organization: OrganizationResource | null;
  /** Caller's membership in the active organization (role + permissions). */
  membership: OrganizationMembershipResource | null;
  memberships: UseOrganizationReturn["memberships"];
  invitations: UseOrganizationReturn["invitations"];
  domains: UseOrganizationReturn["domains"];
  membershipRequests: UseOrganizationReturn["membershipRequests"];
  settings: OrgEnvironmentSettings;
  isLoaded: boolean;
  /** Whether the caller holds an org system permission. */
  can: (permission: string) => boolean;
}

export interface UseOrgScopeParams {
  memberships?: boolean;
  invitations?: boolean;
  domains?: boolean;
  membershipRequests?: boolean;
  /** Member search term (`?query=`). */
  memberQuery?: string;
  role?: string;
  pageSize?: number;
}

/** Active organization + the paginated collections the org components render. */
export function useOrgScope(params: UseOrgScopeParams = {}): OrgScope {
  const instance = useOrbitID();
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  const settings = useMemo(() => readOrgSettings(instance.environment), [instance.environment]);
  const org = useOrganization({
    memberships:
      params.memberships === false
        ? false
        : { pageSize, query: params.memberQuery, role: params.role },
    invitations: params.invitations === false ? false : { pageSize },
    domains: settings.domainsEnabled && params.domains !== false ? { pageSize: 50 } : false,
    membershipRequests:
      settings.membershipRequestsEnabled && params.membershipRequests !== false
        ? { pageSize }
        : false,
  });
  const membership = org.membership;
  const can = useCallback((permission: string) => hasPermission(membership, permission), [membership]);
  return {
    organization: org.organization,
    membership,
    memberships: org.memberships,
    invitations: org.invitations,
    domains: org.domains,
    membershipRequests: org.membershipRequests,
    settings,
    isLoaded: org.isLoaded,
    can,
  };
}

/** Organization settings from `GET /v1/client/environment`. */
export function useOrgSettings(): OrgEnvironmentSettings {
  const instance = useOrbitID();
  return useMemo(() => readOrgSettings(instance.environment), [instance.environment]);
}

// ---------------------------------------------------------------------------------------------
// User-side organization data
// ---------------------------------------------------------------------------------------------

export interface UserOrgScope {
  memberships: UseOrganizationListReturn["userMemberships"];
  invitations: UseOrganizationListReturn["userInvitations"];
  suggestions: UseOrganizationListReturn["userSuggestions"];
  setActive: UseOrganizationListReturn["setActive"];
  createOrganization: UseOrganizationListReturn["createOrganization"];
  isLoaded: boolean;
}

/** Memberships/invitations/suggestions for the signed-in user (switcher + organization list). */
export function useUserOrgScope(pageSize = 100): UserOrgScope {
  const list = useOrganizationList({
    userMemberships: { pageSize },
    userInvitations: { pageSize },
    userSuggestions: { pageSize },
  });
  return {
    memberships: list.userMemberships,
    invitations: list.userInvitations,
    suggestions: list.userSuggestions,
    setActive: list.setActive,
    createOrganization: list.createOrganization,
    isLoaded: list.isLoaded,
  };
}

export interface PaginatedTable<T> {
  items: T[];
  page: number;
  pageCount: number;
  totalCount: number;
  pageSize: number;
  isLoading: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNext: () => Promise<void>;
  onPrevious: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Binds a `PagedResource` to the shared table + `PaginationBar` props. */
export function usePaginatedTable<T>(
  resource: PagedResource<T>,
  pageSize = DEFAULT_PAGE_SIZE,
): PaginatedTable<T> {
  return {
    items: resource.data,
    page: resource.page,
    pageCount: resource.pageCount,
    totalCount: resource.count,
    pageSize,
    isLoading: resource.isFetching,
    hasNextPage: resource.hasNextPage,
    hasPreviousPage: resource.hasPreviousPage,
    onNext: resource.fetchNext,
    onPrevious: resource.fetchPrevious,
    reload: resource.revalidate,
  };
}

/** Debounces a rapidly changing value (member/invitation search). */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Creates an organization and switches to it; no user-side collections are fetched. */
export function useOrganizationCreator(): Pick<UserOrgScope, "createOrganization" | "setActive"> {
  const list = useOrganizationList({
    userMemberships: false,
    userInvitations: false,
    userSuggestions: false,
  });
  return { createOrganization: list.createOrganization, setActive: list.setActive };
}

export interface OrganizationCreationQuota {
  /** Organizations the signed-in user created. */
  created: number;
  /** Configured limit, `null` when the instance sets none. */
  max: number | null;
  reached: boolean;
}

/**
 * Whether the user may still create an organization. Counts the user's memberships whose
 * organization reports them as `createdBy`; servers that omit `created_by` never reach a limit.
 */
export function useOrganizationCreationQuota(): OrganizationCreationQuota {
  const settings = useOrgSettings();
  const { user } = useUser();
  const list = useOrganizationList({
    userMemberships: { pageSize: 100 },
    userInvitations: false,
    userSuggestions: false,
  });
  const memberships = list.userMemberships.data;
  return useMemo(() => {
    const created = user
      ? memberships.filter((membership) => membership.organization?.createdBy === user.id).length
      : 0;
    const max = settings.maxCreatedOrganizationsPerUser;
    return { created, max, reached: max !== null && created >= max };
  }, [memberships, settings.maxCreatedOrganizationsPerUser, user]);
}

/** Display name + id of the signed-in user (personal account row). */
export function useSelfUser(): { id: string | null; name: string; user: UserResource | null } {
  const { isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const name = useMemo(() => {
    if (!user) return "";
    const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    return full || user.username || user.primaryEmailAddress?.emailAddress || user.id;
  }, [user]);
  return { id: isSignedIn ? (userId ?? user?.id ?? null) : null, name, user: user ?? null };
}

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

function toRoleOptions(
  roles: RoleResource[] | null | undefined,
  t: (key: string) => string,
): RoleOption[] {
  if (!roles || roles.length === 0) {
    return [
      { key: "org:admin", name: t("membershipRole__admin") },
      { key: "org:member", name: t("membershipRole__basicMember") },
    ];
  }
  const byKey = new Map(roles.map((role) => [role.key, role]));
  return sortRoleKeys(roles.map((role) => role.key)).map((key) => {
    const role = byKey.get(key);
    return { key, name: roleLabel(key, role?.name, t) };
  });
}

/**
 * Role options from `GET /organizations/:id/roles`; falls back to the two system roles while
 * loading or when the endpoint is unavailable.
 */
export function useOrganizationRoles(
  organization: OrganizationResource | null,
  enabled = true,
): { roles: RoleOption[]; isLoading: boolean; revalidate: () => Promise<void> } {
  const { t } = useLocalizations();
  const fetcher = useMemo(() => {
    if (!organization || !enabled) return null;
    return async () => organization.getRoles({ limit: 100 });
  }, [organization, enabled]);
  const { data, isLoading, revalidate } = useAsyncValue<RoleResource[]>({
    key: `org:${organization?.id ?? "none"}:roles`,
    fetcher,
    enabled: enabled && Boolean(organization),
  });
  const roles = useMemo(() => toRoleOptions(data, t), [data, t]);
  return { roles, isLoading, revalidate };
}

// ---------------------------------------------------------------------------------------------
// Mutations, errors, navigation, clipboard
// ---------------------------------------------------------------------------------------------

export interface AsyncAction<Args extends unknown[], Result> {
  run: (...args: Args) => Promise<Result | undefined>;
  isPending: boolean;
  error: unknown;
  reset: () => void;
}

/** Runs a resource mutation, exposing pending/error state instead of throwing. */
export function useAsyncAction<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): AsyncAction<Args, Result> {
  const actionRef = useRef(action);
  actionRef.current = action;
  const [state, setState] = useState<{ isPending: boolean; error: unknown }>({
    isPending: false,
    error: null,
  });
  const run = useCallback(async (...args: Args) => {
    setState({ isPending: true, error: null });
    try {
      const result = await actionRef.current(...args);
      setState({ isPending: false, error: null });
      return result;
    } catch (error) {
      setState({ isPending: false, error });
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setState({ isPending: false, error: null }), []);
  return { run, isPending: state.isPending, error: state.error, reset };
}

/** Localized message for an API error (`unstable__errors.<code>` first). */
export function useOrgErrorText(error: unknown): string | null {
  const { t } = useLocalizations();
  return useMemo(() => (error ? getErrorMessage(error, t) : null), [error, t]);
}

export const isLastAdminError = (error: unknown): boolean =>
  isErrorCode(error, "organization_minimum_permissions_needed");

/** Push a URL through the SDK router, provider router or the browser. */
export function useNavigate(): (to: string) => void {
  const instance = useOrbitID();
  return useCallback(
    (to: string) => {
      if (typeof instance.navigate === "function") {
        void instance.navigate(to);
        return;
      }
      const options: unknown = instance.options;
      const push =
        options && typeof options === "object"
          ? (options as { routerPush?: (url: string) => unknown }).routerPush
          : undefined;
      if (typeof push === "function") {
        void push(to);
        return;
      }
      if (typeof window !== "undefined") window.location.assign(to);
    },
    [instance],
  );
}

export interface ClipboardState {
  copied: boolean;
  copy: (text: string) => Promise<boolean>;
}

/** Clipboard helper with an `execCommand` fallback for insecure contexts. */
export function useClipboard(resetAfterMs = 2000): ClipboardState {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (text: string) => {
      let ok = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok) {
        try {
          const area = document.createElement("textarea");
          area.value = text;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          ok = document.execCommand("copy");
          document.body.removeChild(area);
        } catch {
          ok = false;
        }
      }
      setCopied(ok);
      if (ok) {
        window.setTimeout(() => setCopied(false), resetAfterMs);
      }
      return ok;
    },
    [resetAfterMs],
  );
  return { copied, copy };
}
