/** Organization CRUD and logo routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";

import { addMembership, assertCanCreateOrganization, creatorRoleKey } from "../../services/orgs";
import { revokeOrganizationAuthorityGrants } from "../../services/oidc/revocation";
import { PERMISSIONS } from "../../services/rbac";
import { resolveCaller } from "../orgs/auth";
import { deletedObject, orgAccess, requireOrganizationsEnabled, resolveSlug } from "../orgs/shared";
import { deleteLogoFile, readLogoPayload, storeLogo } from "../orgs/assets";
import { first } from "../../lib/db";
import { serializeOrganization } from "../../serializers";
import type { OrganizationRow } from "../orgs/shared";

export function registerOrganizationRoutes(app: Hono, ctx: AppContext) {
  const emitOrg = async (type: "organization.created" | "organization.updated" | "organization.deleted", org: OrganizationRow) => {
    await emitEvent(ctx, type, await serializeOrganization(ctx, org, { backend: true }));
  };

  // ─────────── organizations ───────────
  app.post("/organizations", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    await assertCanCreateOrganization(ctx, caller.user);
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256),
      slug: z.string().trim().min(1).max(50).optional(),
    }));
    const settings = ctx.settings.get();
    const now = Date.now();
    const id = newId(ID_PREFIX.org);
    await ctx.db.insert(s.organizations).values({
                  id,
                  name: body.name,
                  slug: await resolveSlug(ctx, settings.organizations.slugEnabled ? body.slug : undefined, body.name),
                  maxAllowedMemberships: settings.organizations.maxAllowedMemberships,
                  adminDeleteEnabled: settings.organizations.adminDeleteEnabled,
                  createdBy: caller.userId,
                  createdAt: now,
                  updatedAt: now,
                });
    const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, id)))!;
    await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await creatorRoleKey(ctx) });
    await emitOrg("organization.created", org);
    return c.json({ response: await serializeOrganization(ctx, org) }, 200);
  });

  app.get("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c);
    return c.json({ response: await serializeOrganization(ctx, org) });
  });

  app.patch("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256).optional(),
      slug: z.string().trim().min(1).max(50).optional(),
    }));
    const settings = ctx.settings.get();
    const patch: Partial<typeof s.organizations.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = settings.organizations.slugEnabled ? await resolveSlug(ctx, body.slug, body.name ?? org.name, org.id) : org.slug;
    await ctx.db.update(s.organizations).set(patch).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });

  app.delete("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_DELETE);
    if (!org.adminDeleteEnabled) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Deleting this organization is disabled for admins");
    const payload = await serializeOrganization(ctx, org, { backend: true });
    const members = await ctx.db.select({ userId: s.organizationMemberships.userId })
      .from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id));
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.delete(s.organizations).where(eq(s.organizations.id, org.id));
    for (const member of members) await revokeOrganizationAuthorityGrants(ctx, member.userId);
    await emitEvent(ctx, "organization.deleted", payload);
    return c.json({ response: deletedObject("organization", org.id) });
  });

  app.put("/organizations/:id/logo", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    const { data, mime } = await readLogoPayload(c);
    const file = storeLogo(ctx, org.id, data, mime);
    deleteLogoFile(ctx, org.imageUrl);
    const imageUrl = `${ctx.env.baseUrl}/v1/client/organization_logos/${file}`;
    await ctx.db.update(s.organizations).set({ imageUrl, hasImage: true, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });

  app.delete("/organizations/:id/logo", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.update(s.organizations).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });
}
