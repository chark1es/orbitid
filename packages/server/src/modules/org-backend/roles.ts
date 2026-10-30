/** Role and permission routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { assertCreatorEligible, assertCustomKey, assertPermissionScopes, assertRoleDeletable, resolvePermissions, resolveRole, roleByKey, serializePermission, serializeRole, setRolePermissions, removeRolePermission } from "../../services/rbac";
import { deletedObject, listParams, page, sortRows } from "../orgs/shared";
import { first } from "../../lib/db";
import { listResponse, resolvePermission } from "./shared";

export function registerRoleRoutes(app: Hono, ctx: AppContext) {
  // ─────────── roles ───────────
  app.get("/roles", async (c) => {
    const params = listParams(c);
    let rows = (await ctx.db.select().from(s.roles));
    if (params.query) rows = rows.filter((r) => [r.id, r.key, r.name].some((v) => v.toLowerCase().includes(params.query!)));
    const sorted = sortRows(rows, params.orderBy ?? "created_at", { created_at: (r) => r.createdAt, updated_at: (r) => r.updatedAt, key: (r) => r.key, name: (r) => r.name });
    const { items, total } = page(sorted, params);
    return listResponse(c, (await Promise.all(items.map((row) => serializeRole(ctx, row)))), total);
  });

  app.post("/roles", async (c) => {
    const body = await parseBody(c, z.object({
      key: z.string().min(1),
      name: z.string().trim().min(1).max(256),
      description: z.string().max(1024).optional(),
      is_creator_eligible: z.boolean().optional(),
      permissions: z.array(z.string()).optional(),
    }));
    assertCustomKey(body.key, "role");
    // Every check runs before the insert: a refused request leaves no half-created role behind.
    assertCreatorEligible(body.key, body.is_creator_eligible);
    if (await roleByKey(ctx, body.key)) throw new OrbitError(409, ErrorCodes.duplicate_record, `Role ${body.key} already exists`);
    const requested = body.permissions ? await resolvePermissions(ctx, body.permissions) : [];
    assertPermissionScopes(body.key, requested);
    const now = Date.now();
    const id = newId(ID_PREFIX.role);
    await ctx.db.insert(s.roles).values({
                  id, key: body.key, name: body.name, description: body.description ?? "", isCreatorEligible: body.is_creator_eligible ?? false, isSystem: false, createdAt: now, updatedAt: now,
                });
    const row = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, id)))!;
    if (requested.length) await setRolePermissions(ctx, row, body.permissions!);
    const created = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, id)))!;
    await emitEvent(ctx, "role.created", await serializeRole(ctx, created));
    return c.json(await serializeRole(ctx, created));
  });

  app.get("/roles/:id", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    return c.json(await serializeRole(ctx, role));
  });

  app.patch("/roles/:id", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    if (role.isSystem) throw new OrbitError(403, ErrorCodes.not_allowed_access, "System roles cannot be modified");
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256).optional(),
      description: z.string().max(1024).optional(),
      is_creator_eligible: z.boolean().optional(),
      permissions: z.array(z.string()).optional(),
    }));
    // Validate before writing, for the same atomicity reason as create.
    if (body.is_creator_eligible) assertCreatorEligible(role.key, body.is_creator_eligible);
    if (body.permissions !== undefined) assertPermissionScopes(role.key, await resolvePermissions(ctx, body.permissions));
    const patch: Partial<typeof s.roles.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.is_creator_eligible !== undefined) patch.isCreatorEligible = body.is_creator_eligible;
    await ctx.db.update(s.roles).set(patch).where(eq(s.roles.id, role.id));
    if (body.permissions !== undefined) await setRolePermissions(ctx, role, body.permissions);
    const updated = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, role.id)))!;
    await emitEvent(ctx, "role.updated", await serializeRole(ctx, updated));
    return c.json(await serializeRole(ctx, updated));
  });

  app.delete("/roles/:id", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    await assertRoleDeletable(ctx, role);
    const payload = await serializeRole(ctx, role);
    await ctx.db.delete(s.roles).where(eq(s.roles.id, role.id));
    await emitEvent(ctx, "role.deleted", payload);
    return c.json(deletedObject("role", role.id));
  });

  app.post("/roles/:id/permissions", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    if (role.isSystem) throw new OrbitError(403, ErrorCodes.not_allowed_access, "System roles cannot be modified");
    const body = await parseBody(c, z.object({ permissions: z.array(z.string()) }));
    await setRolePermissions(ctx, role, body.permissions);
    const updated = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, role.id)))!;
    await emitEvent(ctx, "role.updated", await serializeRole(ctx, updated));
    return c.json(await serializeRole(ctx, updated));
  });

  app.delete("/roles/:id/permissions/:permissionId", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    if (role.isSystem) throw new OrbitError(403, ErrorCodes.not_allowed_access, "System roles cannot be modified");
    const permission = await resolvePermission(ctx, c.req.param("permissionId"));
    if (!permission) throw new OrbitError(404, ErrorCodes.resource_not_found, "Permission not found");
    if (!first(await ctx.db.select().from(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, permission.id))))) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "Role does not have this permission");
    }
    await removeRolePermission(ctx, role, permission.id);
    const updated = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, role.id)))!;
    await emitEvent(ctx, "role.updated", await serializeRole(ctx, updated));
    return c.json(await serializeRole(ctx, updated));
  });

  // ─────────── permissions ───────────
  app.get("/permissions", async (c) => {
    const params = listParams(c);
    const type = c.req.query("type");
    let rows = (await ctx.db.select().from(s.permissions));
    if (type) rows = rows.filter((r) => r.type === type);
    if (params.query) rows = rows.filter((r) => [r.id, r.key, r.name].some((v) => v.toLowerCase().includes(params.query!)));
    const sorted = sortRows(rows, params.orderBy ?? "created_at", { created_at: (r) => r.createdAt, updated_at: (r) => r.updatedAt, key: (r) => r.key });
    const { items, total } = page(sorted, params);
    return listResponse(c, items.map(serializePermission), total);
  });

  app.post("/permissions", async (c) => {
    const body = await parseBody(c, z.object({
      key: z.string().min(1),
      name: z.string().trim().min(1).max(256),
      description: z.string().max(1024).optional(),
    }));
    assertCustomKey(body.key, "permission");
    if (first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.key, body.key)))) {
      throw new OrbitError(409, ErrorCodes.duplicate_record, `Permission ${body.key} already exists`);
    }
    const now = Date.now();
    const id = newId(ID_PREFIX.permission);
    await ctx.db.insert(s.permissions).values({ id, key: body.key, name: body.name, description: body.description ?? "", type: "user", createdAt: now, updatedAt: now });
    const row = first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.id, id)))!;
    await emitEvent(ctx, "permission.created", serializePermission(row));
    return c.json(serializePermission(row));
  });

  app.get("/permissions/:id", async (c) => {
    const row = await resolvePermission(ctx, c.req.param("id"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Permission not found");
    return c.json(serializePermission(row));
  });

  app.patch("/permissions/:id", async (c) => {
    const row = await resolvePermission(ctx, c.req.param("id"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Permission not found");
    if (row.type === "system") throw new OrbitError(403, ErrorCodes.not_allowed_access, "System permissions cannot be modified");
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(256).optional(), description: z.string().max(1024).optional() }));
    await ctx.db.update(s.permissions).set({
                  ...(body.name !== undefined ? { name: body.name } : {}),
                  ...(body.description !== undefined ? { description: body.description } : {}),
                  updatedAt: Date.now(),
                }).where(eq(s.permissions.id, row.id));
    const updated = first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.id, row.id)))!;
    await emitEvent(ctx, "permission.updated", serializePermission(updated));
    return c.json(serializePermission(updated));
  });

  app.delete("/permissions/:id", async (c) => {
    const row = await resolvePermission(ctx, c.req.param("id"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Permission not found");
    if (row.type === "system") throw new OrbitError(403, ErrorCodes.not_allowed_access, "System permissions cannot be deleted");
    const payload = serializePermission(row);
    await ctx.db.delete(s.permissions).where(eq(s.permissions.id, row.id));
    await emitEvent(ctx, "permission.deleted", payload);
    return c.json(deletedObject("permission", row.id));
  });
}
