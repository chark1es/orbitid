// Backend API waitlist management (`/v1/waitlist_entries`).
import { Hono } from "hono";
import { and, eq, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError, type WaitlistEntryJSON } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { serializeInvitation } from "../../services/restrictions";
import { emitEvent } from "../../services/webhooks";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { deleted, listParams, normalizeEmail, page, parseOrderBy } from "./shared";
import { createInvitation } from "./invitations";
import { first } from "../../lib/db";

type WaitlistRow = typeof s.waitlistEntries.$inferSelect;

const WAITLIST_ORDER_COLUMNS = { created_at: s.waitlistEntries.createdAt, updated_at: s.waitlistEntries.updatedAt, email: s.waitlistEntries.email };

export async function serializeWaitlistEntry(ctx: AppContext, row: WaitlistRow): Promise<WaitlistEntryJSON> {
  const invitation = row.invitationId ? first(await ctx.db.select().from(s.invitations).where(eq(s.invitations.id, row.invitationId))) : undefined;
  return {
    object: "waitlist_entry",
    id: row.id,
    email_address: row.email,
    status: row.status as WaitlistEntryJSON["status"],
    invitation: invitation ? serializeInvitation(invitation) : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export async function waitlistEntryOrThrow(ctx: AppContext, id: string): Promise<WaitlistRow> {
  const row = first(await ctx.db.select().from(s.waitlistEntries).where(eq(s.waitlistEntries.id, id)));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Waitlist entry not found.");
  return row;
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/waitlist_entries", async (c) => {
    const { limit, offset, order_by } = listParams(c);
    const conds: SQL[] = [];
    const status = c.req.query("status");
    if (status) conds.push(eq(s.waitlistEntries.status, status));
    const query = c.req.query("query")?.trim();
    if (query) conds.push(like(s.waitlistEntries.email, `%${query}%`));
    const where = conds.length ? and(...conds) : undefined;
    const rows = (await ctx.db
          .select()
          .from(s.waitlistEntries)
          .where(where)
          .orderBy(parseOrderBy(order_by, WAITLIST_ORDER_COLUMNS, "-created_at"))
          .limit(limit)
          .offset(offset));
    const total = Number(first(await ctx.db.select({ n: sql<number>`count(*)` }).from(s.waitlistEntries).where(where))?.n ?? 0);
    return c.json(page((await Promise.all(rows.map((row) => serializeWaitlistEntry(ctx, row)))), total));
  });

  app.post("/waitlist_entries", async (c) => {
    const body = await parseBody(c, z.object({ email_address: z.string().email() }));
    const email = normalizeEmail(body.email_address);
    if (first(await ctx.db.select().from(s.waitlistEntries).where(eq(s.waitlistEntries.email, email)))) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "This email address is already on the waitlist.", { param_name: "email_address" });
    }
    const now = Date.now();
    const row = first(await ctx.db
          .insert(s.waitlistEntries)
          .values({ id: newId(ID_PREFIX.waitlist), email, status: "pending", createdAt: now, updatedAt: now })
          .returning())!;
    const json = await serializeWaitlistEntry(ctx, row);
    await emitEvent(ctx, "waitlistEntry.created", json);
    await audit(ctx, { actor: "secret_key", action: "waitlist_entry.created", targetType: "waitlist_entry", targetId: row.id, metadata: { email_address: email } });
    return c.json(json);
  });

  app.post("/waitlist_entries/:id/invite", async (c) => {
    const row = await waitlistEntryOrThrow(ctx, c.req.param("id"));
    if (row.status === "completed") throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "This waitlist entry has already signed up.");
    const { row: invitation, url } = await createInvitation(ctx, {
      email: row.email,
      notify: true,
      ignoreExisting: true,
      emailTemplate: "waitlist_invited",
    });
    await ctx.db.update(s.waitlistEntries).set({ status: "invited", invitationId: invitation.id, updatedAt: Date.now() }).where(eq(s.waitlistEntries.id, row.id));
    const updated = await waitlistEntryOrThrow(ctx, row.id);
    const json = await serializeWaitlistEntry(ctx, updated);
    if (json.invitation) json.invitation.url = url;
    await emitEvent(ctx, "waitlistEntry.updated", json);
    await audit(ctx, { actor: "secret_key", action: "waitlist_entry.invited", targetType: "waitlist_entry", targetId: row.id, metadata: { invitation_id: invitation.id } });
    return c.json(json);
  });

  app.post("/waitlist_entries/:id/reject", async (c) => {
    const row = await waitlistEntryOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.waitlistEntries).set({ status: "rejected", updatedAt: Date.now() }).where(eq(s.waitlistEntries.id, row.id));
    const json = await serializeWaitlistEntry(ctx, await waitlistEntryOrThrow(ctx, row.id));
    await emitEvent(ctx, "waitlistEntry.updated", json);
    await audit(ctx, { actor: "secret_key", action: "waitlist_entry.rejected", targetType: "waitlist_entry", targetId: row.id });
    return c.json(json);
  });

  app.delete("/waitlist_entries/:id", async (c) => {
    const row = await waitlistEntryOrThrow(ctx, c.req.param("id"));
    await ctx.db.delete(s.waitlistEntries).where(eq(s.waitlistEntries.id, row.id));
    await audit(ctx, { actor: "secret_key", action: "waitlist_entry.deleted", targetType: "waitlist_entry", targetId: row.id, metadata: { email_address: row.email } });
    return c.json(deleted("waitlist_entry", row.id));
  });

  return app;
}
