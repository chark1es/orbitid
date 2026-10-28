// Backend API identifiers: email addresses, phone numbers, allowlist & blocklist.
import { Hono } from "hono";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { serializeEmail, serializePhone, serializeUser } from "../../serializers";
import { emitEvent } from "../../services/webhooks";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { bool, deleted, getUserOrThrow, listParams, metadataSchema, normalizeEmail, page } from "./shared";
import { createInvitation } from "./invitations";

/** `email_address` / `phone_number` / `web3_wallet`, inferred from the identifier shape. */
function identifierType(identifier: string): "email_address" | "phone_number" | "web3_wallet" {
  if (identifier.includes("@")) return "email_address";
  if (/^\+?[0-9][0-9\s()-]{6,}$/.test(identifier)) return "phone_number";
  return "web3_wallet";
}

/** Bumps `updated_at` and emits `user.updated` after an identifier change. */
async function touchUser(ctx: AppContext, userId: string): Promise<void> {
  ctx.db.update(s.users).set({ updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
  const user = ctx.db.select().from(s.users).where(eq(s.users.id, userId)).get();
  if (user) await emitEvent(ctx, "user.updated", serializeUser(ctx, user, { backend: true }));
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  // ───────────── email addresses ─────────────
  app.get("/email_addresses", (c) => {
    const { limit, offset } = listParams(c);
    const conds: SQL[] = [];
    const userId = c.req.query("user_id");
    if (userId) conds.push(eq(s.emailAddresses.userId, userId));
    const email = c.req.query("email_address");
    if (email) conds.push(eq(s.emailAddresses.email, normalizeEmail(email)));
    const where = conds.length ? and(...conds) : undefined;
    const rows = ctx.db.select().from(s.emailAddresses).where(where).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.emailAddresses).where(where).get()?.n ?? 0);
    return c.json(page(rows.map(serializeEmail), total));
  });

  app.get("/email_addresses/:id", (c) => {
    const row = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found.");
    return c.json(serializeEmail(row));
  });

  app.post("/email_addresses", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        user_id: z.string(),
        email_address: z.string().email(),
        verified: bool.default(true),
        primary: bool.default(false),
      }),
    );
    const user = getUserOrThrow(ctx, body.user_id);
    const email = normalizeEmail(body.email_address);
    const existing = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, email)).get();
    if (existing) {
      const code = existing.userId === user.id ? ErrorCodes.duplicate_record : ErrorCodes.form_identifier_exists;
      throw new OrbitError(422, code, `${email} is already in use.`, { param_name: "email_address" });
    }
    const now = Date.now();
    const row = ctx.db
      .insert(s.emailAddresses)
      .values({
        id: newId(ID_PREFIX.email),
        userId: user.id,
        email,
        verified: body.verified,
        verifiedAt: body.verified ? now : null,
        verifiedStrategy: body.verified ? "email_code" : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!;
    if (body.primary || !user.primaryEmailAddressId) {
      ctx.db.update(s.users).set({ primaryEmailAddressId: row.id, updatedAt: now }).where(eq(s.users.id, user.id)).run();
    }
    await touchUser(ctx, user.id);
    audit(ctx, { actor: "secret_key", action: "email_address.created", targetType: "email_address", targetId: row.id, metadata: { user_id: user.id, email_address: email } });
    return c.json(serializeEmail(row));
  });

  app.patch("/email_addresses/:id", async (c) => {
    const row = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found.");
    const body = await parseBody(c, z.object({ verified: bool.optional(), primary: bool.optional() }));
    if (body.verified) {
      const clash = ctx.db
        .select()
        .from(s.emailAddresses)
        .where(and(eq(s.emailAddresses.email, row.email), eq(s.emailAddresses.verified, true)))
        .get();
      if (clash && clash.id !== row.id) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, `${row.email} is already verified on another account.`, { param_name: "email_address" });
      }
    }
    const now = Date.now();
    const patch: Partial<typeof s.emailAddresses.$inferInsert> = { updatedAt: now };
    if (body.verified !== undefined) {
      patch.verified = body.verified;
      patch.verifiedAt = body.verified ? now : null;
      patch.verifiedStrategy = body.verified ? (row.verifiedStrategy ?? "email_code") : null;
    }
    ctx.db.update(s.emailAddresses).set(patch).where(eq(s.emailAddresses.id, row.id)).run();
    if (body.primary) {
      ctx.db.update(s.users).set({ primaryEmailAddressId: row.id, updatedAt: now }).where(eq(s.users.id, row.userId!)).run();
    }
    await touchUser(ctx, row.userId!);
    const updated = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, row.id)).get()!;
    return c.json(serializeEmail(updated));
  });

  app.delete("/email_addresses/:id", async (c) => {
    const row = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found.");
    const user = row.userId ? ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)).get() : undefined;
    ctx.db.delete(s.emailAddresses).where(eq(s.emailAddresses.id, row.id)).run();
    if (user?.primaryEmailAddressId === row.id) {
      ctx.db.update(s.users).set({ primaryEmailAddressId: null, updatedAt: Date.now() }).where(eq(s.users.id, user.id)).run();
    }
    if (row.userId) await touchUser(ctx, row.userId);
    audit(ctx, { actor: "secret_key", action: "email_address.deleted", targetType: "email_address", targetId: row.id, metadata: { email_address: row.email } });
    return c.json(deleted("email_address", row.id));
  });

  // ───────────── phone numbers ─────────────
  app.get("/phone_numbers", (c) => {
    const { limit, offset } = listParams(c);
    const conds: SQL[] = [];
    const userId = c.req.query("user_id");
    if (userId) conds.push(eq(s.phoneNumbers.userId, userId));
    const phone = c.req.query("phone_number");
    if (phone) conds.push(eq(s.phoneNumbers.phone, phone.trim()));
    const where = conds.length ? and(...conds) : undefined;
    const rows = ctx.db.select().from(s.phoneNumbers).where(where).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.phoneNumbers).where(where).get()?.n ?? 0);
    return c.json(page(rows.map(serializePhone), total));
  });

  app.get("/phone_numbers/:id", (c) => {
    const row = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found.");
    return c.json(serializePhone(row));
  });

  app.post("/phone_numbers", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        user_id: z.string(),
        phone_number: z.string(),
        verified: bool.default(true),
        primary: bool.default(false),
        reserved_for_second_factor: bool.default(false),
        default_second_factor: bool.default(false),
      }),
    );
    const user = getUserOrThrow(ctx, body.user_id);
    const phone = body.phone_number.trim();
    const existing = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)).get();
    if (existing) {
      const code = existing.userId === user.id ? ErrorCodes.duplicate_record : ErrorCodes.form_identifier_exists;
      throw new OrbitError(422, code, `${phone} is already in use.`, { param_name: "phone_number" });
    }
    const now = Date.now();
    const row = ctx.db
      .insert(s.phoneNumbers)
      .values({
        id: newId(ID_PREFIX.phone),
        userId: user.id,
        phone,
        verified: body.verified,
        verifiedAt: body.verified ? now : null,
        reservedForSecondFactor: body.reserved_for_second_factor || body.default_second_factor,
        defaultSecondFactor: body.default_second_factor,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!;
    if (body.primary || !user.primaryPhoneNumberId) {
      ctx.db.update(s.users).set({ primaryPhoneNumberId: row.id, updatedAt: now }).where(eq(s.users.id, user.id)).run();
    }
    await touchUser(ctx, user.id);
    audit(ctx, { actor: "secret_key", action: "phone_number.created", targetType: "phone_number", targetId: row.id, metadata: { user_id: user.id, phone_number: phone } });
    return c.json(serializePhone(row));
  });

  app.patch("/phone_numbers/:id", async (c) => {
    const row = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found.");
    const body = await parseBody(
      c,
      z.object({
        verified: bool.optional(),
        primary: bool.optional(),
        reserved_for_second_factor: bool.optional(),
        default_second_factor: bool.optional(),
      }),
    );
    const now = Date.now();
    const patch: Partial<typeof s.phoneNumbers.$inferInsert> = { updatedAt: now };
    if (body.verified !== undefined) {
      patch.verified = body.verified;
      patch.verifiedAt = body.verified ? now : null;
    }
    if (body.reserved_for_second_factor !== undefined) patch.reservedForSecondFactor = body.reserved_for_second_factor;
    if (body.default_second_factor !== undefined) {
      patch.defaultSecondFactor = body.default_second_factor;
      if (body.default_second_factor) patch.reservedForSecondFactor = true;
    }
    ctx.db.update(s.phoneNumbers).set(patch).where(eq(s.phoneNumbers.id, row.id)).run();
    if (body.default_second_factor) {
      ctx.db.update(s.phoneNumbers).set({ defaultSecondFactor: false }).where(and(eq(s.phoneNumbers.userId, row.userId!), sql`${s.phoneNumbers.id} != ${row.id}`)).run();
    }
    if (body.primary) {
      ctx.db.update(s.users).set({ primaryPhoneNumberId: row.id, updatedAt: now }).where(eq(s.users.id, row.userId!)).run();
    }
    await touchUser(ctx, row.userId!);
    const updated = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, row.id)).get()!;
    return c.json(serializePhone(updated));
  });

  app.delete("/phone_numbers/:id", async (c) => {
    const row = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found.");
    const user = row.userId ? ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)).get() : undefined;
    ctx.db.delete(s.phoneNumbers).where(eq(s.phoneNumbers.id, row.id)).run();
    if (user?.primaryPhoneNumberId === row.id) {
      ctx.db.update(s.users).set({ primaryPhoneNumberId: null, updatedAt: Date.now() }).where(eq(s.users.id, user.id)).run();
    }
    if (row.userId) await touchUser(ctx, row.userId);
    audit(ctx, { actor: "secret_key", action: "phone_number.deleted", targetType: "phone_number", targetId: row.id, metadata: { phone_number: row.phone } });
    return c.json(deleted("phone_number", row.id));
  });

  // ───────────── allowlist ─────────────
  app.get("/allowlist_identifiers", (c) => {
    const { limit, offset } = listParams(c);
    const rows = ctx.db.select().from(s.allowlistIdentifiers).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.allowlistIdentifiers).get()?.n ?? 0);
    return c.json(page(rows.map(serializeAllowlist), total));
  });

  app.post("/allowlist_identifiers", async (c) => {
    const body = await parseBody(
      c,
      z.object({ identifier: z.string().min(1), notify: bool.default(false), public_metadata: metadataSchema.optional() }),
    );
    const identifier = body.identifier.trim().toLowerCase();
    if (ctx.db.select().from(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.identifier, identifier)).get()) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "This identifier is already allowlisted.", { param_name: "identifier" });
    }
    const type = identifierType(identifier);
    // Adding an entry turns the list on; the settings toggle remains the way to switch it off.
    if (!ctx.settings.get().restrictions.allowlistEnabled) await ctx.settings.update({ restrictions: { allowlistEnabled: true } });
    const now = Date.now();
    let invitationId: string | null = null;
    if (body.notify && type === "email_address") {
      const { row } = await createInvitation(ctx, { email: identifier, publicMetadata: body.public_metadata, notify: true, ignoreExisting: true });
      invitationId = row.id;
    }
    const row = ctx.db
      .insert(s.allowlistIdentifiers)
      .values({ id: newId(ID_PREFIX.allow), identifier, identifierType: type, invitationId, createdAt: now, updatedAt: now })
      .returning()
      .get()!;
    audit(ctx, { actor: "secret_key", action: "allowlist_identifier.created", targetType: "allowlist_identifier", targetId: row.id, metadata: { identifier } });
    return c.json(serializeAllowlist(row));
  });

  app.delete("/allowlist_identifiers/:id", (c) => {
    const row = ctx.db.select().from(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Allowlist identifier not found.");
    ctx.db.delete(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.id, row.id)).run();
    audit(ctx, { actor: "secret_key", action: "allowlist_identifier.deleted", targetType: "allowlist_identifier", targetId: row.id, metadata: { identifier: row.identifier } });
    return c.json(deleted("allowlist_identifier", row.id));
  });

  // ───────────── blocklist ─────────────
  app.get("/blocklist_identifiers", (c) => {
    const { limit, offset } = listParams(c);
    const rows = ctx.db.select().from(s.blocklistIdentifiers).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.blocklistIdentifiers).get()?.n ?? 0);
    return c.json(page(rows.map(serializeBlocklist), total));
  });

  app.post("/blocklist_identifiers", async (c) => {
    const body = await parseBody(c, z.object({ identifier: z.string().min(1) }));
    const identifier = body.identifier.trim().toLowerCase();
    if (ctx.db.select().from(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.identifier, identifier)).get()) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "This identifier is already blocklisted.", { param_name: "identifier" });
    }
    if (!ctx.settings.get().restrictions.blocklistEnabled) await ctx.settings.update({ restrictions: { blocklistEnabled: true } });
    const row = ctx.db
      .insert(s.blocklistIdentifiers)
      .values({ id: newId(ID_PREFIX.block), identifier, identifierType: identifierType(identifier), createdAt: Date.now(), updatedAt: Date.now() })
      .returning()
      .get()!;
    audit(ctx, { actor: "secret_key", action: "blocklist_identifier.created", targetType: "blocklist_identifier", targetId: row.id, metadata: { identifier } });
    return c.json(serializeBlocklist(row));
  });

  app.delete("/blocklist_identifiers/:id", (c) => {
    const row = ctx.db.select().from(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.id, c.req.param("id"))).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Blocklist identifier not found.");
    ctx.db.delete(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.id, row.id)).run();
    audit(ctx, { actor: "secret_key", action: "blocklist_identifier.deleted", targetType: "blocklist_identifier", targetId: row.id, metadata: { identifier: row.identifier } });
    return c.json(deleted("blocklist_identifier", row.id));
  });

  return app;
}

function serializeAllowlist(row: typeof s.allowlistIdentifiers.$inferSelect) {
  return {
    object: "allowlist_identifier" as const,
    id: row.id,
    identifier: row.identifier,
    identifier_type: row.identifierType as "email_address" | "phone_number" | "web3_wallet",
    invitation_id: row.invitationId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serializeBlocklist(row: typeof s.blocklistIdentifiers.$inferSelect) {
  return {
    object: "blocklist_identifier" as const,
    id: row.id,
    identifier: row.identifier,
    identifier_type: row.identifierType as "email_address" | "phone_number" | "web3_wallet",
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}
