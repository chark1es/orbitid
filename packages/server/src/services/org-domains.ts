// OWNER: worker "orgs" (W2). Organization domain helpers: validation, suggestions, enrollment side effects.
import { and, eq, inArray } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";

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

export function userVerifiedEmails(ctx: AppContext, userId: string): string[] {
  return ctx.db
    .select()
    .from(s.emailAddresses)
    .where(and(eq(s.emailAddresses.userId, userId), eq(s.emailAddresses.verified, true)))
    .all()
    .map((e) => e.email.toLowerCase());
}

export function userVerifiedEmailDomains(ctx: AppContext, userId: string): string[] {
  return [...new Set(userVerifiedEmails(ctx, userId).map(emailDomain).filter(Boolean))];
}

export function userMemberOrgIds(ctx: AppContext, userId: string): string[] {
  return ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, userId)).all().map((m) => m.organizationId);
}

/** Organizations the user could join because a verified domain of theirs uses `automatic_suggestion`. */
export function suggestedOrganizations(ctx: AppContext, userId: string): { organization: typeof s.organizations.$inferSelect; domain: DomainRow }[] {
  const domains = userVerifiedEmailDomains(ctx, userId);
  if (!domains.length) return [];
  const memberships = new Set(userMemberOrgIds(ctx, userId));
  const rows = ctx.db
    .select()
    .from(s.organizationDomains)
    .where(and(inArray(s.organizationDomains.name, domains), eq(s.organizationDomains.verified, true), eq(s.organizationDomains.enrollmentMode, "automatic_suggestion")))
    .all();
  const seen = new Set<string>();
  const out: { organization: typeof s.organizations.$inferSelect; domain: DomainRow }[] = [];
  for (const domain of rows) {
    if (memberships.has(domain.organizationId) || seen.has(domain.organizationId)) continue;
    const organization = ctx.db.select().from(s.organizations).where(eq(s.organizations.id, domain.organizationId)).get();
    if (!organization) continue;
    seen.add(domain.organizationId);
    out.push({ organization, domain });
  }
  return out.sort((a, b) => a.organization.name.localeCompare(b.organization.name));
}

/** Whether the user qualifies to request membership of `orgId` through a verified suggestion domain. */
export function hasSuggestionForOrganization(ctx: AppContext, userId: string, orgId: string): boolean {
  return suggestedOrganizations(ctx, userId).some((s2) => s2.organization.id === orgId);
}

export function findDomainByName(ctx: AppContext, orgId: string, name: string): DomainRow | undefined {
  return ctx.db
    .select()
    .from(s.organizationDomains)
    .where(and(eq(s.organizationDomains.organizationId, orgId), eq(s.organizationDomains.name, name.toLowerCase())))
    .get();
}

export function findDomain(ctx: AppContext, orgId: string, id: string): DomainRow | undefined {
  return ctx.db
    .select()
    .from(s.organizationDomains)
    .where(and(eq(s.organizationDomains.organizationId, orgId), eq(s.organizationDomains.id, id)))
    .get();
}

/** Pending invitations addressed to mailboxes on this domain (Clerk's `total_pending_invitations`). */
export function pendingInvitationsForDomain(ctx: AppContext, orgId: string, domainName: string): number {
  const rows = ctx.db
    .select()
    .from(s.organizationInvitations)
    .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.status, "pending")))
    .all();
  const suffix = `@${domainName.toLowerCase()}`;
  return rows.filter((r) => r.email.toLowerCase().endsWith(suffix)).length;
}

/** Users with a verified email on this domain who are not members yet (`total_pending_suggestions`). */
export function pendingSuggestionsForDomain(ctx: AppContext, orgId: string, domainName: string): number {
  const suffix = `@${domainName.toLowerCase()}`;
  const members = new Set(ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, orgId)).all().map((m) => m.userId));
  const userIds = new Set<string>();
  for (const e of ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.verified, true)).all()) {
    if (!e.userId || !e.email.toLowerCase().endsWith(suffix)) continue;
    if (!members.has(e.userId)) userIds.add(e.userId);
  }
  return userIds.size;
}

/** Drops pending invitations addressed to this domain; returns them so callers can emit revoke events. */
export function deletePendingForDomain(ctx: AppContext, orgId: string, domainName: string): typeof s.organizationInvitations.$inferSelect[] {
  const suffix = `@${domainName.toLowerCase()}`;
  const rows = ctx.db
    .select()
    .from(s.organizationInvitations)
    .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.status, "pending")))
    .all()
    .filter((r) => r.email.toLowerCase().endsWith(suffix));
  for (const row of rows) ctx.db.delete(s.organizationInvitations).where(eq(s.organizationInvitations.id, row.id)).run();
  return rows;
}
