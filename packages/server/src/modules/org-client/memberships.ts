/** Organization membership routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { filterAsync } from "../../lib/async";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { serializeMembership } from "../../serializers";
import { PERMISSIONS, assertNotLastAdmin, assertOrganizationRole, isAdminRole, isLastAdmin, roleByKey } from "../../services/rbac";
import { deletedObject, listParams, orgAccess, page, requireMembership, sortRows } from "../orgs/shared";
import { first } from "../../lib/db";

export function registerMembershipRoutes(app: Hono, ctx: AppContext) {
  // ─────────── memberships ───────────
  app.get("/organizations/:id/memberships", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const params = listParams(c);
    const role = c.req.query("role");
    let rows = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id)));
    if (role) rows = await filterAsync(rows, async (r) => r.roleKey === role || ((await roleByKey(ctx, r.roleKey))?.name ?? "").toLowerCase() === role.toLowerCase());
    const serialized = await Promise.all(rows.map((row) => serializeMembership(ctx, row)));
    const filtered = params.query
      ? serialized.filter((m) =>
        [m.public_user_data.identifier, m.public_user_data.first_name, m.public_user_data.last_name, m.public_user_data.user_id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(params.query!)))
      : serialized;
    const rows2 = sortRows(filtered, params.orderBy ?? "-created_at", {
      created_at: (m) => m.created_at, updated_at: (m) => m.updated_at, role: (m) => m.role,
    });
    if (params.paginated) {
      const { items, total } = page(rows2, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: rows2 });
  });

  app.patch("/organizations/:id/memberships/:userId", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const body = await parseBody(c, z.object({ role: z.string().min(1) }));
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    const role = await assertOrganizationRole(ctx, body.role);
    if (role.key === membership.roleKey) return c.json({ response: await serializeMembership(ctx, membership) });
    if (await isLastAdmin(ctx, membership) && !await isAdminRole(ctx, role.key)) {
      throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, "The last admin of an organization cannot be demoted", { role: membership.roleKey });
    }
    await ctx.db.update(s.organizationMemberships).set({ roleKey: role.key, updatedAt: Date.now() }).where(eq(s.organizationMemberships.id, membership.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id)))!;
    await emitEvent(ctx, "organizationMembership.updated", await serializeMembership(ctx, updated, { backend: true }));
    return c.json({ response: await serializeMembership(ctx, updated) });
  });

  app.delete("/organizations/:id/memberships/:userId", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    await assertNotLastAdmin(ctx, membership);
    const payload = await serializeMembership(ctx, membership, { backend: true });
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json({ response: deletedObject("organization_membership", membership.id) });
  });
}
