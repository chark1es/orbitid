// Backend API instance invitations (`/v1/invitations`).
import { Hono } from "hono";
import { and, eq, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { serializeInvitation, pendingInvitationFor } from "../../services/restrictions";
import { emitEvent } from "../../services/webhooks";
import { audit } from "../../services/audit";
import { sendEmail, type EmailTemplate } from "../../services/mail";
import type { AppContext } from "../../context";
import { bool, listParams, metadataSchema, normalizeEmail, page, parseOrderBy, ticketUrl } from "./shared";
import { first } from "../../lib/db";

const INVITATION_TTL_DAYS = 30;

export interface CreateInvitationInput {
  email: string;
  publicMetadata?: Record<string, unknown>;
  redirectUrl?: string | null;
  notify?: boolean;
  ignoreExisting?: boolean;
  expiresInDays?: number;
  /** Email template used for the notification (waitlist invites use `waitlist_invited`). */
  emailTemplate?: EmailTemplate;
}

export interface CreatedInvitation { row: typeof s.invitations.$inferSelect; url: string }

/** Creates an instance invitation (also used by waitlist invites and allowlist notifications). */
export async function createInvitation(ctx: AppContext, input: CreateInvitationInput): Promise<CreatedInvitation> {
  const email = normalizeEmail(input.email);
  if (!input.ignoreExisting && await pendingInvitationFor(ctx, email)) {
    throw new OrbitError(422, ErrorCodes.duplicate_record, `There is already a pending invitation for ${email}.`, { param_name: "email_address" });
  }
  const ticket = randomToken(32);
  const now = Date.now();
  const row = first(await ctx.db
      .insert(s.invitations)
      .values({
        id: newId(ID_PREFIX.appInvitation),
        email,
        status: "pending",
        tokenHash: sha256(ticket),
        redirectUrl: input.redirectUrl ?? null,
        publicMetadata: input.publicMetadata ?? {},
        expiresAt: now + (input.expiresInDays ?? INVITATION_TTL_DAYS) * 86_400_000,
        createdAt: now,
        updatedAt: now,
      })
      .returning())!;
  const signUpUrl = ticketUrl(ctx, "/sign-up", ticket);
  const url = row.redirectUrl ? `${signUpUrl}&redirect_url=${encodeURIComponent(row.redirectUrl)}` : signUpUrl;

  await emitEvent(ctx, "invitation.created", { ...serializeInvitation(row), url });
  if (input.notify !== false) {
    try {
      await sendEmail(ctx, {
        to: email,
        template: input.emailTemplate ?? "invitation",
        vars: { invitation_url: url, app_name: ctx.settings.get().application.name },
      });
    } catch (err) {
      // Email delivery problems must not fail the API call (the dashboard can copy the link instead).
      console.error("[invitations] failed to send invitation email", err);
    }
  }
  await audit(ctx, { actor: "secret_key", action: "invitation.created", targetType: "invitation", targetId: row.id, metadata: { email_address: email } });
  return { row, url };
}

const createInvitationSchema = z.object({
  email_address: z.string().email(),
  public_metadata: metadataSchema.optional(),
  redirect_url: z.string().url().optional(),
  notify: bool.default(true),
  ignore_existing: bool.default(false),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});

const bulkInvitationSchema = z.object({
  email_addresses: z.array(z.string().email()).min(1).max(100),
  public_metadata: metadataSchema.optional(),
  redirect_url: z.string().url().optional(),
  notify: bool.default(true),
  ignore_existing: bool.default(true),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});

const INVITATION_ORDER_COLUMNS = { created_at: s.invitations.createdAt, updated_at: s.invitations.updatedAt, email: s.invitations.email };

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/invitations", async (c) => {
    const { limit, offset, order_by } = listParams(c);
    const conds: SQL[] = [];
    const status = c.req.query("status") ?? c.req.query("status[]");
    if (status) conds.push(eq(s.invitations.status, status));
    const query = c.req.query("query")?.trim();
    if (query) conds.push(like(s.invitations.email, `%${query}%`));
    const where = conds.length ? and(...conds) : undefined;
    const rows = (await ctx.db
          .select()
          .from(s.invitations)
          .where(where)
          .orderBy(parseOrderBy(order_by, INVITATION_ORDER_COLUMNS, "-created_at"))
          .limit(limit)
          .offset(offset));
    const total = Number(first(await ctx.db.select({ n: sql<number>`count(*)` }).from(s.invitations).where(where))?.n ?? 0);
    return c.json(page(rows.map((row) => serializeInvitation(row)), total));
  });

  app.get("/invitations/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.invitations).where(eq(s.invitations.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Invitation not found.");
    return c.json(serializeInvitation(row));
  });

  app.post("/invitations", async (c) => {
    const body = await parseBody(c, createInvitationSchema);
    const { row, url } = await createInvitation(ctx, {
      email: body.email_address,
      publicMetadata: body.public_metadata,
      redirectUrl: body.redirect_url,
      notify: body.notify,
      ignoreExisting: body.ignore_existing,
      expiresInDays: body.expires_in_days,
    });
    return c.json({ ...serializeInvitation(row), url });
  });

  app.post("/invitations/bulk", async (c) => {
    const body = await parseBody(c, bulkInvitationSchema);
    const created = [];
    for (const email of body.email_addresses) {
      // Bulk invites are for people who have not been invited yet; skip the rest instead of minting duplicates.
      if (body.ignore_existing && await pendingInvitationFor(ctx, normalizeEmail(email))) continue;
      try {
        const { row, url } = await createInvitation(ctx, {
          email,
          publicMetadata: body.public_metadata,
          redirectUrl: body.redirect_url,
          notify: body.notify,
          ignoreExisting: body.ignore_existing,
          expiresInDays: body.expires_in_days,
        });
        created.push({ ...serializeInvitation(row), url });
      } catch (err) {
        if (!(err instanceof OrbitError && err.code === ErrorCodes.duplicate_record)) throw err;
      }
    }
    return c.json(created);
  });

  app.post("/invitations/:id/revoke", async (c) => {
    const row = first(await ctx.db.select().from(s.invitations).where(eq(s.invitations.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Invitation not found.");
    await ctx.db.update(s.invitations).set({ status: "revoked", updatedAt: Date.now() }).where(eq(s.invitations.id, row.id));
    const updated = first(await ctx.db.select().from(s.invitations).where(eq(s.invitations.id, row.id)))!;
    await emitEvent(ctx, "invitation.revoked", serializeInvitation(updated));
    await audit(ctx, { actor: "secret_key", action: "invitation.revoked", targetType: "invitation", targetId: row.id, metadata: { email_address: row.email } });
    return c.json(serializeInvitation(updated));
  });

  return app;
}
