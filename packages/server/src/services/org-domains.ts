// Organization domain helpers: validation, suggestions, enrollment side effects.
import { and, eq, inArray } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { first } from "../lib/db";

export type DomainRow = typeof s.organizationDomains.$inferSelect;

export const ENROLLMENT_MODES = ["manual_invitation", "automatic_invitation", "automatic_suggestion"] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PUBLIC_SUFFIXES: Record<string, true> = {
  com: true, net: true, org: true, io: true, co: true, dev: true, app: true, ai: true, edu: true,
  gov: true, mil: true, info: true, biz: true, me: true, sh: true, xyz: true,
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lowercases + strips a leading `@` / `*@`; throws when the result is not a registrable domain. */
export function normalizeDomain(raw: string): string {
  const name = String(raw ?? "").trim().toLowerCase().replace(/^\*?@/, "").replace(/\.$/, "");
  if (!name || !DOMAIN_RE.test(name) || PUBLIC_SUFFIXES[name]) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `"${raw}" is not a valid domain`, { param_name: "name" });
  }
  return name;
}

export function normalizeEmail(raw: string): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `"${raw}" is not a valid email address`, { param_name: "email_address" });
  }
  return email;
}

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export async function userVerifiedEmails(ctx: AppContext, userId: string): Promise<string[]> {
  return (await ctx.db
      .select()
      .from(s.emailAddresses)
      .where(and(eq(s.emailAddresses.userId, userId), eq(s.emailAddresses.verified, true))))
    .map((e) => e.email.toLowerCase());
}

export async function userVerifiedEmailDomains(ctx: AppContext, userId: string): Promise<string[]> {
  return [...new Set((await userVerifiedEmails(ctx, userId)).map(emailDomain).filter(Boolean))];
}

export async function userMemberOrgIds(ctx: AppContext, userId: string): Promise<string[]> {
  return (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, userId))).map((m) => m.organizationId);
}

/** Organizations the user could join because a verified domain of theirs uses `automatic_suggestion`. */
export async function suggestedOrganizations(ctx: AppContext, userId: string): Promise<{ organization: typeof s.organizations.$inferSelect; domain: DomainRow }[]> {
  const domains = await userVerifiedEmailDomains(ctx, userId);
  if (!domains.length) return [];
  const memberships = new Set(await userMemberOrgIds(ctx, userId));
  const rows = (await ctx.db
      .select()
      .from(s.organizationDomains)
      .where(and(inArray(s.organizationDomains.name, domains), eq(s.organizationDomains.verified, true), eq(s.organizationDomains.enrollmentMode, "automatic_suggestion"))));
  const seen = new Set<string>();
  const out: { organization: typeof s.organizations.$inferSelect; domain: DomainRow }[] = [];
  for (const domain of rows) {
    if (memberships.has(domain.organizationId) || seen.has(domain.organizationId)) continue;
    const organization = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, domain.organizationId)));
    if (!organization) continue;
    seen.add(domain.organizationId);
    out.push({ organization, domain });
  }
  return out.sort((a, b) => a.organization.name.localeCompare(b.organization.name));
}

/** Whether the user qualifies to request membership of `orgId` through a verified suggestion domain. */
export async function hasSuggestionForOrganization(ctx: AppContext, userId: string, orgId: string): Promise<boolean> {
  return (await suggestedOrganizations(ctx, userId)).some((s2) => s2.organization.id === orgId);
}

export async function findDomainByName(ctx: AppContext, orgId: string, name: string): Promise<DomainRow | undefined> {
  return first(await ctx.db
      .select()
      .from(s.organizationDomains)
      .where(and(eq(s.organizationDomains.organizationId, orgId), eq(s.organizationDomains.name, name.toLowerCase()))));
}

export async function findDomain(ctx: AppContext, orgId: string, id: string): Promise<DomainRow | undefined> {
  return first(await ctx.db
      .select()
      .from(s.organizationDomains)
      .where(and(eq(s.organizationDomains.organizationId, orgId), eq(s.organizationDomains.id, id))));
}

/** Pending invitations addressed to mailboxes on this domain (`total_pending_invitations`). */
export async function pendingInvitationsForDomain(ctx: AppContext, orgId: string, domainName: string): Promise<number> {
  const rows = (await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.status, "pending"))));
  const suffix = `@${domainName.toLowerCase()}`;
  return rows.filter((r) => r.email.toLowerCase().endsWith(suffix)).length;
}

/** Users with a verified email on this domain who are not members yet (`total_pending_suggestions`). */
export async function pendingSuggestionsForDomain(ctx: AppContext, orgId: string, domainName: string): Promise<number> {
  const suffix = `@${domainName.toLowerCase()}`;
  const members = new Set((await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, orgId))).map((m) => m.userId));
  const userIds = new Set<string>();
  for (const e of (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.verified, true)))) {
    if (!e.userId || !e.email.toLowerCase().endsWith(suffix)) continue;
    if (!members.has(e.userId)) userIds.add(e.userId);
  }
  return userIds.size;
}

/** Drops pending invitations addressed to this domain; returns them so callers can emit revoke events. */
export async function deletePendingForDomain(ctx: AppContext, orgId: string, domainName: string): Promise<typeof s.organizationInvitations.$inferSelect[]> {
  const suffix = `@${domainName.toLowerCase()}`;
  const rows = (await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.status, "pending"))))
    .filter((r) => r.email.toLowerCase().endsWith(suffix));
  for (const row of rows) await ctx.db.delete(s.organizationInvitations).where(eq(s.organizationInvitations.id, row.id));
  return rows;
}
