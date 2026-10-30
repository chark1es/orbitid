/** Membership-request and organization-role routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { serializeMembership } from "../../serializers";
import { addMembership, assertOrganizationCapacity, defaultRoleKey } from "../../services/orgs";
import { hasSuggestionForOrganization } from "../../services/org-domains";
import { PERMISSIONS } from "../../services/rbac";
import { resolveCaller } from "../orgs/auth";
import { fapiList, findMembership, orgAccess, requireMembershipRequestsEnabled, requireOrganization, requireOrganizationsEnabled } from "../orgs/shared";
import { serializeMembershipRequest, serializeRole } from "../orgs/serializers";
import { first } from "../../lib/db";
import { findMembershipRequest } from "./shared";

export function registerRequestRoutes(app: Hono, ctx: AppContext) {
  // ─────────── membership requests ───────────
  app.post("/organizations/:id/membership_requests", async (c) => {
    requireOrganizationsEnabled(ctx);
    requireMembershipRequestsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const org = await requireOrganization(ctx, c.req.param("id"));
    if (await findMembership(ctx, org.id, caller.userId)) throw new OrbitError(409, ErrorCodes.duplicate_record, "You are already a member of this organization");
    const existing = first(await ctx.db
          .select()
          .from(s.organizationMembershipRequests)
          .where(and(eq(s.organizationMembershipRequests.organizationId, org.id), eq(s.organizationMembershipRequests.userId, caller.userId), eq(s.organizationMembershipRequests.status, "pending"))));
    if (existing) return c.json({ response: await serializeMembershipRequest(ctx, existing) });
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Your verified email domain does not allow joining this organization");
    }
    const now = Date.now();
    const id = newId(ID_PREFIX.request);
    await ctx.db.insert(s.organizationMembershipRequests).values({ id, organizationId: org.id, userId: caller.userId, status: "pending", createdAt: now, updatedAt: now });
    const row = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, id)))!;
    return c.json({ response: await serializeMembershipRequest(ctx, row) });
  });

  app.get("/organizations/:id/membership_requests", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const status = c.req.query("status");
    const rows = (await Promise.all((await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.organizationId, org.id)))
          .filter((r) => !status || r.status === status)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((row) => serializeMembershipRequest(ctx, row))));
    return fapiList(c, rows);
  });

  app.post("/organizations/:id/membership_requests/:rid/accept", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const request = await findMembershipRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await assertOrganizationCapacity(ctx, org);
    const membership = await addMembership(ctx, { organizationId: org.id, userId: request.userId, roleKey: await defaultRoleKey(ctx) });
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "accepted", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.post("/organizations/:id/membership_requests/:rid/reject", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const request = await findMembershipRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "rejected", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    const updated = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, request.id)))!;
    return c.json({ response: await serializeMembershipRequest(ctx, updated) });
  });

  // ─────────── roles (role dropdown of the OrganizationProfile) ───────────
  app.get("/organizations/:id/roles", async (c) => {
    await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const rows = (await Promise.all((await ctx.db.select().from(s.roles))
          .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.key.localeCompare(b.key))
          .map((row) => serializeRole(ctx, row))));
    return c.json({ response: rows });
  });
}
