// Shared request helpers for the organization Frontend/Backend APIs.
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { permissionsForRole } from "../../services/rbac";
import type { Caller } from "./auth";
import { resolveCaller } from "./auth";
import { first } from "../../lib/db";

export type OrganizationRow = typeof s.organizations.$inferSelect;
export type MembershipRow = typeof s.organizationMemberships.$inferSelect;

const RESERVED_SLUGS: Record<string, true> = {
  api: true, app: true, admin: true, dashboard: true, www: true, sign_in: true, sign_up: true, oauth: true,
  organizations: true, users: true, sessions: true, environment: true, oidc: true, jwks: true, health: true,
};

export function requireOrganizationsEnabled(ctx: AppContext): void {
  if (!ctx.settings.get().organizations.enabled) {
    throw new OrbitError(403, ErrorCodes.organizations_disabled, "Organizations are not enabled for this instance");
  }
}

export function requireDomainsEnabled(ctx: AppContext): void {
  if (!ctx.settings.get().organizations.domainsEnabled) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, "Organization domains are not enabled for this instance");
  }
}

export function requireMembershipRequestsEnabled(ctx: AppContext): void {
  if (!ctx.settings.get().organizations.membershipRequestsEnabled) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, "Organization membership requests are not enabled for this instance");
  }
}

export async function findOrganization(ctx: AppContext, idOrSlug: string): Promise<OrganizationRow | undefined> {
  if (!idOrSlug) return undefined;
  return first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, idOrSlug)))
    ?? first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.slug, idOrSlug.toLowerCase())));
}

export async function requireOrganization(ctx: AppContext, idOrSlug: string): Promise<OrganizationRow> {
  const org = await findOrganization(ctx, idOrSlug);
  if (!org) throw new OrbitError(404, ErrorCodes.organization_not_found, "Organization not found");
  return org;
}

export async function findMembership(ctx: AppContext, orgId: string, userId: string): Promise<MembershipRow | undefined> {
  return first(await ctx.db
      .select()
      .from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, orgId), eq(s.organizationMemberships.userId, userId))));
}

export async function requireMembership(ctx: AppContext, org: OrganizationRow, userId: string, extra = ""): Promise<MembershipRow> {
  const membership = await findMembership(ctx, org.id, userId);
  if (!membership) throw new OrbitError(404, ErrorCodes.not_a_member_in_organization, `You are not a member of this organization${extra}`);
  return membership;
}

export interface OrgAccess {
  caller: Caller;
  org: OrganizationRow;
  membership: MembershipRow;
  permissions: string[];
}

/** Frontend API guard: organizations enabled, signed in, member of `:id`, and (optionally) holding `permission`. */
export async function orgAccess(ctx: AppContext, c: Context, permission?: string): Promise<OrgAccess> {
  requireOrganizationsEnabled(ctx);
  const caller = await resolveCaller(ctx, c);
  const org = await requireOrganization(ctx, c.req.param("id") ?? "");
  const membership = await requireMembership(ctx, org, caller.userId);
  const permissions = await permissionsForRole(ctx, membership.roleKey);
  if (permission && !permissions.includes(permission)) {
    throw new OrbitError(403, ErrorCodes.org_permission_required, `You do not have permission to perform this action. Missing permission: ${permission}`, {
      permission, role: membership.roleKey,
    });
  }
  return { caller, org, membership, permissions };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function slugify(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return slug || "organization";
}

export function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "Slug must be 1-50 characters of lowercase letters, numbers and single dashes", { param_name: "slug" });
  }
  if (RESERVED_SLUGS[slug]) {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `Slug "${slug}" is reserved`, { param_name: "slug" });
  }
  return slug;
}

/** Validates a requested slug (or derives one from the name) and makes it unique by suffixing `-2`, `-3`, … */
export async function resolveSlug(ctx: AppContext, requested: string | undefined, name: string, excludeOrgId?: string): Promise<string> {
  const base = requested ? normalizeSlug(requested) : slugify(name);
  const taken = async (slug: string) => {
    const row = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.slug, slug)));
    return !!row && row.id !== excludeOrgId;
  };
  if (requested) {
    if (await taken(base)) throw new OrbitError(409, ErrorCodes.organization_slug_taken, `Slug "${base}" is already taken`, { param_name: "slug" });
    return base;
  }
  let slug = base;
  for (let i = 2; await taken(slug) && i < 1000; i++) slug = `${base.slice(0, 46)}-${i}`;
  return slug;
}

/** Frontend API list responses: `{ response: rows }`, or `{ data, total_count }` when `?paginated=true`. */
export function fapiList(c: Context, rows: unknown[], total = rows.length) {
  return c.json(c.req.query("paginated") === "true" ? { data: rows, total_count: total } : { response: rows });
}

export function deletedObject(object: string, id: string) {
  return { object, id, deleted: true as const };
}

export function invitationUrl(ctx: AppContext, ticket: string): string {
  return `${ctx.env.baseUrl}/v1/client/organization_invitations/accept?ticket=${encodeURIComponent(ticket)}`;
}

export interface ListParams {
  limit: number;
  offset: number;
  orderBy: string | undefined;
  query: string | undefined;
  paginated: boolean;
}

export function listParams(c: Context): ListParams {
  const q = c.req.query();
  const rawLimit = Number(q.limit ?? 10);
  const rawOffset = Number(q.offset ?? 0);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 10,
    offset: Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0,
    orderBy: q.order_by,
    query: q.query?.trim().toLowerCase() || undefined,
    paginated: q.paginated === "true",
  };
}

/** Sorts rows by `?order_by=field|-field|+field`. Unknown fields keep the existing order. */
export function sortRows<T>(rows: T[], orderBy: string | undefined, columns: Record<string, (row: T) => string | number>): T[] {
  if (!orderBy) return rows;
  const desc = orderBy.startsWith("-");
  const field = orderBy.replace(/^[+-]/, "");
  const pick = columns[field];
  if (!pick) return rows;
  return [...rows].sort((a, b) => {
    const av = pick(a);
    const bv = pick(b);
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
}

export function page<T>(rows: T[], params: ListParams): { items: T[]; total: number } {
  return { items: rows.slice(params.offset, params.offset + params.limit), total: rows.length };
}

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep-merges metadata objects (arrays/scalars replaced, `null` removes the key). Prototype keys are ignored. */
export function mergeMetadata(base: Record<string, unknown> | null | undefined, patch: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (PROTOTYPE_KEYS.has(k)) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    const prev = out[k];
    const bothObjects = !!prev && !!v && typeof prev === "object" && typeof v === "object" && !Array.isArray(prev) && !Array.isArray(v);
    Object.defineProperty(out, k, {
      value: bothObjects ? mergeMetadata(prev as Record<string, unknown>, v as Record<string, unknown>) : v,
      enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}
