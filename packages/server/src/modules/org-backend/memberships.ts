/** Organization membership routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { serializeMembership } from "../../serializers";
import { addMembership, assertOrganizationCapacity, defaultRoleKey } from "../../services/orgs";
import { assertOrganizationRole, isAdminRole, isLastAdmin } from "../../services/rbac";
import { revokeOrganizationAuthorityGrants } from "../../services/oidc/revocation";
import { deletedObject, findMembership, listParams, mergeMetadata, page, requireOrganization, sortRows } from "../orgs/shared";
import { first } from "../../lib/db";
import { metadata } from "./shared";
import { listResponse, requireMembership } from "./shared";

export function registerMembershipRoutes(app: Hono, ctx: AppContext) {
  // ─────────── memberships ───────────
  app.get("/organizations/:id/memberships", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const params = listParams(c);
    const role = c.req.query("role");
    const userIds = [...(c.req.queries("user_id") ?? []), ...(c.req.queries("user_id[]") ?? [])];
    let rows = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id)));
    if (userIds.length) rows = rows.filter((r) => userIds.includes(r.userId));
    if (role) rows = rows.filter((r) => r.roleKey === role);
    let serialized = await Promise.all(rows.map((row) => serializeMembership(ctx, row, { backend: true })));
    if (params.query) {
      const q = params.query;
      serialized = serialized.filter((m) => [m.public_user_data.identifier, m.public_user_data.first_name, m.public_user_data.last_name, m.public_user_data.user_id, m.role, m.role_name]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
    }
    const sorted = sortRows(serialized, params.orderBy ?? "-created_at", {
      created_at: (m) => m.created_at, updated_at: (m) => m.updated_at, role: (m) => m.role,
    });
    const { items, total } = page(sorted, params);
    return listResponse(c, items, total);
  });

  app.post("/organizations/:id/memberships", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({
      user_id: z.string().min(1),
      role: z.string().optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, body.user_id)));
    if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found", { param_name: "user_id" });
    if (await findMembership(ctx, org.id, user.id)) throw new OrbitError(409, ErrorCodes.duplicate_record, "User is already a member of this organization");
    const roleKey = body.role ?? await defaultRoleKey(ctx);
    await assertOrganizationRole(ctx, roleKey);
    await assertOrganizationCapacity(ctx, org);
    const membership = await addMembership(ctx, { organizationId: org.id, userId: user.id, roleKey, publicMetadata: body.public_metadata, privateMetadata: body.private_metadata });
    return c.json(await serializeMembership(ctx, membership, { backend: true }));
  });

  app.patch("/organizations/:id/memberships/:userId", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    const body = await parseBody(c, z.object({
      role: z.string().optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    const patch: Partial<typeof s.organizationMemberships.$inferInsert> = { updatedAt: Date.now() };
    if (body.role !== undefined && body.role !== membership.roleKey) {
      const role = await assertOrganizationRole(ctx, body.role);
      if (await isLastAdmin(ctx, membership) && !await isAdminRole(ctx, role.key)) {
        throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, "The last admin of an organization cannot be demoted", { role: membership.roleKey });
      }
      patch.roleKey = role.key;
    }
    if (body.public_metadata !== undefined) patch.publicMetadata = mergeMetadata(membership.publicMetadata, body.public_metadata);
    if (body.private_metadata !== undefined) patch.privateMetadata = mergeMetadata(membership.privateMetadata, body.private_metadata);
    const roleChanged = patch.roleKey !== undefined && patch.roleKey !== membership.roleKey;
    await ctx.db.update(s.organizationMemberships).set(patch).where(eq(s.organizationMemberships.id, membership.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id)))!;
    if (roleChanged) {
      // Tokens issued for the old role carry the old permissions. Revoke only the grants of applications that
      // assert organization/group authority; the user's browser session and unrelated grants stay intact.
      await revokeOrganizationAuthorityGrants(ctx, membership.userId);
    }
    await emitEvent(ctx, "organizationMembership.updated", await serializeMembership(ctx, updated, { backend: true }));
    return c.json(await serializeMembership(ctx, updated, { backend: true }));
  });

  app.patch("/organizations/:id/memberships/:userId/metadata", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    const body = await parseBody(c, z.object({ public_metadata: metadata.optional(), private_metadata: metadata.optional() }));
    await ctx.db.update(s.organizationMemberships).set({
                  publicMetadata: mergeMetadata(membership.publicMetadata, body.public_metadata),
                  privateMetadata: mergeMetadata(membership.privateMetadata, body.private_metadata),
                  updatedAt: Date.now(),
                }).where(eq(s.organizationMemberships.id, membership.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id)))!;
    await emitEvent(ctx, "organizationMembership.updated", await serializeMembership(ctx, updated, { backend: true }));
    return c.json(await serializeMembership(ctx, updated, { backend: true }));
  });

  app.delete("/organizations/:id/memberships/:userId", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    if (await isLastAdmin(ctx, membership)) {
      throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, "The last admin of an organization cannot be removed", { role: membership.roleKey });
    }
    const payload = await serializeMembership(ctx, membership, { backend: true });
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    // The RP must not keep claims that include an organization the user no longer belongs to. The browser session
    // is intentionally left alone.
    await revokeOrganizationAuthorityGrants(ctx, membership.userId);
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json(deletedObject("organization_membership", membership.id));
  });
}
