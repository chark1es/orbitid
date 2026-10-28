// JWT template shortcode engine + lookup.
import { eq } from "drizzle-orm";
import * as s from "../db/schema";
import { DEFAULT_AVATAR, permissionsForRole } from "../serializers";
import type { AppContext } from "../context";

export type ShortcodeContext = Record<string, unknown>;

const OMIT = Symbol("orbitid.omit");

/** Splits a `{{a || 'b'}}` expression on `||`, ignoring separators inside quoted literals. */
function splitFallbacks(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" && expr[i + 1] === "|") {
      parts.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** `user.public_metadata.tier` → context.user.public_metadata.tier */
function lookupPath(context: ShortcodeContext, path: string): unknown {
  let current: unknown = context;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A token is a quoted literal, a JSON scalar, or a dot-path into the context. */
function resolveToken(token: string, context: ShortcodeContext): unknown {
  const t = token.trim();
  if (!t) return undefined;
  const quote = t[0];
  if ((quote === "'" || quote === '"') && t.length >= 2 && t[t.length - 1] === quote) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return lookupPath(context, t);
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

/** First non-empty alternative wins; keeps the JSON type of the value it resolved to. */
function resolveExpression(expr: string, context: ShortcodeContext): unknown {
  let last: unknown;
  for (const part of splitFallbacks(expr)) {
    const value = resolveToken(part, context);
    if (!isEmpty(value)) return value;
    last = value;
  }
  return last;
}

export function stringifyShortcodeValue(value: unknown): string {
  if (isEmpty(value)) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/**
 * Renders one template string.
 *  - A string that is exactly one shortcode returns the resolved value unchanged (objects/numbers/arrays keep their type).
 *  - Otherwise each shortcode is interpolated as a string; missing values render as "".
 */
export function renderTemplateValue(template: string, context: ShortcodeContext): unknown {
  const whole = /^\s*\{\{([\s\S]+?)\}\}\s*$/.exec(template);
  if (whole) return resolveExpression(whole[1]!, context);
  if (!template.includes("{{")) return template;
  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_match, expr: string) => stringifyShortcodeValue(resolveExpression(expr, context)));
}

function renderDeep(value: unknown, context: ShortcodeContext): unknown | typeof OMIT {
  if (typeof value === "string") {
    const rendered = renderTemplateValue(value, context);
    return rendered === undefined ? OMIT : rendered;
  }
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, context)).filter((item) => item !== OMIT);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const rendered = renderDeep(item, context);
      if (rendered !== OMIT) out[key] = rendered;
    }
    return out;
  }
  return value;
}

/** Renders every claim value; claims whose shortcode resolved to nothing are dropped. */
export function renderClaimsWithContext(claims: Record<string, unknown>, context: ShortcodeContext): Record<string, unknown> {
  const rendered = renderDeep(claims, context);
  return rendered === OMIT ? {} : (rendered as Record<string, unknown>);
}

export interface TemplateRenderInput { userId: string; sessionId?: string; orgId?: string | null }

export function buildShortcodeContext(ctx: AppContext, input: TemplateRenderInput): ShortcodeContext {
  const user = ctx.db.select().from(s.users).where(eq(s.users.id, input.userId)).get();
  const session = input.sessionId ? ctx.db.select().from(s.sessions).where(eq(s.sessions.id, input.sessionId)).get() : undefined;
  const orgId = input.orgId ?? session?.lastActiveOrganizationId ?? null;
  const org = orgId ? ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orgId)).get() : undefined;
  const membership = org
    ? ctx.db
        .select()
        .from(s.organizationMemberships)
        .where(eq(s.organizationMemberships.organizationId, org.id))
        .all()
        .find((m) => m.userId === input.userId)
    : undefined;
  const email = user?.primaryEmailAddressId ? ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId)).get() : undefined;
  const phone = user?.primaryPhoneNumberId ? ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, user.primaryPhoneNumberId)).get() : undefined;
  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || email?.email || user?.id || "";
  const permissions = membership ? permissionsForRole(ctx, membership.roleKey) : [];

  return {
    user: user
      ? {
          id: user.id,
          external_id: user.externalId,
          username: user.username,
          first_name: user.firstName,
          last_name: user.lastName,
          full_name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "",
          primary_email_address: email?.email ?? null,
          primary_phone_number: phone?.phone ?? null,
          email_verified: !!email?.verified,
          phone_number_verified: !!phone?.verified,
          image_url: user.imageUrl ?? DEFAULT_AVATAR(displayName),
          has_image: user.hasImage,
          public_metadata: user.publicMetadata ?? {},
          unsafe_metadata: user.unsafeMetadata ?? {},
          banned: user.banned,
          locked: user.locked,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
          last_sign_in_at: user.lastSignInAt,
          last_active_at: user.lastActiveAt,
        }
      : undefined,
    session: session ? { id: session.id, status: session.status, actor: session.actor ?? null, created_at: session.createdAt } : undefined,
    org: org
      ? {
          id: org.id,
          slug: org.slug,
          name: org.name,
          role: membership?.roleKey ?? null,
          permissions,
          public_metadata: org.publicMetadata ?? {},
        }
      : undefined,
    org_membership: membership
      ? { id: membership.id, role: membership.roleKey, permissions, public_metadata: membership.publicMetadata ?? {} }
      : undefined,
  };
}

/**
 * Resolve a named JWT template into claims + options. Returns null if the template does not exist.
 * Called by `services/tokens.signSessionToken` for `POST /v1/client/sessions/:id/tokens/:template`.
 */
export async function renderTemplateClaims(
  ctx: AppContext,
  templateName: string,
  input: TemplateRenderInput,
): Promise<null | { claims: Record<string, unknown>; lifetimeSeconds: number; allowedClockSkewSeconds: number; signingKeyEnc?: string | null; algorithm: string }> {
  const template = ctx.db.select().from(s.jwtTemplates).where(eq(s.jwtTemplates.name, templateName)).get();
  if (!template) return null;
  return {
    claims: renderClaimsWithContext(template.claims ?? {}, buildShortcodeContext(ctx, input)),
    lifetimeSeconds: template.lifetime,
    allowedClockSkewSeconds: template.allowedClockSkew,
    signingKeyEnc: template.customSigningKey ? template.signingKeyEnc : null,
    algorithm: template.signingAlgorithm,
  };
}
