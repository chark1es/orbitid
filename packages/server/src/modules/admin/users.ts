// OWNER: worker "admin" (W3). Backend API users: CRUD, filters, metadata, ban/lock, MFA, identifiers, impersonation.
import { Hono, type Context } from "hono";
import { and, eq, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { authenticator } from "otplib";
import { z } from "zod";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { decrypt, encrypt, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import * as s from "../../db/schema";
import { serializeUser, serializeMembership } from "../../serializers";
import { emitEvent } from "../../services/webhooks";
import { audit } from "../../services/audit";
import { onUserDeleted } from "../../services/orgs";
import type { AppContext } from "../../context";
import { assertPasswordHasher, assertPasswordPolicy, hashPassword, verifyPassword } from "./passwords";
import {
  bool, deleted, getUserOrThrow, listParams, mergeMetadata, metadataSchema, normalizeEmail, page, parseOrderBy, queryValues,
} from "./shared";

const AUDIT_ACTOR = "secret_key";
const MAX_PROFILE_IMAGE_BYTES = 512 * 1024;
const emailList = z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(z.string()).max(20).optional());
const phoneList = z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(z.string()).max(20).optional());

const createUserSchema = z.object({
  email_address: emailList,
  phone_number: phoneList,
  username: z.string().min(1).max(64).optional(),
  password: z.string().optional(),
  password_digest: z.string().optional(),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]).optional(),
  skip_password_checks: bool.optional(),
  skip_password_requirement: bool.optional(),
  external_id: z.string().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
  totp_secret: z.string().optional(),
  backup_codes: z.array(z.string()).optional(),
  created_at: z.coerce.number().int().optional(),
  delete_self_enabled: bool.optional(),
  create_organization_enabled: bool.optional(),
  legal_accepted_at: z.coerce.number().int().nullable().optional(),
});

const updateUserSchema = z.object({
  external_id: z.string().nullable().optional(),
  username: z.string().min(1).max(64).nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  primary_email_address_id: z.string().nullable().optional(),
  primary_phone_number_id: z.string().nullable().optional(),
  password: z.string().optional(),
  password_digest: z.string().optional(),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]).optional(),
  skip_password_checks: bool.optional(),
  sign_out_of_other_sessions: bool.optional(),
  totp_secret: z.string().nullable().optional(),
  backup_codes: z.array(z.string()).nullable().optional(),
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
  delete_self_enabled: bool.optional(),
  create_organization_enabled: bool.optional(),
  create_organizations_limit: z.coerce.number().int().nullable().optional(),
  legal_accepted_at: z.coerce.number().int().nullable().optional(),
});

const metadataPatchSchema = z.object({
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
});

/** Applies `query`, array filters, `banned`, `last_active_at_since` and date bounds. Array filters are intersected. */
function userWhere(ctx: AppContext, c: Context): SQL | undefined {
  const conds: SQL[] = [];
  const search = c.req.query("query")?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conds.push(
      or(
        like(s.users.id, pattern),
        like(s.users.username, pattern),
        like(s.users.firstName, pattern),
        like(s.users.lastName, pattern),
        sql`(${s.users.firstName} || ' ' || ${s.users.lastName}) LIKE ${pattern}`,
        sql`EXISTS (SELECT 1 FROM email_addresses e WHERE e.user_id = ${s.users.id} AND e.email LIKE ${pattern})`,
        sql`EXISTS (SELECT 1 FROM phone_numbers p WHERE p.user_id = ${s.users.id} AND p.phone LIKE ${pattern})`,
      )!,
    );
  }

  const allowed: { ids: string[] | null } = { ids: null };
  const restrictTo = (ids: string[]) => {
    if (allowed.ids === null) allowed.ids = ids;
    else {
      const keep = new Set(ids);
      allowed.ids = allowed.ids.filter((id) => keep.has(id));
    }
  };

  const emails = queryValues(c, "email_address").map(normalizeEmail);
  if (emails.length) {
    restrictTo(ctx.db.select({ id: s.emailAddresses.userId }).from(s.emailAddresses).where(inArray(s.emailAddresses.email, emails)).all().flatMap((r) => (r.id ? [r.id] : [])));
  }
  const phones = queryValues(c, "phone_number");
  if (phones.length) {
    restrictTo(ctx.db.select({ id: s.phoneNumbers.userId }).from(s.phoneNumbers).where(inArray(s.phoneNumbers.phone, phones)).all().flatMap((r) => (r.id ? [r.id] : [])));
  }
  const usernames = queryValues(c, "username").map((u) => u.toLowerCase());
  if (usernames.length) {
    restrictTo(ctx.db.select({ id: s.users.id }).from(s.users).where(inArray(s.users.usernameLower, usernames)).all().map((r) => r.id));
  }
  const externalIds = queryValues(c, "external_id");
  if (externalIds.length) {
    restrictTo(ctx.db.select({ id: s.users.id }).from(s.users).where(inArray(s.users.externalId, externalIds)).all().map((r) => r.id));
  }
  const userIds = queryValues(c, "user_id");
  if (userIds.length) restrictTo(userIds);
  const orgIds = queryValues(c, "organization_id");
  if (orgIds.length) {
    restrictTo(
      ctx.db.select({ id: s.organizationMemberships.userId }).from(s.organizationMemberships).where(inArray(s.organizationMemberships.organizationId, orgIds)).all().map((r) => r.id),
    );
  }
  if (allowed.ids !== null) conds.push(allowed.ids.length ? inArray(s.users.id, allowed.ids) : sql`1 = 0`);

  const banned = c.req.query("banned");
  if (banned === "true" || banned === "false") conds.push(eq(s.users.banned, banned === "true"));
  const locked = c.req.query("locked");
  if (locked === "true" || locked === "false") conds.push(eq(s.users.locked, locked === "true"));
  const activeSince = c.req.query("last_active_at_since");
  if (activeSince) conds.push(gte(s.users.lastActiveAt, Number(activeSince)));
  const createdAfter = c.req.query("created_at_after");
  if (createdAfter) conds.push(gte(s.users.createdAt, Number(createdAfter)));
  const createdBefore = c.req.query("created_at_before");
  if (createdBefore) conds.push(lt(s.users.createdAt, Number(createdBefore)));

  return conds.length ? and(...conds) : undefined;
}

/** Revokes every non-ended session of a user (ban / password change). */
function revokeSessions(ctx: AppContext, userId: string, exceptSessionId?: string): void {
  ctx.db
    .update(s.sessions)
    .set({ status: "revoked", updatedAt: Date.now() })
    .where(and(eq(s.sessions.userId, userId), eq(s.sessions.status, "active"), exceptSessionId ? sql`${s.sessions.id} != ${exceptSessionId}` : undefined))
    .run();
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/users/count", (c) => {
    const total = ctx.db.select({ n: sql<number>`count(*)` }).from(s.users).where(userWhere(ctx, c)).get()?.n ?? 0;
    return c.json({ object: "total_count", total_count: Number(total) });
  });

  app.get("/users", (c) => {
    const where = userWhere(ctx, c);
    const { limit, offset, order_by } = listParams(c);
    const order = parseOrderBy(order_by, USER_ORDER_COLUMNS, "-created_at");
    const rows = ctx.db.select().from(s.users).where(where).orderBy(order).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.users).where(where).get()?.n ?? 0);
    const data = rows.map((row) => serializeUser(ctx, row, { backend: true }));
    if (c.req.query("paginated") === "true") return c.json(page(data, total));
    c.header("x-total-count", String(total));
    return c.json(data);
  });

  app.post("/users", async (c) => {
    const body = await parseBody(c, createUserSchema);
    const settings = ctx.settings.get();
    if (body.password && body.password_digest) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "Provide either password or password_digest, not both.");
    }
    if (body.password_digest && !body.password_hasher) {
      throw new OrbitError(422, ErrorCodes.form_param_missing, "password_hasher is required with password_digest.", { param_name: "password_hasher" });
    }
    if (body.password && !body.skip_password_checks) assertPasswordPolicy(settings, body.password);
    const passwordHash = body.password
      ? await hashPassword(body.password)
      : body.password_digest
        ? (assertPasswordHasher(body.password_hasher!), body.password_digest)
        : null;
    if (!passwordHash && !body.skip_password_requirement && settings.attributes.password.enabled && settings.attributes.password.required) {
      throw new OrbitError(422, ErrorCodes.form_param_missing, "password is required.", { param_name: "password" });
    }

    const username = body.username?.trim() || null;
    if (username && ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())).get()) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This username is already taken.", { param_name: "username" });
    }
    if (body.external_id && ctx.db.select().from(s.users).where(eq(s.users.externalId, body.external_id)).get()) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This external_id is already in use.", { param_name: "external_id" });
    }
    const emails = (body.email_address ?? []).map(normalizeEmail);
    if (new Set(emails).size !== emails.length) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "email_address contains the same address twice.", { param_name: "email_address" });
    }
    for (const email of emails) {
      if (ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, email)).get()) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, `${email} is already in use.`, { param_name: "email_address" });
      }
    }
    const phones = (body.phone_number ?? []).map((p) => p.trim());
    if (new Set(phones).size !== phones.length) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "phone_number contains the same number twice.", { param_name: "phone_number" });
    }

    const now = Date.now();
    const created = body.created_at ?? now;
    const id = newId(ID_PREFIX.user);
    const row = ctx.db
      .insert(s.users)
      .values({
        id,
        externalId: body.external_id ?? null,
        username,
        usernameLower: username ? username.toLowerCase() : null,
        firstName: body.first_name ?? null,
        lastName: body.last_name ?? null,
        passwordHash,
        passwordUpdatedAt: passwordHash ? now : null,
        publicMetadata: body.public_metadata ?? {},
        privateMetadata: body.private_metadata ?? {},
        unsafeMetadata: body.unsafe_metadata ?? {},
        totpSecretEnc: body.totp_secret ? encrypt(ctx.env.encryptionKey, body.totp_secret) : null,
        totpVerified: !!body.totp_secret,
        backupCodes: body.backup_codes ? body.backup_codes.map((code) => sha256(code)) : null,
        deleteSelfEnabled: body.delete_self_enabled ?? true,
        createOrganizationEnabled: body.create_organization_enabled ?? true,
        legalAcceptedAt: body.legal_accepted_at ?? null,
        createdAt: created,
        updatedAt: created,
      })
      .returning()
      .get()!;

    const emailIds = emails.map((email) =>
      ctx.db
        .insert(s.emailAddresses)
        .values({ id: newId(ID_PREFIX.email), userId: id, email, verified: true, verifiedAt: now, verifiedStrategy: "email_code", createdAt: now, updatedAt: now })
        .returning()
        .get()!,
    );
    const phoneIds = phones.map((phone) =>
      ctx.db
        .insert(s.phoneNumbers)
        .values({ id: newId(ID_PREFIX.phone), userId: id, phone, verified: true, verifiedAt: now, createdAt: now, updatedAt: now })
        .returning()
        .get()!,
    );
    if (emailIds[0] || phoneIds[0]) {
      ctx.db
        .update(s.users)
        .set({ primaryEmailAddressId: emailIds[0]?.id ?? null, primaryPhoneNumberId: phoneIds[0]?.id ?? null, updatedAt: now })
        .where(eq(s.users.id, id))
        .run();
    }

    const user = getUserOrThrow(ctx, id);
    const json = serializeUser(ctx, user, { backend: true });
    await emitEvent(ctx, "user.created", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.created", targetType: "user", targetId: id, metadata: { email_addresses: emails, username } });
    return c.json(json);
  });

  app.get("/users/:id", (c) => c.json(serializeUser(ctx, getUserOrThrow(ctx, c.req.param("id")), { backend: true })));

  app.patch("/users/:id", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, updateUserSchema);
    const now = Date.now();
    const patch: Partial<typeof s.users.$inferInsert> = { updatedAt: now };

    if (body.external_id !== undefined) {
      if (body.external_id && ctx.db.select().from(s.users).where(eq(s.users.externalId, body.external_id)).get()?.id !== existing.id) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This external_id is already in use.", { param_name: "external_id" });
      }
      patch.externalId = body.external_id;
    }
    if (body.username !== undefined) {
      const username = body.username?.trim() || null;
      if (username) {
        const taken = ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())).get();
        if (taken && taken.id !== existing.id) throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This username is already taken.", { param_name: "username" });
      }
      patch.username = username;
      patch.usernameLower = username ? username.toLowerCase() : null;
    }
    if (body.first_name !== undefined) patch.firstName = body.first_name;
    if (body.last_name !== undefined) patch.lastName = body.last_name;
    if (body.primary_email_address_id !== undefined) {
      if (body.primary_email_address_id) {
        const email = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, body.primary_email_address_id)).get();
        if (!email || email.userId !== existing.id) {
          throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "primary_email_address_id must reference an email address of this user.", { param_name: "primary_email_address_id" });
        }
      }
      patch.primaryEmailAddressId = body.primary_email_address_id;
    }
    if (body.primary_phone_number_id !== undefined) {
      if (body.primary_phone_number_id) {
        const phone = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, body.primary_phone_number_id)).get();
        if (!phone || phone.userId !== existing.id) {
          throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "primary_phone_number_id must reference a phone number of this user.", { param_name: "primary_phone_number_id" });
        }
      }
      patch.primaryPhoneNumberId = body.primary_phone_number_id;
    }
    if (body.password !== undefined) {
      if (body.password_digest) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "Provide either password or password_digest, not both.");
      if (!body.skip_password_checks) assertPasswordPolicy(ctx.settings.get(), body.password);
      patch.passwordHash = await hashPassword(body.password);
      patch.passwordUpdatedAt = now;
      patch.failedAttempts = 0;
    } else if (body.password_digest !== undefined) {
      if (!body.password_hasher) throw new OrbitError(422, ErrorCodes.form_param_missing, "password_hasher is required with password_digest.", { param_name: "password_hasher" });
      patch.passwordHash = (assertPasswordHasher(body.password_hasher), body.password_digest);
      patch.passwordUpdatedAt = now;
      patch.failedAttempts = 0;
    }
    if (body.totp_secret !== undefined) {
      patch.totpSecretEnc = body.totp_secret ? encrypt(ctx.env.encryptionKey, body.totp_secret) : null;
      patch.totpVerified = !!body.totp_secret;
    }
    if (body.backup_codes !== undefined) patch.backupCodes = body.backup_codes ? body.backup_codes.map((code) => sha256(code)) : null;
    if (body.public_metadata !== undefined) patch.publicMetadata = body.public_metadata;
    if (body.private_metadata !== undefined) patch.privateMetadata = body.private_metadata;
    if (body.unsafe_metadata !== undefined) patch.unsafeMetadata = body.unsafe_metadata;
    if (body.delete_self_enabled !== undefined) patch.deleteSelfEnabled = body.delete_self_enabled;
    if (body.create_organization_enabled !== undefined) patch.createOrganizationEnabled = body.create_organization_enabled;
    if (body.create_organizations_limit !== undefined) patch.createOrganizationsLimit = body.create_organizations_limit;
    if (body.legal_accepted_at !== undefined) patch.legalAcceptedAt = body.legal_accepted_at;

    ctx.db.update(s.users).set(patch).where(eq(s.users.id, existing.id)).run();
    if (body.sign_out_of_other_sessions) revokeSessions(ctx, existing.id);

    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.updated", targetType: "user", targetId: existing.id, metadata: { fields: Object.keys(body) } });
    return c.json(json);
  });

  app.patch("/users/:id/metadata", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, metadataPatchSchema);
    ctx.db
      .update(s.users)
      .set({
        publicMetadata: body.public_metadata ? mergeMetadata(existing.publicMetadata ?? {}, body.public_metadata) : existing.publicMetadata,
        privateMetadata: body.private_metadata ? mergeMetadata(existing.privateMetadata ?? {}, body.private_metadata) : existing.privateMetadata,
        unsafeMetadata: body.unsafe_metadata ? mergeMetadata(existing.unsafeMetadata ?? {}, body.unsafe_metadata) : existing.unsafeMetadata,
        updatedAt: Date.now(),
      })
      .where(eq(s.users.id, existing.id))
      .run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.metadata.updated", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.delete("/users/:id", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const payload = { ...serializeUser(ctx, existing, { backend: true }), deleted: true as const };
    // Runs while the row still exists so membership/org webhook payloads can be serialized.
    await onUserDeleted(ctx, existing.id);
    ctx.db.delete(s.users).where(eq(s.users.id, existing.id)).run();
    await emitEvent(ctx, "user.deleted", payload);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.deleted", targetType: "user", targetId: existing.id });
    return c.json(deleted("user", existing.id));
  });

  app.post("/users/:id/ban", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ banned: true, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    revokeSessions(ctx, existing.id);
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.banned", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/unban", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ banned: false, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.unbanned", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/lock", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ locked: true, lockoutExpiresAt: null, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.locked", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/unlock", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ locked: false, lockoutExpiresAt: null, failedAttempts: 0, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.unlocked", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/verify_password", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({ password: z.string() }));
    if (!(await verifyPassword(existing.passwordHash, body.password))) {
      throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Password is incorrect.", { param_name: "password" });
    }
    return c.json({ object: "user", id: existing.id, verified: true });
  });

  app.post("/users/:id/verify_totp", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({ code: z.string() }));
    if (!existing.totpSecretEnc) throw new OrbitError(422, ErrorCodes.totp_not_enabled, "TOTP is not enabled for this user.");
    const secret = decrypt(ctx.env.encryptionKey, existing.totpSecretEnc);
    if (!authenticator.check(body.code.trim(), secret)) {
      throw new OrbitError(422, ErrorCodes.form_code_incorrect, "The code is incorrect or expired.", { param_name: "code" });
    }
    return c.json({ object: "user", id: existing.id, verified: true });
  });

  app.delete("/users/:id/mfa", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ totpSecretEnc: null, totpVerified: false, backupCodes: null, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    ctx.db.update(s.phoneNumbers).set({ reservedForSecondFactor: false, defaultSecondFactor: false }).where(eq(s.phoneNumbers.userId, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.mfa.reset", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.delete("/users/:id/password", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ passwordHash: null, passwordUpdatedAt: null, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.password.removed", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/profile_image", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    let dataUrl: string;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new OrbitError(422, ErrorCodes.form_param_missing, "file is required.", { param_name: "file" });
      if (file.size > MAX_PROFILE_IMAGE_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Image must be smaller than 512 KB.", { param_name: "file" });
      dataUrl = `data:${file.type || "image/png"};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    } else {
      const body = await parseBody(c, z.object({ file: z.string() }));
      if (!/^(data:image\/[a-z0-9.+-]+;base64,|https?:\/\/)/i.test(body.file)) {
        throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "file must be an image data URL or an http(s) URL.", { param_name: "file" });
      }
      dataUrl = body.file;
    }
    ctx.db.update(s.users).set({ imageUrl: dataUrl, hasImage: true, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.profile_image.updated", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.delete("/users/:id/profile_image", async (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    ctx.db.update(s.users).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.users.id, existing.id)).run();
    const json = serializeUser(ctx, getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    audit(ctx, { actor: AUDIT_ACTOR, action: "user.profile_image.removed", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.get("/users/:id/oauth_access_tokens/:provider", (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const provider = c.req.param("provider");
    const accounts = ctx.db
      .select()
      .from(s.externalAccounts)
      .where(and(eq(s.externalAccounts.userId, existing.id), eq(s.externalAccounts.provider, provider)))
      .all();
    if (!accounts.length) throw new OrbitError(404, ErrorCodes.resource_not_found, "No external account for this provider.");
    return c.json(
      accounts.map((account) => ({
        object: "oauth_access_token",
        external_account_id: account.id,
        provider: account.provider,
        token: account.accessTokenEnc ? decrypt(ctx.env.encryptionKey, account.accessTokenEnc) : null,
        scopes: account.approvedScopes,
        expires_at: account.tokenExpiresAt,
      })),
    );
  });

  app.get("/users/:id/organization_memberships", (c) => {
    const existing = getUserOrThrow(ctx, c.req.param("id"));
    const { limit, offset } = listParams(c);
    const where = eq(s.organizationMemberships.userId, existing.id);
    const rows = ctx.db.select().from(s.organizationMemberships).where(where).limit(limit).offset(offset).all();
    const total = Number(ctx.db.select({ n: sql<number>`count(*)` }).from(s.organizationMemberships).where(where).get()?.n ?? 0);
    return c.json(page(rows.map((row) => serializeMembership(ctx, row, { backend: true })), total));
  });

  return app;
}

const USER_ORDER_COLUMNS = {
  created_at: s.users.createdAt,
  updated_at: s.users.updatedAt,
  last_sign_in_at: s.users.lastSignInAt,
  last_active_at: s.users.lastActiveAt,
  id: s.users.id,
};
