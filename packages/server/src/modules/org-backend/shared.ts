/** Shared metadata schema and helpers for the organization Backend API routes. */
import { type Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { type AppContext } from "../../context";
import * as s from "../../db/schema";
import { sendEmail } from "../../services/mail";
import { serializeOrganization } from "../../serializers";
import { findMembership, invitationUrl } from "../orgs/shared";
import { first } from "../../lib/db";

export const metadata = z.record(z.string(), z.unknown());

export function listResponse(c: Context, data: unknown[], total: number) {
  return c.json({ data, total_count: total });
}

export function orgEventPayload(ctx: AppContext, org: typeof s.organizations.$inferSelect) {
  return serializeOrganization(ctx, org, { backend: true });
}

export async function requireMembership(ctx: AppContext, org: typeof s.organizations.$inferSelect, userId: string) {
  const membership = await findMembership(ctx, org.id, userId);
  if (!membership) throw new OrbitError(404, ErrorCodes.not_a_member_in_organization, "User is not a member of this organization");
  return membership;
}

export async function findInvitation(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
  return row;
}

export async function requireRequest(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationMembershipRequests)
      .where(and(eq(s.organizationMembershipRequests.organizationId, orgId), eq(s.organizationMembershipRequests.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Membership request not found");
  return row;
}

export async function resolvePermission(ctx: AppContext, idOrKey: string) {
  return first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.id, idOrKey)))
    ?? first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.key, idOrKey)));
}



export async function notifyInvitation(ctx: AppContext, org: typeof s.organizations.$inferSelect, email: string, ticket: string, roleKey: string) {
  await sendEmail(ctx, {
    to: email,
    template: "organization_invitation",
    vars: {
      organization_name: org.name,
      organization_slug: org.slug ?? "",
      email_address: email,
      role: roleKey,
      invitation_url: invitationUrl(ctx, ticket),
    },
  });
}
