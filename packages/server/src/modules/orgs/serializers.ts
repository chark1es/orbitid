// Wire serializers for organization resources not covered by src/serializers.ts.
import { and, desc, eq } from "drizzle-orm";
import type {
  OrganizationDomainJSON, OrganizationInvitationJSON, OrganizationMembershipRequestJSON, OrganizationSuggestionJSON, VerificationJSON,
} from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { publicUserData, serializeOrganization, verifiedVerification } from "../../serializers";
import { pendingInvitationsForDomain, pendingSuggestionsForDomain } from "../../services/org-domains";
import { serializePermission, serializeRole } from "../../services/rbac";
import { first } from "../../lib/db";

export { serializeRole, serializePermission };

export type InvitationRow = typeof s.organizationInvitations.$inferSelect;
export type DomainRow = typeof s.organizationDomains.$inferSelect;
export type RequestRow = typeof s.organizationMembershipRequests.$inferSelect;
export type OrganizationRow = typeof s.organizations.$inferSelect;


export function effectiveInvitationStatus(row: InvitationRow): OrganizationInvitationJSON["status"] {
  if (row.status === "pending" && row.expiresAt && row.expiresAt <= Date.now()) return "expired";
  return row.status as OrganizationInvitationJSON["status"];
}

export async function serializeOrganizationInvitation(ctx: AppContext, row: InvitationRow, opts: { backend?: boolean; url?: string | null } = {}): Promise<OrganizationInvitationJSON> {
  const role = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, row.roleKey)));
  const org = first(await ctx.db.select({ name: s.organizations.name, imageUrl: s.organizations.imageUrl }).from(s.organizations).where(eq(s.organizations.id, row.organizationId)));
  const json: OrganizationInvitationJSON = {
    object: "organization_invitation",
    id: row.id,
    email_address: row.email,
    organization_id: row.organizationId,
    organization_name: org?.name,
    organization_image_url: org?.imageUrl ?? undefined,
    role: row.roleKey,
    role_name: role?.name ?? row.roleKey,
    status: effectiveInvitationStatus(row),
    public_metadata: row.publicMetadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (opts.url) json.url = opts.url;
  if (opts.backend) json.private_metadata = row.privateMetadata;
  return json;
}

async function domainVerification(ctx: AppContext, domain: DomainRow): Promise<VerificationJSON> {
  if (domain.verified) return verifiedVerification("email_code", domain.updatedAt);
  const v = first(await ctx.db
      .select()
      .from(s.verifications)
      .where(and(eq(s.verifications.ownerId, domain.id), eq(s.verifications.purpose, "org_domain")))
      .orderBy(desc(s.verifications.createdAt)));
  if (!v || (v.consumedAt && !v.verifiedAt)) return { status: "unverified", strategy: "email_code", attempts: 0, expire_at: null };
  return { status: "unverified", strategy: "email_code", attempts: v.attempts, expire_at: v.expiresAt };
}

export async function serializeOrganizationDomain(ctx: AppContext, row: DomainRow): Promise<OrganizationDomainJSON> {
  return {
    object: "organization_domain",
    id: row.id,
    organization_id: row.organizationId,
    name: row.name,
    enrollment_mode: row.enrollmentMode as OrganizationDomainJSON["enrollment_mode"],
    verification: await domainVerification(ctx, row),
    affiliation_email_address: row.affiliationEmailAddress,
    total_pending_invitations: await pendingInvitationsForDomain(ctx, row.organizationId, row.name),
    total_pending_suggestions: await pendingSuggestionsForDomain(ctx, row.organizationId, row.name),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function serializeMembershipRequest(ctx: AppContext, row: RequestRow): Promise<OrganizationMembershipRequestJSON> {
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  return {
    object: "organization_membership_request",
    id: row.id,
    organization_id: row.organizationId,
    status: row.status as OrganizationMembershipRequestJSON["status"],
    public_user_data: user ? await publicUserData(ctx, user) : { user_id: row.userId, first_name: null, last_name: null, image_url: "", has_image: false, identifier: "" },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

const SUGGESTION_PREFIX = "orgsug_";

/** Suggestions are derived from verified `automatic_suggestion` domains, so the id is deterministic. */
export const suggestionId = (orgId: string): string => `${SUGGESTION_PREFIX}${orgId}`;
export const orgIdFromSuggestionId = (id: string): string | null => (id.startsWith(SUGGESTION_PREFIX) ? id.slice(SUGGESTION_PREFIX.length) : null);

export async function serializeSuggestion(
  ctx: AppContext,
  organization: OrganizationRow,
  domain: DomainRow,
  status: OrganizationSuggestionJSON["status"] = "pending",
): Promise<OrganizationSuggestionJSON> {
  const org = await serializeOrganization(ctx, organization, { counts: false });
  return {
    object: "organization_suggestion",
    id: suggestionId(organization.id),
    public_organization_data: { id: org.id, name: org.name, slug: org.slug, image_url: org.image_url, has_image: org.has_image },
    status,
    created_at: domain.createdAt,
    updated_at: domain.updatedAt,
  };
}
