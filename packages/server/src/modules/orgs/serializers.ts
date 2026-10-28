// OWNER: worker "orgs" (W2). Wire serializers for organization resources not covered by src/serializers.ts.
import { and, desc, eq } from "drizzle-orm";
import type {
  OrganizationDomainJSON, OrganizationInvitationJSON, OrganizationMembershipRequestJSON, OrganizationSuggestionJSON, VerificationJSON,
} from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { publicUserData, serializeOrganization, verifiedVerification } from "../../serializers";
import { pendingInvitationsForDomain, pendingSuggestionsForDomain } from "../../services/org-domains";
import { serializePermission, serializeRole } from "../../services/rbac";

export { serializeRole, serializePermission };

export type InvitationRow = typeof s.organizationInvitations.$inferSelect;
export type DomainRow = typeof s.organizationDomains.$inferSelect;
export type RequestRow = typeof s.organizationMembershipRequests.$inferSelect;
export type OrganizationRow = typeof s.organizations.$inferSelect;


export function effectiveInvitationStatus(row: InvitationRow): OrganizationInvitationJSON["status"] {
  if (row.status === "pending" && row.expiresAt && row.expiresAt <= Date.now()) return "expired";
  return row.status as OrganizationInvitationJSON["status"];
}

export function serializeOrganizationInvitation(ctx: AppContext, row: InvitationRow, opts: { backend?: boolean; url?: string | null } = {}): OrganizationInvitationJSON {
  const role = ctx.db.select().from(s.roles).where(eq(s.roles.key, row.roleKey)).get();
  const json: OrganizationInvitationJSON = {
    object: "organization_invitation",
    id: row.id,
    email_address: row.email,
    organization_id: row.organizationId,
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

function domainVerification(ctx: AppContext, domain: DomainRow): VerificationJSON {
  if (domain.verified) return verifiedVerification("email_code", domain.updatedAt);
  const v = ctx.db
    .select()
    .from(s.verifications)
    .where(and(eq(s.verifications.ownerId, domain.id), eq(s.verifications.purpose, "org_domain")))
    .orderBy(desc(s.verifications.createdAt))
    .get();
  if (!v || (v.consumedAt && !v.verifiedAt)) return { status: "unverified", strategy: "email_code", attempts: 0, expire_at: null };
  return { status: "unverified", strategy: "email_code", attempts: v.attempts, expire_at: v.expiresAt };
}

export function serializeOrganizationDomain(ctx: AppContext, row: DomainRow): OrganizationDomainJSON {
  return {
    object: "organization_domain",
    id: row.id,
    organization_id: row.organizationId,
    name: row.name,
    enrollment_mode: row.enrollmentMode as OrganizationDomainJSON["enrollment_mode"],
    verification: domainVerification(ctx, row),
    affiliation_email_address: row.affiliationEmailAddress,
    total_pending_invitations: pendingInvitationsForDomain(ctx, row.organizationId, row.name),
    total_pending_suggestions: pendingSuggestionsForDomain(ctx, row.organizationId, row.name),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeMembershipRequest(ctx: AppContext, row: RequestRow): OrganizationMembershipRequestJSON {
  const user = ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)).get();
  return {
    object: "organization_membership_request",
    id: row.id,
    organization_id: row.organizationId,
    status: row.status as OrganizationMembershipRequestJSON["status"],
    public_user_data: user ? publicUserData(ctx, user) : { user_id: row.userId, first_name: null, last_name: null, image_url: "", has_image: false, identifier: "" },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

const SUGGESTION_PREFIX = "orgsug_";

/** Suggestions are derived from verified `automatic_suggestion` domains, so the id is deterministic. */
export const suggestionId = (orgId: string): string => `${SUGGESTION_PREFIX}${orgId}`;
export const orgIdFromSuggestionId = (id: string): string | null => (id.startsWith(SUGGESTION_PREFIX) ? id.slice(SUGGESTION_PREFIX.length) : null);

export function serializeSuggestion(
  ctx: AppContext,
  organization: OrganizationRow,
  domain: DomainRow,
  status: OrganizationSuggestionJSON["status"] = "pending",
): OrganizationSuggestionJSON {
  const org = serializeOrganization(ctx, organization, { counts: false });
  return {
    object: "organization_suggestion",
    id: suggestionId(organization.id),
    public_organization_data: { id: org.id, name: org.name, slug: org.slug, image_url: org.image_url, has_image: org.has_image },
    status,
    created_at: domain.createdAt,
    updated_at: domain.updatedAt,
  };
}
