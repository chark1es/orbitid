/** Organization domain routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { applyDomainEnrollment, emitDomainEvent } from "../../services/orgs";
import { deletePendingForDomain, findDomain, findDomainByName, normalizeDomain } from "../../services/org-domains";
import { deletedObject, listParams, page, requireOrganization, sortRows } from "../orgs/shared";
import { serializeOrganizationDomain, serializeOrganizationInvitation } from "../orgs/serializers";
import { first } from "../../lib/db";
import { listResponse } from "./shared";

export function registerDomainRoutes(app: Hono, ctx: AppContext) {
  // ─────────── domains ───────────
  app.get("/organizations/:id/domains", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const params = listParams(c);
    const domainRows = await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.organizationId, org.id));
    const serialized = await Promise.all(domainRows.map((row) => serializeOrganizationDomain(ctx, row)));
    const { items, total } = page(sortRows(serialized, params.orderBy ?? "-created_at", {
      created_at: (d) => d.created_at, updated_at: (d) => d.updated_at, name: (d) => d.name,
    }), params);
    return listResponse(c, items, total);
  });

  app.post("/organizations/:id/domains", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({
      name: z.string().min(1),
      enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]).optional(),
    }));
    const name = normalizeDomain(body.name);
    if (await findDomainByName(ctx, org.id, name)) throw new OrbitError(409, ErrorCodes.duplicate_record, `${name} is already a domain of this organization`);
    const now = Date.now();
    const id = newId(ID_PREFIX.domain);
    await ctx.db.insert(s.organizationDomains).values({
                  id, organizationId: org.id, name, enrollmentMode: body.enrollment_mode ?? "manual_invitation", verified: false, createdAt: now, updatedAt: now,
                });
    const row = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, id)))!;
    await emitDomainEvent(ctx, "organizationDomain.created", row);
    return c.json(await serializeOrganizationDomain(ctx, row));
  });

  app.get("/organizations/:id/domains/:did", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const row = await findDomain(ctx, org.id, c.req.param("did"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    return c.json(await serializeOrganizationDomain(ctx, row));
  });

  app.patch("/organizations/:id/domains/:did", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const row = await findDomain(ctx, org.id, c.req.param("did"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({
      enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]).optional(),
      delete_pending: z.boolean().optional(),
    }));
    if (body.delete_pending) {
      for (const invitation of await deletePendingForDomain(ctx, org.id, row.name)) {
        await emitEvent(ctx, "organizationInvitation.revoked", await serializeOrganizationInvitation(ctx, invitation, { backend: true }));
      }
    }
    if (body.enrollment_mode) await ctx.db.update(s.organizationDomains).set({ enrollmentMode: body.enrollment_mode, updatedAt: Date.now() }).where(eq(s.organizationDomains.id, row.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, row.id)))!;
    if (updated.verified && updated.enrollmentMode === "automatic_invitation") await applyDomainEnrollment(ctx, updated);
    await emitDomainEvent(ctx, "organizationDomain.updated", updated);
    return c.json(await serializeOrganizationDomain(ctx, updated));
  });

  app.delete("/organizations/:id/domains/:did", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const row = await findDomain(ctx, org.id, c.req.param("did"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const payload = await serializeOrganizationDomain(ctx, row);
    await ctx.db.delete(s.organizationDomains).where(eq(s.organizationDomains.id, row.id));
    await emitEvent(ctx, "organizationDomain.deleted", payload);
    return c.json(deletedObject("organization_domain", row.id));
  });
}
