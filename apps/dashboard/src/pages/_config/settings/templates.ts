import { isPlainObject } from "./patch";

export interface ShortcodeDoc {
  code: string;
  description: string;
}

export const RESERVED_JWT_CLAIMS = ["iss", "sub", "exp", "iat", "nbf", "jti", "azp", "sid", "act", "roles", "role_permissions"] as const;

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
