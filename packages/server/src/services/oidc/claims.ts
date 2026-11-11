// Claims shared by the ID token and the userinfo endpoint: profile, email, phone, groups and organization data.
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { first } from "../../lib/db";
import { getMembershipContext } from "../orgs";
import { roleClaimsForUser } from "../user-roles";
import type { GroupsClaimMode } from "./shared";

export type UserRow = typeof s.users.$inferSelect;
export type ApplicationClaimsRow = typeof s.oauthApplications.$inferSelect;

export async function primaryEmail(ctx: AppContext, user: UserRow) {
  if (!user.primaryEmailAddressId) return null;
  return first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId))) ?? null;
}

export async function primaryPhone(ctx: AppContext, user: UserRow) {
  if (!user.primaryPhoneNumberId) return null;
  return first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, user.primaryPhoneNumberId))) ?? null;
}

/** Unix seconds of the authorizing session's first factor, for `auth_time` / `max_age`. */
export async function sessionAuthTime(ctx: AppContext, sessionId: string | null): Promise<number | null> {
  if (!sessionId) return null;
  const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
  return session ? Math.floor((session.firstFactorVerifiedAt ?? session.createdAt) / 1000) : null;
}

export interface OrganizationClaims {
  active: { id: string; slug: string | null; role: string; permissions: string[] } | null;
  memberships: { id: string; slug: string | null; name: string; role: string }[];
}

/** Active organization (from the authorizing session) + every membership, for the `organizations` scope. */
export async function organizationClaims(ctx: AppContext, userId: string, sessionId: string | null): Promise<OrganizationClaims> {
  if (!ctx.settings.get().organizations.enabled) return { active: null, memberships: [] };
  let activeOrgId: string | null = null;
  if (sessionId) {
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
    if (session && session.userId === userId) activeOrgId = session.lastActiveOrganizationId;
  }
  let active: OrganizationClaims["active"] = null;
  if (activeOrgId) {
    const membership = await getMembershipContext(ctx, userId, activeOrgId);
    if (membership) active = { id: membership.orgId, slug: membership.slug, role: membership.role, permissions: membership.permissions };
  }
  const rows = await ctx.db
    .select({ id: s.organizations.id, slug: s.organizations.slug, name: s.organizations.name, role: s.organizationMemberships.roleKey })
    .from(s.organizationMemberships)
    .innerJoin(s.organizations, eq(s.organizations.id, s.organizationMemberships.organizationId))
    .where(eq(s.organizationMemberships.userId, userId))
    .orderBy(asc(s.organizations.name), asc(s.organizations.id));
  return { active, memberships: rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role })) };
}

/** Adds `org_*` and `organizations` claims when the `organizations` scope was granted. */
export async function appendOrgClaims(claims: Record<string, unknown>, ctx: AppContext, userId: string, sessionId: string | null): Promise<void> {
  const orgs = await organizationClaims(ctx, userId, sessionId);
  if (orgs.active) {
    claims.org_id = orgs.active.id;
    claims.org_slug = orgs.active.slug;
    claims.org_role = orgs.active.role;
    claims.org_permissions = orgs.active.permissions;
  }
  claims.organizations = orgs.memberships;
}

/**
 * The `groups` claim for this application. Values are stable identifiers rather than display names:
 * organization slugs (`acme`), organization role keys (`org:admin`) and instance role keys (`admin`).
 * The application chooses which of those it receives; `none` omits the claim entirely.
 */
export async function groupsForUser(ctx: AppContext, application: ApplicationClaimsRow, userId: string): Promise<string[] | null> {
  const mode = (application.groupsClaim ?? "all") as GroupsClaimMode;
  if (mode === "none") return null;
  const values = new Set<string>();
  if (mode === "organizations" || mode === "all" || mode === "roles") {
    const orgs = await organizationClaims(ctx, userId, null);
    if (mode === "organizations" || mode === "all") for (const membership of orgs.memberships) if (membership.slug) values.add(membership.slug);
    if (mode === "roles" || mode === "all") for (const membership of orgs.memberships) values.add(membership.role);
  }
  if (mode === "roles" || mode === "all") {
    for (const role of (await roleClaimsForUser(ctx, userId)).roles) values.add(role);
  }
  return [...values].sort();
}

/** OIDC `at_hash`: base64url of the left half of SHA-256 over the ASCII access token (RS256). */
export function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken, "ascii").digest().subarray(0, 16).toString("base64url");
}

export interface IdTokenInput {
  user: UserRow;
  application: ApplicationClaimsRow;
  scopes: string[];
  nonce: string | null;
  sessionId?: string | null;
  accessToken: string;
}

export async function buildIdTokenClaims(ctx: AppContext, input: IdTokenInput): Promise<Record<string, unknown>> {
  const { user, application, scopes } = input;
  const sessionId = input.sessionId ?? null;
  const claims: Record<string, unknown> = {
    sub: user.id,
    azp: application.clientId,
    at_hash: accessTokenHash(input.accessToken),
  };
  if (sessionId) {
    claims.sid = sessionId;
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
    if (session) claims.auth_time = Math.floor((session.firstFactorVerifiedAt ?? session.createdAt) / 1000);
  }
  if (input.nonce) claims.nonce = input.nonce;
  Object.assign(claims, await profileClaims(ctx, user, scopes));
  if (scopes.includes("groups")) {
    const groups = await groupsForUser(ctx, application, user.id);
    if (groups) claims.groups = groups;
  }
  if (scopes.includes("organizations")) await appendOrgClaims(claims, ctx, user.id, sessionId);
  return claims;
}

/** Profile/email/phone claims shared by the ID token and userinfo. */
export async function profileClaims(ctx: AppContext, user: UserRow, scopes: string[]): Promise<Record<string, unknown>> {
  const claims: Record<string, unknown> = {};
  // `profile` and `email` both describe the same address: load it once instead of querying it twice.
  const email = scopes.includes("profile") || scopes.includes("email") ? await primaryEmail(ctx, user) : null;
  if (scopes.includes("profile")) {
    claims.name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email?.email || user.id;
    if (user.firstName) claims.given_name = user.firstName;
    if (user.lastName) claims.family_name = user.lastName;
    if (user.imageUrl) claims.picture = user.imageUrl;
    claims.preferred_username = user.username ?? email?.email?.split("@")[0] ?? user.id;
    claims.updated_at = Math.floor(user.updatedAt / 1000);
    const locale = (user.publicMetadata as Record<string, unknown>)?.locale;
    if (typeof locale === "string" && locale) claims.locale = locale;
  }
  if (scopes.includes("email")) {
    if (email) {
      claims.email = email.email;
      claims.email_verified = !!email.verified;
    }
  }
  if (scopes.includes("phone")) {
    const phone = await primaryPhone(ctx, user);
    if (phone) {
      claims.phone_number = phone.phone;
      claims.phone_number_verified = !!phone.verified;
    }
  }
  return claims;
}

/** OIDC userinfo payload, filtered by the granted scopes. */
export async function userInfoClaims(ctx: AppContext, row: typeof s.oauthGrants.$inferSelect, user: UserRow): Promise<Record<string, unknown>> {
  const scopes = row.scopes.split(/[\s,]+/).filter(Boolean);
  const application = first(await ctx.db.select().from(s.oauthApplications).where(eq(s.oauthApplications.id, row.applicationId)));
  const claims: Record<string, unknown> = { sub: user.id, ...(await profileClaims(ctx, user, scopes)) };
  if (scopes.includes("groups") && application) {
    const groups = await groupsForUser(ctx, application, user.id);
    if (groups) claims.groups = groups;
  }
  if (scopes.includes("organizations")) await appendOrgClaims(claims, ctx, user.id, row.sessionId);
  return claims;
}
