/** The signed-in user's memberships, invitations, and suggestions. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { serializeMembership } from "../../serializers";
import { acceptInvitation, addMembership, defaultRoleKey } from "../../services/orgs";
import { hasSuggestionForOrganization, suggestedOrganizations, userVerifiedEmails } from "../../services/org-domains";
import { assertNotLastAdmin } from "../../services/rbac";
import { resolveCaller } from "../orgs/auth";
import { deletedObject, listParams, page, requireMembership, requireOrganization, requireOrganizationsEnabled } from "../orgs/shared";
import { orgIdFromSuggestionId, serializeOrganizationInvitation, serializeSuggestion } from "../orgs/serializers";
import { first } from "../../lib/db";

export function registerCurrentUserRoutes(app: Hono, ctx: AppContext) {
  // ─────────── current user ───────────
  app.get("/me/organization_memberships", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, caller.sessionId)));
    const activeOrgId = session?.lastActiveOrganizationId ?? null;
    const membershipRows = await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, caller.userId));
    const rows = (await Promise.all(membershipRows.map((row) => serializeMembership(ctx, row))))
      .sort((a, b) => {
        if (a.organization.id === activeOrgId) return -1;
        if (b.organization.id === activeOrgId) return 1;
        return b.created_at - a.created_at;
      });
    const params = listParams(c);
    if (params.paginated) {
      const { items, total } = page(rows, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: rows });
  });

  app.post("/me/organization_memberships", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const body = await parseBody(c, z.object({ organization_id: z.string().min(1) }));
    const org = await requireOrganization(ctx, body.organization_id);
    if (first(await ctx.db.select().from(s.organizationMemberships).where(and(eq(s.organizationMemberships.organizationId, org.id), eq(s.organizationMemberships.userId, caller.userId))))) {
      throw new OrbitError(409, ErrorCodes.duplicate_record, "You are already a member of this organization");
    }
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "This organization cannot be joined directly");
    }
    const membership = await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await defaultRoleKey(ctx) });
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.delete("/me/organization_memberships/:orgId", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const org = await requireOrganization(ctx, c.req.param("orgId"));
    const membership = await requireMembership(ctx, org, caller.userId);
    await assertNotLastAdmin(ctx, membership, "You are the last admin of this organization and cannot leave it");
    const payload = await serializeMembership(ctx, membership, { backend: true });
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json({ response: deletedObject("organization_membership", membership.id) });
  });

  app.get("/me/organization_invitations", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const emails = await userVerifiedEmails(ctx, caller.userId);
    if (!emails.length) return c.json({ response: [] });
    const now = Date.now();
    const rows = (await Promise.all((await ctx.db
              .select()
              .from(s.organizationInvitations))
          .filter((r) => r.status === "pending" && emails.includes(r.email.toLowerCase()) && (!r.expiresAt || r.expiresAt > now))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((row) => serializeOrganizationInvitation(ctx, row))));
    return c.json({ response: rows });
  });

  app.post("/me/organization_invitations/:id/accept", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const invitation = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.id, c.req.param("id"))));
    if (!invitation) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
    if (!(await userVerifiedEmails(ctx, caller.userId)).includes(invitation.email.toLowerCase())) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "This invitation is addressed to a different email address");
    }
    if (invitation.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${invitation.status}`);
    if (invitation.expiresAt && invitation.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.ticket_expired, "Organization invitation has expired");
    const membership = await acceptInvitation(ctx, invitation, caller.userId);
    if (!membership) throw new OrbitError(409, ErrorCodes.duplicate_record, "Invitation is no longer pending");
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.get("/me/organization_suggestions", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const rows = (await Promise.all((await suggestedOrganizations(ctx, caller.userId)).map(({ organization, domain }) => serializeSuggestion(ctx, organization, domain))));
    return c.json({ response: rows });
  });

  app.post("/me/organization_suggestions/:id/accept", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const orgId = orgIdFromSuggestionId(c.req.param("id"));
    if (!orgId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization suggestion not found");
    const org = await requireOrganization(ctx, orgId);
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization suggestion not found");
    }
    const membership = await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await defaultRoleKey(ctx) });
    return c.json({ response: await serializeMembership(ctx, membership) });
  });
}
