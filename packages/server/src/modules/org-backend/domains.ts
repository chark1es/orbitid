/** Organization domain routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { hashLowEntropy, randomCode, verifyLowEntropy } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { sendEmail } from "../../services/mail";
import { emitEvent } from "../../services/webhooks";
import { applyDomainEnrollment, emitDomainEvent } from "../../services/orgs";
import { deletePendingForDomain, emailDomain, findDomain, findDomainByName, normalizeDomain, normalizeEmail } from "../../services/org-domains";
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

  app.post("/organizations/:id/domains/:did/prepare_affiliation_verification", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const domain = await findDomain(ctx, org.id, c.req.param("did"));
    if (!domain) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({ affiliation_email_address: z.string().min(3) }));
    const email = normalizeEmail(body.affiliation_email_address);
    if (emailDomain(email) !== domain.name) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `Affiliation email address must belong to ${domain.name}`, { param_name: "affiliation_email_address" });
    }
    // Per-recipient throttle: this route sends mail to an address an operator names, so it must not become a
    // way to flood that mailbox. Resending stays possible after the window.
    await hit(ctx, `org_domain_affiliation:${email}`, 5, 60_000);
    const settings = ctx.settings.get();
    const now = Date.now();
    const code = randomCode(settings.email.codeLength);
    await ctx.db.insert(s.verifications).values({
      id: newId(ID_PREFIX.verification), purpose: "org_domain", strategy: "email_code", identifier: email, ownerId: domain.id,
      codeHash: hashLowEntropy(ctx.env.encryptionKey, code), attempts: 0, maxAttempts: 5, expiresAt: now + settings.email.codeLifetimeSeconds * 1000, createdAt: now,
    });
    await ctx.db.update(s.organizationDomains).set({ affiliationEmailAddress: email, updatedAt: now }).where(eq(s.organizationDomains.id, domain.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id)))!;
    await sendEmail(ctx, {
      to: email,
      template: "domain_verification_code",
      vars: { code, domain: domain.name, organization_name: org.name, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60) },
    });
    return c.json(await serializeOrganizationDomain(ctx, updated));
  });

  app.post("/organizations/:id/domains/:did/attempt_affiliation_verification", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const domain = await findDomain(ctx, org.id, c.req.param("did"));
    if (!domain) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({ code: z.string().min(1) }));
    const verification = (await ctx.db
      .select()
      .from(s.verifications)
      .where(and(eq(s.verifications.ownerId, domain.id), eq(s.verifications.purpose, "org_domain"))))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!verification || verification.verifiedAt) {
      throw new OrbitError(422, ErrorCodes.verification_failed, "Start domain verification first");
    }
    if (verification.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.verification_expired, "Verification code has expired");
    if (verification.attempts >= verification.maxAttempts) throw new OrbitError(429, ErrorCodes.too_many_attempts, "Too many attempts. Request a new code.");
    await ctx.db.update(s.verifications).set({ attempts: verification.attempts + 1 }).where(eq(s.verifications.id, verification.id));
    if (!verification.codeHash || !verifyLowEntropy(ctx.env.encryptionKey, body.code.trim(), verification.codeHash)) {
      throw new OrbitError(422, ErrorCodes.form_code_incorrect, "Verification code is incorrect", { param_name: "code" });
    }
    const now = Date.now();
    await ctx.db.update(s.verifications).set({ verifiedAt: now, consumedAt: now }).where(eq(s.verifications.id, verification.id));
    await ctx.db.update(s.organizationDomains).set({ verified: true, updatedAt: now }).where(eq(s.organizationDomains.id, domain.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id)))!;
    if (updated.enrollmentMode === "automatic_invitation") await applyDomainEnrollment(ctx, updated);
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
