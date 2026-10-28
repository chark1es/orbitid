import {
  WEBHOOK_EVENT_TYPES,
  defaultInstanceSettings,
  instanceSettingsSchema,
  type InstanceSettings,
  type SocialProviderConfig,
} from "@orbitid/shared";

/* ------------------------------------------------------------------------------------------------
 * Plain-object helpers
 * ---------------------------------------------------------------------------------------------- */

export type PlainObject = Record<string, unknown>;
export type DeepPatch = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is PlainObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Recursively merge a patch into a base value without mutating either argument. Arrays replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const equalJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------------------------------------
 * Instance settings: masking, normalizing, and PATCH payload construction
 * ---------------------------------------------------------------------------------------------- */

const MASKED_PATTERN = /^[•*x]{4,}$/i;
const PARTIAL_MASK_PATTERN = /^[A-Za-z0-9_-]{0,8}[•*x]{4,}[A-Za-z0-9_-]{0,8}$/;

export function isMaskedSecret(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 4) return false;
  return MASKED_PATTERN.test(value) || PARTIAL_MASK_PATTERN.test(value) || value.includes("•");
}

/** An empty or masked secret means "keep the stored value". */
export function shouldPreserveSecret(value: unknown): boolean {
  return value === undefined || value === null || value === "" || isMaskedSecret(value);
}

/** Dot paths (with `*` wildcards) whose values must never be overwritten by an empty form field. */
export const SECRET_SETTING_PATHS = [
  "email.smtpUrl",
  "security.captchaSecret",
  "sms.twilioAuthToken",
  "social.*.clientSecret",
] as const;

function pathMatches(pattern: string, path: string): boolean {
  const a = pattern.split(".");
  const b = path.split(".");
  if (a.length !== b.length) return false;
  return a.every((part, index) => part === "*" || part === b[index]);
}

const isSecretPath = (path: string, patterns: readonly string[]) => patterns.some((pattern) => pathMatches(pattern, path));

function setAtPath(target: PlainObject, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: PlainObject = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = cursor[part];
    if (!isPlainObject(existing)) cursor[part] = {};
    cursor = cursor[part] as PlainObject;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Produce a partial `InstanceSettings` PATCH body containing only changed paths.
 * Secret paths keep the stored value when the draft value is empty or masked.
 */
export function buildSettingsPatch(
  baseline: unknown,
  draft: unknown,
  secretPaths: readonly string[] = SECRET_SETTING_PATHS,
): DeepPatch {
  const patch: PlainObject = {};

  const walk = (base: unknown, next: unknown, path: string): void => {
    if (isPlainObject(base) && isPlainObject(next)) {
      const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
      for (const key of keys) {
        const childPath = path ? `${path}.${key}` : key;
        if (!(key in next)) {
          // Settings cannot be deleted through the dashboard; omitted keys are no-ops.
          continue;
        }
        walk(base[key], next[key], childPath);
      }
      return;
    }
    if (equalJson(base, next)) return;
    if (isSecretPath(path, secretPaths) && shouldPreserveSecret(next)) return;
    if (next === undefined) return;
    setAtPath(patch, path, next);
  };

  walk(baseline, draft, "");
  return patch;
}

export const hasPatch = (patch: DeepPatch): boolean => Object.keys(patch).length > 0;

/** Merge a server response (full settings or `{ settings }`) onto a known baseline. */
export function mergeSettingsResponse(response: unknown, baseline: InstanceSettings): InstanceSettings {
  const body = isPlainObject(response) && isPlainObject(response.settings) ? response.settings : response;
  if (!isPlainObject(body) || Object.keys(body).length === 0) return instanceSettingsSchema.parse(baseline);
  return instanceSettingsSchema.parse(deepMerge(cloneJson(baseline), body));
}

/** GET /instance may return bare settings or an `{ settings }` envelope; fill missing defaults. */
export function normalizeInstanceSettings(response: unknown): InstanceSettings {
  const body = isPlainObject(response) && isPlainObject(response.settings) ? response.settings : response;
  const merged = deepMerge(defaultInstanceSettings(), isPlainObject(body) ? cloneJson(body) : {});
  return instanceSettingsSchema.parse(merged);
}

/** Blank hidden inputs while retaining a "configured" marker. */
export function secretInputValue(value: string | null | undefined): string {
  if (!value || isMaskedSecret(value)) return "";
  return value;
}

export function secretIsConfigured(value: string | null | undefined): boolean {
  return Boolean(value && (isMaskedSecret(value) || value.length > 0));
}

/* ------------------------------------------------------------------------------------------------
 * Social providers
 * ---------------------------------------------------------------------------------------------- */

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  discord: "Discord",
  microsoft: "Microsoft",
  apple: "Apple",
  facebook: "Facebook",
  twitter: "Twitter",
  linkedin_oidc: "LinkedIn",
  slack: "Slack",
  twitch: "Twitch",
  spotify: "Spotify",
  bitbucket: "Bitbucket",
  dropbox: "Dropbox",
  notion: "Notion",
  hubspot: "HubSpot",
  tiktok: "TikTok",
  coinbase: "Coinbase",
  line: "LINE",
  linear: "Linear",
  huggingface: "Hugging Face",
  box: "Box",
  atlassian: "Atlassian",
  xero: "Xero",
  x: "X",
};

export const PROVIDER_ACCENTS: Record<string, string> = {
  google: "#4285f4",
  github: "#24292f",
  gitlab: "#fc6d26",
  discord: "#5865f2",
  microsoft: "#0078d4",
  apple: "#111111",
  facebook: "#1877f2",
  twitter: "#1d9bf0",
  linkedin_oidc: "#0a66c2",
  slack: "#4a154b",
  twitch: "#9146ff",
  spotify: "#1db954",
  bitbucket: "#0052cc",
  dropbox: "#0061ff",
  notion: "#111111",
  hubspot: "#ff7a59",
  tiktok: "#111111",
  coinbase: "#0052ff",
  line: "#06c755",
  linear: "#5e6ad2",
  huggingface: "#ffcc4d",
  box: "#0061d5",
  atlassian: "#0052cc",
  xero: "#13b5ea",
  x: "#111111",
};

export const PROVIDER_DEFAULT_SCOPES: Record<string, string[]> = {
  google: ["openid", "email", "profile"],
  github: ["read:user", "user:email"],
  gitlab: ["read_user"],
  discord: ["identify", "email"],
  microsoft: ["openid", "email", "profile"],
  apple: ["name", "email"],
  facebook: ["email", "public_profile"],
  twitter: ["tweet.read", "users.read"],
  linkedin_oidc: ["openid", "profile", "email"],
  slack: ["openid", "profile", "email"],
  twitch: ["user:read:email"],
  spotify: ["user-read-email", "user-read-private"],
  bitbucket: ["account", "email"],
  dropbox: ["account_info.read"],
  notion: ["read_user"],
  hubspot: ["oauth"],
  tiktok: ["user.info.basic"],
  coinbase: ["wallet:user:read"],
  line: ["profile", "openid", "email"],
  linear: ["read"],
  huggingface: ["openid", "profile", "email"],
  box: ["openid"],
  atlassian: ["read:me"],
  xero: ["openid", "profile", "email"],
  x: ["users.read", "tweet.read"],
};

export const emptySocialProvider = (): SocialProviderConfig => ({
  enabled: false,
  clientId: "",
  clientSecret: "",
  scopes: [],
  authenticatableAtSignIn: true,
});

export function socialProviderConfig(settings: InstanceSettings, key: string): SocialProviderConfig {
  return { ...emptySocialProvider(), ...(settings.social[key] ?? {}) };
}

export function providerLabel(key: string, config?: SocialProviderConfig): string {
  if (config?.name) return config.name;
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key]!;
  if (key.startsWith("custom_")) return key.slice("custom_".length).replace(/[_-]+/g, " ");
  return key;
}

export function providerInitial(key: string, config?: SocialProviderConfig): string {
  return providerLabel(key, config).trim().charAt(0).toUpperCase() || "?";
}

export function isCustomProviderKey(key: string): boolean {
  return /^custom_[a-z0-9][a-z0-9_-]*$/.test(key);
}

export function oauthCallbackUrl(apiUrl: string, provider: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/oauth_callback/${provider}`;
}

/* ------------------------------------------------------------------------------------------------
 * Webhook events
 * ---------------------------------------------------------------------------------------------- */

const RESOURCE_LABELS: Record<string, string> = {
  user: "Users",
  session: "Sessions",
  email: "Emails",
  sms: "SMS",
  organization: "Organizations",
  organizationMembership: "Organization memberships",
  organizationInvitation: "Organization invitations",
  organizationDomain: "Organization domains",
  role: "Roles",
  permission: "Permissions",
  waitlistEntry: "Waitlist entries",
  invitation: "Invitations",
  apiKey: "API keys",
};

export interface WebhookEventGroup {
  resource: string;
  label: string;
  events: string[];
}

/** Group event types by resource in the declared order of `WEBHOOK_EVENT_TYPES`. */
export function groupWebhookEvents(types: readonly string[] = WEBHOOK_EVENT_TYPES): WebhookEventGroup[] {
  const groups = new Map<string, string[]>();
  for (const type of types) {
    const resource = type.split(".")[0]!;
    const bucket = groups.get(resource);
    if (bucket) bucket.push(type);
    else groups.set(resource, [type]);
  }
  return [...groups.entries()].map(([resource, events]) => ({
    resource,
    label: RESOURCE_LABELS[resource] ?? resource.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()),
    events,
  }));
}

export function describeWebhookEvent(type: string): string {
  const action = type.split(".")[1] ?? "";
  return action.replace(/_/g, " ");
}

/* ------------------------------------------------------------------------------------------------
 * JWT template shortcodes + local preview
 * ---------------------------------------------------------------------------------------------- */

export interface ShortcodeDoc {
  code: string;
  description: string;
}

export const RESERVED_JWT_CLAIMS = ["iss", "sub", "exp", "iat", "nbf", "jti", "azp", "sid", "act"] as const;

export function reservedJwtClaimErrors(claims: Record<string, unknown>): string[] {
  return Object.keys(claims)
    .filter((key) => (RESERVED_JWT_CLAIMS as readonly string[]).includes(key) || key.startsWith("org_"))
    .map((key) => `"${key}" is reserved and cannot be set by a template.`);
}

export const SESSION_SHORTCODES: ShortcodeDoc[] = [
  { code: "{{user.id}}", description: "User ID" },
  { code: "{{user.first_name}}", description: "First name" },
  { code: "{{user.last_name}}", description: "Last name" },
  { code: "{{user.full_name}}", description: "Full name" },
  { code: "{{user.primary_email_address}}", description: "Primary email address" },
  { code: "{{user.primary_phone_number}}", description: "Primary phone number" },
  { code: "{{user.username}}", description: "Username" },
  { code: "{{user.image_url}}", description: "Profile image URL" },
  { code: "{{user.email_verified}}", description: "Whether the primary email is verified" },
  { code: "{{user.public_metadata}}", description: "Public metadata object" },
  { code: "{{user.unsafe_metadata}}", description: "Unsafe metadata object" },
  { code: "{{user.created_at}}", description: "Creation timestamp (ms)" },
  { code: "{{org.id}}", description: "Active organization ID" },
  { code: "{{org.slug}}", description: "Active organization slug" },
  { code: "{{org.name}}", description: "Active organization name" },
  { code: "{{org.role}}", description: "Caller's role in the organization" },
  { code: "{{org.public_metadata}}", description: "Organization public metadata" },
  { code: "{{org_membership.permissions}}", description: "Organization permission keys" },
  { code: "{{session.id}}", description: "Session ID" },
  { code: "{{session.actor}}", description: "Impersonation actor object" },
];

export const SAMPLE_TEMPLATE_CONTEXT = {
  user: {
    id: "user_2abcDEF123",
    first_name: "Ada",
    last_name: "Lovelace",
    full_name: "Ada Lovelace",
    primary_email_address: "ada@example.com",
    primary_phone_number: "+15551234567",
    username: "ada",
    image_url: "https://example.com/avatar.png",
    email_verified: true,
    phone_number_verified: true,
    created_at: 1700000000000,
    public_metadata: { plan: "pro", features: ["analytics"] },
    unsafe_metadata: { onboarding_complete: true },
  },
  org: {
    id: "org_2xyz789",
    slug: "acme",
    name: "Acme Inc",
    role: "org:admin",
    public_metadata: { tier: "enterprise" },
  },
  org_membership: {
    permissions: ["org:sys_memberships:manage", "org:sys_profile:read"],
  },
  session: {
    id: "sess_2session",
    actor: null as Record<string, unknown> | null,
  },
};

export type TemplateContext = typeof SAMPLE_TEMPLATE_CONTEXT;

export function resolveShortcodePath(path: string, context: unknown): unknown {
  let cursor: unknown = context;
  for (const part of path.trim().split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

const stringifyShortcodeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
};

const WHOLE_SHORTCODE = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;
const SHORTCODE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Resolve one claim string. A claim that is exactly one shortcode keeps the resolved JSON type.
 * `{{a}} || {{b}}` falls back when the previous value is null/undefined/empty.
 */
export function renderTemplateString(template: string, context: unknown = SAMPLE_TEMPLATE_CONTEXT): unknown {
  const whole = WHOLE_SHORTCODE.exec(template);
  const parts = template.split("||").map((part) => part.trim());
  if (parts.length > 1) {
    for (const part of parts) {
      const match = WHOLE_SHORTCODE.exec(part);
      if (!match) continue;
      const value = resolveShortcodePath(match[1]!, context);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    const last = parts[parts.length - 1]!;
    const lastMatch = WHOLE_SHORTCODE.exec(last);
    if (lastMatch) return resolveShortcodePath(lastMatch[1]!, context) ?? null;
  }
  if (whole) {
    const value = resolveShortcodePath(whole[1]!, context);
    return value === undefined ? null : value;
  }
  return template.replace(SHORTCODE, (_token, path: string) => stringifyShortcodeValue(resolveShortcodePath(path, context)));
}

/** Recursively render a template's claims against a sample context for the editor preview. */
export function previewTemplateClaims(claims: unknown, context: unknown = SAMPLE_TEMPLATE_CONTEXT): unknown {
  if (typeof claims === "string") return renderTemplateString(claims, context);
  if (Array.isArray(claims)) return claims.map((value) => previewTemplateClaims(value, context));
  if (isPlainObject(claims)) {
    return Object.fromEntries(Object.entries(claims).map(([key, value]) => [key, previewTemplateClaims(value, context)]));
  }
  return claims;
}

/** Insert a shortcode at the current textarea selection. Returns the next value and caret index. */
export function insertAtCursor(
  value: string,
  insertion: string,
  selectionStart: number | null,
  selectionEnd: number | null,
): { value: string; caret: number } {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  return { value: next, caret: start + insertion.length };
}

/* ------------------------------------------------------------------------------------------------
 * Roles and permissions
 * ---------------------------------------------------------------------------------------------- */

export const SYSTEM_ROLE_KEYS = ["org:admin", "org:member"] as const;
const ROLE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Custom role keys are `org:<slug>` (no additional colons). Returns an error message or null. */
export function roleKeyError(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "Role key is required.";
  if (!trimmed.startsWith("org:")) return "Role key must start with `org:`.";
  const slug = trimmed.slice(4);
  if (!slug) return "Add a role name after `org:`.";
  if (slug.includes(":")) return "Role keys cannot contain additional colons (for example `org:billing`).";
  if (slug.startsWith("sys_")) return "Keys starting with `org:sys_` are reserved for system roles.";
  if (!ROLE_SLUG.test(slug)) return "Use lowercase letters, numbers, dashes or underscores after `org:`.";
  return null;
}

/** Custom permission keys are `org:<feature>:<action>`. */
export function permissionKeyError(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "Permission key is required.";
  const parts = trimmed.split(":");
  if (parts.length !== 3) return "Permission key must be `org:<feature>:<action>`.";
  const [prefix, feature, action] = parts as [string, string, string];
  if (prefix !== "org") return "Permission key must start with `org:`.";
  if (feature.startsWith("sys_")) return "Features starting with `sys_` are reserved for system permissions.";
  if (!ROLE_SLUG.test(feature)) return "Feature must use lowercase letters, numbers, dashes or underscores.";
  if (!ROLE_SLUG.test(action)) return "Action must use lowercase letters, numbers, dashes or underscores.";
  return null;
}

export const isSystemRole = (role: { key: string; is_system?: boolean }): boolean =>
  role.is_system === true || (SYSTEM_ROLE_KEYS as readonly string[]).includes(role.key);

export function permissionFeature(key: string): string {
  return key.split(":")[1] ?? "general";
}

/* ------------------------------------------------------------------------------------------------
 * Generic form helpers
 * ---------------------------------------------------------------------------------------------- */

export function errorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

export function parseJsonRecord(text: string): { value: Record<string, unknown>; error: null } | { value: null; error: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return { value: null, error: "Expected a JSON object." };
    return { value: parsed, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function textToList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function listToText(values: readonly string[] | undefined): string {
  return (values ?? []).join(", ");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isValidDomain(value: string): boolean {
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(domain);
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "").replace(/\/.*$/, "");
}

export function normalizeRestrictionIdentifier(
  kind: "email" | "domain" | "phone",
  value: string,
): { identifier: string; identifier_type: "email_address" | "phone_number" } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (kind === "phone") {
    return { identifier: trimmed, identifier_type: "phone_number" };
  }
  if (kind === "domain") {
    const domain = normalizeDomain(trimmed);
    if (!isValidDomain(domain)) return null;
    return { identifier: `@${domain}`, identifier_type: "email_address" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return { identifier: trimmed.toLowerCase(), identifier_type: "email_address" };
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toDateInput(timestamp: number | null | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function fromDateInput(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59.999`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function fromDateInputStart(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "disabled";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

export function truncate(value: string, length = 48): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

