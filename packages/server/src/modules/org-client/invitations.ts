/** Organization invitation routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { validateRedirectUrl } from "../auth/redirects";
import { emitEvent } from "../../services/webhooks";
import { sendEmail } from "../../services/mail";
import { createOrganizationInvitation } from "../../services/orgs";
import { normalizeEmail } from "../../services/org-domains";
import { PERMISSIONS, assertOrganizationRole } from "../../services/rbac";
import { invitationUrl, listParams, orgAccess, page, sortRows } from "../orgs/shared";
import { serializeOrganizationInvitation } from "../orgs/serializers";
import { first } from "../../lib/db";
import { dedupeRecipients, emailList } from "./shared";

export function registerInvitationRoutes(app: Hono, ctx: AppContext) {
  // ─────────── invitations ───────────
  app.get("/organizations/:id/invitations", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const params = listParams(c);
    const status = c.req.query("status");
    const rows = (await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.organizationId, org.id)));
    let serialized = await Promise.all(rows.map((row) => serializeOrganizationInvitation(ctx, row)));
    if (status) serialized = serialized.filter((r) => r.status === status);
    if (params.query) serialized = serialized.filter((r) => r.email_address.includes(params.query!));
    serialized = sortRows(serialized, params.orderBy ?? "-created_at", {
      created_at: (r) => r.created_at, updated_at: (r) => r.updated_at, email_address: (r) => r.email_address,
    });
    if (params.paginated) {
      const { items, total } = page(serialized, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: serialized });
  });

  app.post("/organizations/:id/invitations", async (c) => {
    const { org, caller } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const body = await parseBody(c, z.object({
      email_address: z.string().optional(),
      email_addresses: emailList.optional(),
      role: z.string().optional(),
      redirect_url: z.string().optional(),
      expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
    }));
    const bulk = body.email_addresses !== undefined;
    const emails = (body.email_addresses ?? (body.email_address ? [body.email_address] : [])).map(normalizeEmail);
    if (!emails.length) throw new OrbitError(422, ErrorCodes.form_param_missing, "email_address or email_addresses is required", { param_name: "email_address" });
    if (body.role) await assertOrganizationRole(ctx, body.role);
    // Members and already-invited mailboxes are skipped so bulk calls stay idempotent.
    const recipients = await dedupeRecipients(ctx, org, emails);
    if (!bulk && !recipients.length) throw new OrbitError(409, ErrorCodes.duplicate_record, `${emails[0]} is already a member or has already been invited`);
    const inviter = [caller.user.firstName, caller.user.lastName].filter(Boolean).join(" ") || caller.user.username || caller.user.id;
    const created = [];
    for (const email of recipients) {
      const { invitation, ticket } = await createOrganizationInvitation(ctx, {
        organization: org,
        email,
        roleKey: body.role,
        inviterUserId: caller.userId,
        redirectUrl: validateRedirectUrl(ctx, body.redirect_url),
        expiresAt: body.expires_in_days ? Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000 : null,
      });
      await sendEmail(ctx, {
        to: email,
        template: "organization_invitation",
        vars: {
          organization_name: org.name,
          organization_slug: org.slug ?? "",
          inviter_name: inviter,
          email_address: email,
          role: invitation.roleKey,
          invitation_url: invitationUrl(ctx, ticket),
          expires_in_days: body.expires_in_days ?? 30,
        },
      });
      created.push(await serializeOrganizationInvitation(ctx, invitation));
    }
    return c.json({ response: bulk ? created : created[0] });
  });

  app.post("/organizations/:id/invitations/:invId/revoke", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const invitation = first(await ctx.db
          .select()
          .from(s.organizationInvitations)
          .where(and(eq(s.organizationInvitations.organizationId, org.id), eq(s.organizationInvitations.id, c.req.param("invId")))));
    if (!invitation) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
    const now = Date.now();
    const revoked = first(await ctx.db.update(s.organizationInvitations).set({ status: "revoked", updatedAt: now })
      .where(and(eq(s.organizationInvitations.id, invitation.id), eq(s.organizationInvitations.status, "pending")))
      .returning());
    if (!revoked) throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${invitation.status}`);
    await emitEvent(ctx, "organizationInvitation.revoked", await serializeOrganizationInvitation(ctx, revoked, { backend: true }));
    return c.json({ response: await serializeOrganizationInvitation(ctx, revoked) });
  });
}
