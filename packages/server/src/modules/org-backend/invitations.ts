/** Organization invitation routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { emitEvent } from "../../services/webhooks";
import { createOrganizationInvitation } from "../../services/orgs";
import { normalizeEmail } from "../../services/org-domains";
import { invitationUrl, listParams, page, requireOrganization, sortRows } from "../orgs/shared";
import { effectiveInvitationStatus, serializeOrganizationInvitation } from "../orgs/serializers";
import { first } from "../../lib/db";
import { metadata } from "./shared";
import { listResponse, findInvitation, notifyInvitation } from "./shared";

export function registerInvitationRoutes(app: Hono, ctx: AppContext) {
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
}
