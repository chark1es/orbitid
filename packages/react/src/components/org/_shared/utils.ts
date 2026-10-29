import type {
  EnvironmentResource,
  MembershipPublicUserData,
} from "../../../provider";

/** System permissions enforced by the Frontend API (see ARCHITECTURE.md → Organizations). */
export const ORG_PERMISSIONS = {
  profileManage: "org:sys_profile:manage",
  profileDelete: "org:sys_profile:delete",
  membershipsRead: "org:sys_memberships:read",
  membershipsManage: "org:sys_memberships:manage",
  domainsRead: "org:sys_domains:read",
  domainsManage: "org:sys_domains:manage",
} as const;

const SYSTEM_PERMISSIONS: readonly string[] = Object.values(ORG_PERMISSIONS);

interface MembershipLike {
  role: string;
  permissions?: string[];
}

/** True when the membership carries `permission` (admins without a permission list pass). */
export function hasPermission(
  membership: MembershipLike | null | undefined,
  permission: string,
): boolean {
  if (!membership) return false;
  const permissions = membership.permissions;
  if (Array.isArray(permissions)) {
    if (permissions.includes(permission)) return true;
    if (permissions.length > 0) return false;
  }
  return membership.role === "org:admin" && SYSTEM_PERMISSIONS.includes(permission);
}

/** Membership display name from `publicUserData`, falling back to the identifier. */
export function membershipDisplayName(
  data: Pick<MembershipPublicUserData, "firstName" | "lastName" | "identifier"> | null | undefined,
): string {
  if (!data) return "";
  const name = [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
  return name || data.identifier || "";
}

/** Up to two initials for avatar fallbacks. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s._-]/gu, " ")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Lowercase, accent-free, hyphenated slug. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Domain format check for the domains section (`example.com`, `sub.example.co.uk`). */
export function isValidDomain(value: string): boolean {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(value.trim());
}

/** Deliberately permissive email check (the server is the authority). */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Trims and dedupes addresses case-insensitively, preserving order and original casing. */
export function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of emails) {
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(email);
  }
  return result;
}

/** Splits pasted text on commas, semicolons or whitespace. */
export function splitEmails(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Short absolute date, locale-aware. */
export function formatDate(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

/** Whether an API key expiration (epoch ms) has passed. */
export function isApiKeyExpired(expiration: number | null | undefined, now = Date.now()): boolean {
  return typeof expiration === "number" && expiration > 0 && expiration <= now;
}

/** Resolves `RedirectUrl` props. */
export function resolveRedirect<T>(
  value: string | ((resource: T) => string) | undefined,
  resource: T,
): string | undefined {
  if (!value) return undefined;
  return typeof value === "function" ? value(resource) : value;
}

/** Fills `:id` / `:slug` placeholders in `after*Url` values. */
export function fillUrlTemplate(
  url: string,
  values: Record<string, string | undefined>,
): string {
  return url.replace(/:([a-zA-Z_]+)/g, (match, key: string) =>
    values[key] !== undefined ? String(values[key]) : match,
  );
}

/** Localized role label with the API's `roleName` as the first fallback. */
export function roleLabel(
  role: string,
  roleName: string | undefined,
  t: (key: string) => string,
): string {
  if (roleName) return roleName;
  if (role === "org:admin") return t("membershipRole__admin");
  if (role === "org:member") return t("membershipRole__basicMember");
  return role;
}

/** Default page size for the org tables. */
export const DEFAULT_PAGE_SIZE = 10;

/** Organization env settings normalized from camelCase or snake_case environment payloads. */
export interface OrgEnvironmentSettings {
  enabled: boolean;
  creationEnabled: boolean;
  slugEnabled: boolean;
  domainsEnabled: boolean;
  membershipRequestsEnabled: boolean;
  maxAllowedMemberships: number;
  /** Organizations one user may create, or `null` for no limit. */
  maxCreatedOrganizationsPerUser: number | null;
  forceOrganizationSelection: boolean;
  creatorRole: string;
  defaultRole: string;
}

const readRaw = (environment: EnvironmentResource | null): Record<string, unknown> =>
  (environment?.organizationSettings ?? environment?.organization_settings ?? {}) as Record<
    string,
    unknown
  >;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value ? value : fallback;

/** Reads organization settings from either casing, with defaults. */
export function readOrgSettings(environment: EnvironmentResource | null): OrgEnvironmentSettings {
  const raw = readRaw(environment);
  return {
    enabled: bool(raw.enabled, true),
    creationEnabled: bool(raw.creationEnabled ?? raw.creation_enabled, true),
    slugEnabled: bool(raw.slugEnabled ?? raw.slug_enabled, true),
    domainsEnabled: bool(raw.domainsEnabled ?? raw.domains_enabled, false),
    membershipRequestsEnabled: bool(
      raw.membershipRequestsEnabled ?? raw.membership_requests_enabled,
      false,
    ),
    maxAllowedMemberships: num(raw.maxAllowedMemberships ?? raw.max_allowed_memberships, 0),
    maxCreatedOrganizationsPerUser:
      typeof (raw.maxCreatedOrganizationsPerUser ?? raw.max_created_organizations_per_user) === "number"
        ? Number(raw.maxCreatedOrganizationsPerUser ?? raw.max_created_organizations_per_user)
        : null,
    forceOrganizationSelection: bool(
      raw.forceOrganizationSelection ?? raw.force_organization_selection,
      false,
    ),
    creatorRole: str(raw.creatorRole ?? raw.creator_role, "org:admin"),
    defaultRole: str(raw.defaultRole ?? raw.default_role, "org:member"),
  };
}

/** System roles first, then custom roles alphabetically. */
const ROLE_ORDER: Record<string, number> = { "org:admin": 0, "org:member": 1 };

export function sortRoleKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const rankA = ROLE_ORDER[a] ?? 100;
    const rankB = ROLE_ORDER[b] ?? 100;
    if (rankA !== rankB) return rankA - rankB;
    return a.localeCompare(b);
  });
}

/** Data URL preview for an uploaded image (logos). */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}
