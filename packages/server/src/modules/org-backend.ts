// Backend API organizations, memberships, invitations, domains, roles, permissions (mounted at /v1)
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { parseBody } from "../lib/http";
import { emitEvent } from "../services/webhooks";
import { sendEmail } from "../services/mail";
import { serializeMembership, serializeOrganization } from "../serializers";
import {
  addMembership, applyDomainEnrollment, assertOrganizationCapacity, createOrganizationInvitation, creatorRoleKey,
  defaultRoleKey, emitDomainEvent,
} from "../services/orgs";
import {
  deletePendingForDomain, findDomain, findDomainByName, normalizeDomain, normalizeEmail,
} from "../services/org-domains";
import {
  assertCustomKey, assertRoleDeletable, isAdminRole, isLastAdmin, resolvePermissions, resolveRole,
  roleByKey, setRolePermissions, serializePermission, serializeRole,
} from "../services/rbac";
import {
  deletedObject, findMembership, invitationUrl, listParams, mergeMetadata, page,
  requireOrganization, resolveSlug, sortRows,
} from "./orgs/shared";
import { deleteLogoFile, readLogoPayload, storeLogo } from "./orgs/assets";
import {
  effectiveInvitationStatus, serializeMembershipRequest, serializeOrganizationDomain, serializeOrganizationInvitation,
} from "./orgs/serializers";
import { first } from "../lib/db";

const metadata = z.record(z.string(), z.unknown());

function listResponse(c: Context, data: unknown[], total: number) {
  return c.json({ data, total_count: total });
}

function orgEventPayload(ctx: AppContext, org: typeof s.organizations.$inferSelect) {
  return serializeOrganization(ctx, org, { backend: true });
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

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
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.delete(s.organizations).where(eq(s.organizations.id, org.id));
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
    if (!await roleByKey(ctx, roleKey)) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${roleKey} does not exist`, { param_name: "role" });
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
      const role = await roleByKey(ctx, body.role);
      if (!role) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${body.role} does not exist`, { param_name: "role" });
      if (await isLastAdmin(ctx, membership) && !await isAdminRole(ctx, role.key)) {
        throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, "The last admin of an organization cannot be demoted", { role: membership.roleKey });
      }
      patch.roleKey = role.key;
    }
    if (body.public_metadata !== undefined) patch.publicMetadata = mergeMetadata(membership.publicMetadata, body.public_metadata);
    if (body.private_metadata !== undefined) patch.privateMetadata = mergeMetadata(membership.privateMetadata, body.private_metadata);
    await ctx.db.update(s.organizationMemberships).set(patch).where(eq(s.organizationMemberships.id, membership.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id)))!;
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
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json(deletedObject("organization_membership", membership.id));
  });

  // ─────────── invitations ───────────
  app.get("/organizations/:id/invitations", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const params = listParams(c);
    const status = c.req.query("status");
    const invitationRows = await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.organizationId, org.id));
    let serialized = await Promise.all(invitationRows.map((row) => serializeOrganizationInvitation(ctx, row, { backend: true })));
    if (status) serialized = serialized.filter((r) => r.status === status);
    if (params.query) serialized = serialized.filter((r) => r.email_address.includes(params.query!));
    const sorted = sortRows(serialized, params.orderBy ?? "-created_at", {
      created_at: (r) => r.created_at, updated_at: (r) => r.updated_at, email_address: (r) => r.email_address,
    });
    const { items, total } = page(sorted, params);
    return listResponse(c, items, total);
  });

  app.post("/organizations/:id/invitations/bulk", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({
      email_addresses: z.array(z.string().min(3)).min(1),
      role: z.string().optional(),
      inviter_user_id: z.string().optional(),
      redirect_url: z.string().optional(),
      notify: z.boolean().optional(),
      expires_at: z.coerce.number().int().optional(),
      expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    const created = [];
    for (const raw of body.email_addresses) {
      const result = await createOrganizationInvitation(ctx, {
        organization: org,
        email: normalizeEmail(raw),
        roleKey: body.role,
        inviterUserId: body.inviter_user_id ?? null,
        redirectUrl: body.redirect_url ?? null,
        publicMetadata: body.public_metadata,
        privateMetadata: body.private_metadata,
        expiresAt: body.expires_at ?? (body.expires_in_days ? Date.now() + body.expires_in_days * 86_400_000 : null),
      }).catch((err: unknown) => {
        if (err instanceof OrbitError && err.code === ErrorCodes.duplicate_record) return null;
        throw err;
      });
      if (!result) continue;
      if (body.notify) await notifyInvitation(ctx, org, result.invitation.email, result.ticket, result.invitation.roleKey);
      created.push(await serializeOrganizationInvitation(ctx, result.invitation, { backend: true, url: body.notify ? null : invitationUrl(ctx, result.ticket) }));
    }
    return c.json(created);
  });

  app.post("/organizations/:id/invitations", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({
      email_address: z.string().min(3),
      role: z.string().optional(),
      inviter_user_id: z.string().optional(),
      redirect_url: z.string().optional(),
      notify: z.boolean().optional(),
      expires_at: z.coerce.number().int().optional(),
      expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
      public_metadata: metadata.optional(),
      private_metadata: metadata.optional(),
    }));
    const { invitation, ticket } = await createOrganizationInvitation(ctx, {
      organization: org,
      email: normalizeEmail(body.email_address),
      roleKey: body.role,
      inviterUserId: body.inviter_user_id ?? null,
      redirectUrl: body.redirect_url ?? null,
      publicMetadata: body.public_metadata,
      privateMetadata: body.private_metadata,
      expiresAt: body.expires_at ?? (body.expires_in_days ? Date.now() + body.expires_in_days * 86_400_000 : null),
    });
    if (body.notify) await notifyInvitation(ctx, org, invitation.email, ticket, invitation.roleKey);
    return c.json(await serializeOrganizationInvitation(ctx, invitation, { backend: true, url: body.notify ? null : invitationUrl(ctx, ticket) }));
  });

  app.get("/organizations/:id/invitations/:invId", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const invitation = await findInvitation(ctx, org.id, c.req.param("invId"));
    return c.json(await serializeOrganizationInvitation(ctx, invitation, { backend: true }));
  });

  app.post("/organizations/:id/invitations/:invId/revoke", async (c) => {
    const org = await requireOrganization(ctx, c.req.param("id"));
    const invitation = await findInvitation(ctx, org.id, c.req.param("invId"));
    if (effectiveInvitationStatus(invitation) !== "pending") {
      throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${effectiveInvitationStatus(invitation)}`);
    }
    const revoked = first(await ctx.db.update(s.organizationInvitations).set({ status: "revoked", updatedAt: Date.now() })
      .where(and(eq(s.organizationInvitations.id, invitation.id), eq(s.organizationInvitations.status, "pending")))
      .returning());
    if (!revoked) throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${invitation.status}`);
    await emitEvent(ctx, "organizationInvitation.revoked", await serializeOrganizationInvitation(ctx, revoked, { backend: true }));
    return c.json(await serializeOrganizationInvitation(ctx, revoked, { backend: true }));
  });

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
    if (await roleByKey(ctx, body.key)) throw new OrbitError(409, ErrorCodes.duplicate_record, `Role ${body.key} already exists`);
    if (body.permissions) await resolvePermissions(ctx, body.permissions);
    const now = Date.now();
    const id = newId(ID_PREFIX.role);
    await ctx.db.insert(s.roles).values({
                  id, key: body.key, name: body.name, description: body.description ?? "", isCreatorEligible: body.is_creator_eligible ?? false, isSystem: false, createdAt: now, updatedAt: now,
                });
    const row = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, id)))!;
    if (body.permissions?.length) await setRolePermissions(ctx, row, body.permissions);
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
    const body = await parseBody(c, z.object({ permissions: z.array(z.string()) }));
    await setRolePermissions(ctx, role, body.permissions);
    const updated = first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, role.id)))!;
    await emitEvent(ctx, "role.updated", await serializeRole(ctx, updated));
    return c.json(await serializeRole(ctx, updated));
  });

  app.delete("/roles/:id/permissions/:permissionId", async (c) => {
    const role = await resolveRole(ctx, c.req.param("id"));
    if (!role) throw new OrbitError(404, ErrorCodes.resource_not_found, "Role not found");
    const permission = await resolvePermission(ctx, c.req.param("permissionId"));
    if (!permission) throw new OrbitError(404, ErrorCodes.resource_not_found, "Permission not found");
    if (!first(await ctx.db.select().from(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, permission.id))))) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "Role does not have this permission");
    }
    await ctx.db.delete(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, permission.id)));
    await ctx.db.update(s.roles).set({ updatedAt: Date.now() }).where(eq(s.roles.id, role.id));
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

  return app;
}

async function requireMembership(ctx: AppContext, org: typeof s.organizations.$inferSelect, userId: string) {
  const membership = await findMembership(ctx, org.id, userId);
  if (!membership) throw new OrbitError(404, ErrorCodes.not_a_member_in_organization, "User is not a member of this organization");
  return membership;
}

async function findInvitation(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.organizationId, orgId), eq(s.organizationInvitations.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
  return row;
}

async function requireRequest(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationMembershipRequests)
      .where(and(eq(s.organizationMembershipRequests.organizationId, orgId), eq(s.organizationMembershipRequests.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Membership request not found");
  return row;
}

async function resolvePermission(ctx: AppContext, idOrKey: string) {
  return first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.id, idOrKey)))
    ?? first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.key, idOrKey)));
}



async function notifyInvitation(ctx: AppContext, org: typeof s.organizations.$inferSelect, email: string, ticket: string, roleKey: string) {
  await sendEmail(ctx, {
    to: email,
    template: "organization_invitation",
    vars: {
      organization_name: org.name,
      organization_slug: org.slug ?? "",
      email_address: email,
      role: roleKey,
      invitation_url: invitationUrl(ctx, ticket),
    },
  });
}
