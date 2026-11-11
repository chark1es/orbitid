/** Organization CRUD, logo, and metadata routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { serializeOrganization } from "../../serializers";
import { addMembership, creatorRoleKey } from "../../services/orgs";
import { revokeOrganizationAuthorityGrants } from "../../services/oidc/revocation";
import { deletedObject, listParams, mergeMetadata, page, requireOrganization, resolveSlug, sortRows } from "../orgs/shared";
import { deleteLogoFile, readLogoPayload, storeLogo } from "../orgs/assets";
import { first } from "../../lib/db";
import { metadata } from "./shared";
import { listResponse, orgEventPayload } from "./shared";

export function registerOrganizationRoutes(app: Hono, ctx: AppContext) {
  // ─────────── organizations ───────────
  app.get("/organizations", async (c) => {
    const params = listParams(c);
    const ids = [...(c.req.queries("organization_ids") ?? []), ...(c.req.queries("organization_ids[]") ?? [])];
    let rows = (await ctx.db.select().from(s.organizations));
    if (ids.length) rows = rows.filter((o) => ids.includes(o.id));
    if (params.query) {
      const q = params.query;
      rows = rows.filter((o) => [o.id, o.name, o.slug ?? ""].some((v) => v.toLowerCase().includes(q)));
    }
    const sorted = sortRows(rows, params.orderBy ?? "-created_at", {
      created_at: (o) => o.createdAt, updated_at: (o) => o.updatedAt, name: (o) => o.name,
    });
    const { items, total } = page(sorted, params);
    const counts = c.req.query("include_members_count") !== "false";
    return listResponse(c, (await Promise.all(items.map((o) => serializeOrganization(ctx, o, { backend: true, counts })))), total);
  });

  app.post("/organizations", async (c) => {
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256),
      slug: z.string().trim().min(1).max(50).optional(),
      created_by: z.string().optional(),
      max_allowed_memberships: z.coerce.number().int().min(1).optional(),
      admin_delete_enabled: z.boolean().optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    if (body.created_by && !first(await ctx.db.select().from(s.users).where(eq(s.users.id, body.created_by)))) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found", { param_name: "created_by" });
    }
    const settings = ctx.settings.get();
    const now = Date.now();
    const id = newId(ID_PREFIX.org);
    await ctx.db.insert(s.organizations).values({
                  id,
                  name: body.name,
                  slug: await resolveSlug(ctx, body.slug, body.name),
                  maxAllowedMemberships: body.max_allowed_memberships ?? settings.organizations.maxAllowedMemberships,
                  adminDeleteEnabled: body.admin_delete_enabled ?? settings.organizations.adminDeleteEnabled,
                  publicMetadata: body.public_metadata ?? {},
                  privateMetadata: body.private_metadata ?? {},
                  createdBy: body.created_by ?? null,
                  createdAt: now,
                  updatedAt: now,
                });
    const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, id)))!;
    if (body.created_by) await addMembership(ctx, { organizationId: org.id, userId: body.created_by, roleKey: await creatorRoleKey(ctx) });
    await emitEvent(ctx, "organization.created", await orgEventPayload(ctx, org));
    return c.json(await serializeOrganization(ctx, org, { backend: true }));
  });

  app.get("/organizations/:id", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    return c.json(await serializeOrganization(ctx, org, { backend: true }));
  });

  app.patch("/organizations/:id", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256).optional(),
      slug: z.string().trim().min(1).max(50).optional(),
      max_allowed_memberships: z.coerce.number().int().min(1).optional(),
      admin_delete_enabled: z.boolean().optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    const patch: Partial<typeof s.organizations.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = await resolveSlug(ctx, body.slug, body.name ?? org.name, org.id);
    if (body.max_allowed_memberships !== undefined) patch.maxAllowedMemberships = body.max_allowed_memberships;
    if (body.admin_delete_enabled !== undefined) patch.adminDeleteEnabled = body.admin_delete_enabled;
    if (body.public_metadata !== undefined) patch.publicMetadata = mergeMetadata(org.publicMetadata, body.public_metadata);
    if (body.private_metadata !== undefined) patch.privateMetadata = mergeMetadata(org.privateMetadata, body.private_metadata);
    await ctx.db.update(s.organizations).set(patch).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitEvent(ctx, "organization.updated", await orgEventPayload(ctx, updated));
    return c.json(await serializeOrganization(ctx, updated, { backend: true }));
  });

  app.patch("/organizations/:id/metadata", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({ public_metadata: metadata.optional(), private_metadata: metadata.optional() }));
    await ctx.db.update(s.organizations).set({
                  publicMetadata: mergeMetadata(org.publicMetadata, body.public_metadata),
                  privateMetadata: mergeMetadata(org.privateMetadata, body.private_metadata),
                  updatedAt: Date.now(),
                }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitEvent(ctx, "organization.updated", await orgEventPayload(ctx, updated));
    return c.json(await serializeOrganization(ctx, updated, { backend: true }));
  });

  app.delete("/organizations/:id", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const payload = await orgEventPayload(ctx, org);
    // Read the members before the cascade removes their rows: their tokens may still assert this organization.
    const members = await ctx.db.select({ userId: s.organizationMemberships.userId })
      .from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id));
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.delete(s.organizations).where(eq(s.organizations.id, org.id));
    for (const member of members) await revokeOrganizationAuthorityGrants(ctx, member.userId);
    await emitEvent(ctx, "organization.deleted", payload);
    return c.json(deletedObject("organization", org.id));
  });

  app.put("/organizations/:id/logo", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const { data, mime } = await readLogoPayload(c);
    const file = storeLogo(ctx, org.id, data, mime);
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.update(s.organizations).set({ imageUrl: `${ctx.env.baseUrl}/v1/client/organization_logos/${file}`, hasImage: true, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitEvent(ctx, "organization.updated", await orgEventPayload(ctx, updated));
    return c.json(await serializeOrganization(ctx, updated, { backend: true }));
  });

  app.delete("/organizations/:id/logo", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.update(s.organizations).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitEvent(ctx, "organization.updated", await orgEventPayload(ctx, updated));
    return c.json(await serializeOrganization(ctx, updated, { backend: true }));
  });
}
