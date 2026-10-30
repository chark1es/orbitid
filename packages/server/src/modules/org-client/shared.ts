/** Shared schema and lookups for the organization Frontend API routes. */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { type AppContext } from "../../context";
import * as s from "../../db/schema";
import { type OrganizationRow } from "../orgs/shared";
import { first } from "../../lib/db";

export const emailList = z.array(z.string().min(3));

/** Rejects addresses already members or already invited, so bulk sends stay idempotent. */
export async function dedupeRecipients(ctx: AppContext, org: OrganizationRow, emails: string[]): Promise<string[]> {
  const members = new Set<string>();
  for (const row of (await ctx.db
      .select({ email: s.emailAddresses.email })
      .from(s.organizationMemberships)
      .innerJoin(s.users, eq(s.users.id, s.organizationMemberships.userId))
      .innerJoin(s.emailAddresses, eq(s.emailAddresses.userId, s.users.id))
      .where(eq(s.organizationMemberships.organizationId, org.id)))) members.add(row.email.toLowerCase());
  const pending = new Set(
    (await ctx.db
            .select()
            .from(s.organizationInvitations)
            .where(and(eq(s.organizationInvitations.organizationId, org.id), eq(s.organizationInvitations.status, "pending"))))
      .map((r) => r.email.toLowerCase()),
  );
  return [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => !members.has(e) && !pending.has(e));
}

export async function findMembershipRequest(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationMembershipRequests)
      .where(and(eq(s.organizationMembershipRequests.organizationId, orgId), eq(s.organizationMembershipRequests.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Membership request not found");
  return row;
}
