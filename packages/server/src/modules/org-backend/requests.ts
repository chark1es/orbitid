/** Membership request and organization-scoped role routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { serializeMembership } from "../../serializers";
import { addMembership, assertOrganizationCapacity, defaultRoleKey } from "../../services/orgs";
import { serializeRole } from "../../services/rbac";
import { findMembership, listParams, page, requireOrganization, sortRows } from "../orgs/shared";
import { serializeMembershipRequest } from "../orgs/serializers";
import { first } from "../../lib/db";
import { listResponse, requireRequest } from "./shared";

export function registerRequestRoutes(app: Hono, ctx: AppContext) {
  // ─────────── membership requests ───────────
  app.get("/organizations/:id/membership_requests", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const params = listParams(c);
    const status = c.req.query("status");
    const serialized = (await Promise.all((await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.organizationId, org.id)))
          .filter((r) => !status || r.status === status)
          .map((row) => serializeMembershipRequest(ctx, row))));
    const { items, total } = page(serialized, params);
    return listResponse(c, items, total);
  });

  app.post("/organizations/:id/membership_requests", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({ user_id: z.string().min(1), status: z.enum(["pending", "accepted", "rejected"]).optional() }));
    const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, body.user_id)));
    if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found", { param_name: "user_id" });
    if (await findMembership(ctx, org.id, user.id)) throw new OrbitError(409, ErrorCodes.duplicate_record, "User is already a member of this organization");
    const pending = first(await ctx.db
          .select()
          .from(s.organizationMembershipRequests)
          .where(and(eq(s.organizationMembershipRequests.organizationId, org.id), eq(s.organizationMembershipRequests.userId, user.id), eq(s.organizationMembershipRequests.status, "pending"))));
    if (pending) return c.json(await serializeMembershipRequest(ctx, pending));
    const now = Date.now();
    const id = newId(ID_PREFIX.request);
    await ctx.db.insert(s.organizationMembershipRequests).values({ id, organizationId: org.id, userId: user.id, status: body.status ?? "pending", createdAt: now, updatedAt: now });
    const row = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, id)))!;
    return c.json(await serializeMembershipRequest(ctx, row));
  });

  app.post("/organizations/:id/membership_requests/:rid/accept", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const request = await requireRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await assertOrganizationCapacity(ctx, org);
    const membership = await addMembership(ctx, { organizationId: org.id, userId: request.userId, roleKey: await defaultRoleKey(ctx) });
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "accepted", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    return c.json(await serializeMembership(ctx, membership, { backend: true }));
  });

  app.post("/organizations/:id/membership_requests/:rid/reject", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const request = await requireRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "rejected", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    const updated = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, request.id)))!;
    return c.json(await serializeMembershipRequest(ctx, updated));
  });

  app.get("/organizations/:id/roles", async (c) => {
    await requireOrganization(ctx, c.req.param("id"));
    const params = listParams(c);
    const rows = sortRows((await ctx.db.select().from(s.roles)), params.orderBy ?? "created_at", {
      created_at: (r) => r.createdAt, updated_at: (r) => r.updatedAt, key: (r) => r.key, name: (r) => r.name,
    });
    const { items, total } = page(rows, params);
    return listResponse(c, (await Promise.all(items.map((row) => serializeRole(ctx, row)))), total);
  });
}
