// Backend API identifiers: email addresses, phone numbers, allowlist & blocklist.
//
// Reads are operator-visible; every write to a user's identifiers is refused. An address or number that the
// operator can attach, verify or delete is a sign-in identifier they control (or a factor they can clear), which
// turns the Backend API into "become this user". Identifiers are provisioned with the account (`POST /v1/users`)
// and afterwards belong to the user, who adds, verifies and removes them from their own signed-in session.
import { Hono } from "hono";
import { and, count, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { serializeEmail, serializePhone } from "../../serializers";
import { audit } from "../../services/audit";
import type { AppContext } from "../../context";
import { bool, deleted, getUserOrThrow, listParams, metadataSchema, normalizeEmail, page, refuseUserCredentialMutation } from "./shared";
import { createInvitation } from "./invitations";
import { first } from "../../lib/db";

/** `email_address` / `phone_number` / `web3_wallet`, inferred from the identifier shape. */
function identifierType(identifier: string): "email_address" | "phone_number" | "web3_wallet" {
  if (identifier.includes("@")) return "email_address";
  if (/^\+?[0-9][0-9\s()-]{6,}$/.test(identifier)) return "phone_number";
  return "web3_wallet";
}

const refuseIdentifierWrite = (what: string): never =>
  refuseUserCredentialMutation(what, "the /email_addresses and /phone_numbers routes of the Frontend API (/me)");

export default function routes(ctx: AppContext) {
  const app = new Hono();

  // ───────────── email addresses ─────────────
  app.get("/email_addresses", async (c) => {
    const { limit, offset } = listParams(c);
    const conds: SQL[] = [];
    const userId = c.req.query("user_id");
    if (userId) conds.push(eq(s.emailAddresses.userId, userId));
    const email = c.req.query("email_address");
    if (email) conds.push(eq(s.emailAddresses.email, normalizeEmail(email)));
    const where = conds.length ? and(...conds) : undefined;
    const rows = (await ctx.db.select().from(s.emailAddresses).where(where).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.emailAddresses).where(where))?.n ?? 0);
    return c.json(page(rows.map(serializeEmail), total));
  });

  app.get("/email_addresses/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))));
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
    await getUserOrThrow(ctx, body.user_id);
    refuseIdentifierWrite("attach an email address to an existing user (verified or not)");
  });

  app.patch("/email_addresses/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found.");
    // `verified: true` would claim possession of somebody's mailbox without a code; `primary` would make it the
    // address the sign-in and password-reset flows use. Neither is operator-settable.
    refuseIdentifierWrite("verify, unverify or promote an email address as the primary sign-in identifier");
  });

  app.delete("/email_addresses/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found.");
    refuseIdentifierWrite("delete one of the user's email addresses");
  });

  // ───────────── phone numbers ─────────────
  app.get("/phone_numbers", async (c) => {
    const { limit, offset } = listParams(c);
    const conds: SQL[] = [];
    const userId = c.req.query("user_id");
    if (userId) conds.push(eq(s.phoneNumbers.userId, userId));
    const phone = c.req.query("phone_number");
    if (phone) conds.push(eq(s.phoneNumbers.phone, phone.trim()));
    const where = conds.length ? and(...conds) : undefined;
    const rows = (await ctx.db.select().from(s.phoneNumbers).where(where).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.phoneNumbers).where(where))?.n ?? 0);
    return c.json(page(rows.map(serializePhone), total));
  });

  app.get("/phone_numbers/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))));
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
    await getUserOrThrow(ctx, body.user_id);
    // `default_second_factor: true` on a number the operator owns is exactly "install my second factor on their
    // account"; a verified number also makes phone-code sign-in and password reset deliverable to the operator.
    refuseIdentifierWrite("attach a phone number to an existing user, including as a second factor");
  });

  app.patch("/phone_numbers/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found.");
    refuseIdentifierWrite("verify, promote or turn a phone number into the user's second factor");
  });

  app.delete("/phone_numbers/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found.");
    refuseIdentifierWrite("delete one of the user's phone numbers");
  });

  // ───────────── allowlist ─────────────
  app.get("/allowlist_identifiers", async (c) => {
    const { limit, offset } = listParams(c);
    const rows = (await ctx.db.select().from(s.allowlistIdentifiers).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.allowlistIdentifiers))?.n ?? 0);
    return c.json(page(rows.map(serializeAllowlist), total));
  });

  app.post("/allowlist_identifiers", async (c) => {
    const body = await parseBody(
      c,
      z.object({ identifier: z.string().min(1), notify: bool.default(false), public_metadata: metadataSchema.optional() }),
    );
    const identifier = body.identifier.trim().toLowerCase();
    if (first(await ctx.db.select().from(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.identifier, identifier)))) {
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
    const row = first(await ctx.db
          .insert(s.allowlistIdentifiers)
          .values({ id: newId(ID_PREFIX.allow), identifier, identifierType: type, invitationId, createdAt: now, updatedAt: now })
          .returning())!;
    await audit(ctx, { actor: "secret_key", action: "allowlist_identifier.created", targetType: "allowlist_identifier", targetId: row.id, metadata: { identifier } });
    return c.json(serializeAllowlist(row));
  });

  app.delete("/allowlist_identifiers/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Allowlist identifier not found.");
    await ctx.db.delete(s.allowlistIdentifiers).where(eq(s.allowlistIdentifiers.id, row.id));
    await audit(ctx, { actor: "secret_key", action: "allowlist_identifier.deleted", targetType: "allowlist_identifier", targetId: row.id, metadata: { identifier: row.identifier } });
    return c.json(deleted("allowlist_identifier", row.id));
  });

  // ───────────── blocklist ─────────────
  app.get("/blocklist_identifiers", async (c) => {
    const { limit, offset } = listParams(c);
    const rows = (await ctx.db.select().from(s.blocklistIdentifiers).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.blocklistIdentifiers))?.n ?? 0);
    return c.json(page(rows.map(serializeBlocklist), total));
  });

  app.post("/blocklist_identifiers", async (c) => {
    const body = await parseBody(c, z.object({ identifier: z.string().min(1) }));
    const identifier = body.identifier.trim().toLowerCase();
    if (first(await ctx.db.select().from(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.identifier, identifier)))) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "This identifier is already blocklisted.", { param_name: "identifier" });
    }
    if (!ctx.settings.get().restrictions.blocklistEnabled) await ctx.settings.update({ restrictions: { blocklistEnabled: true } });
    const row = first(await ctx.db
          .insert(s.blocklistIdentifiers)
          .values({ id: newId(ID_PREFIX.block), identifier, identifierType: identifierType(identifier), createdAt: Date.now(), updatedAt: Date.now() })
          .returning())!;
    await audit(ctx, { actor: "secret_key", action: "blocklist_identifier.created", targetType: "blocklist_identifier", targetId: row.id, metadata: { identifier } });
    return c.json(serializeBlocklist(row));
  });

  app.delete("/blocklist_identifiers/:id", async (c) => {
    const row = first(await ctx.db.select().from(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.id, c.req.param("id"))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Blocklist identifier not found.");
    await ctx.db.delete(s.blocklistIdentifiers).where(eq(s.blocklistIdentifiers.id, row.id));
    await audit(ctx, { actor: "secret_key", action: "blocklist_identifier.deleted", targetType: "blocklist_identifier", targetId: row.id, metadata: { identifier: row.identifier } });
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
