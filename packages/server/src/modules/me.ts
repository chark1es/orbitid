// /v1/client/me (profile, password, emails, phones, external accounts, totp, backup codes, passkeys, sessions, image, delete)
import { Hono, type Context } from "hono";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { decrypt } from "../lib/crypto";
import { MAX_UPLOAD_BYTES, parseBody } from "../lib/http";
import { assertImageBytes, randomImageName } from "../lib/images";
import { hit } from "../lib/rate-limit";
import { serializeEmail, serializeExternalAccount, serializePasskey, serializePhone, serializeSession, serializeUser } from "../serializers";
import { assertPasswordValid, hashPassword, verifyPassword } from "../services/passwords";
import { disableTotp, finishTotpSetup, generateBackupCodes, startTotpSetup, userHasMfa } from "../services/mfa";
import { beginPasskeyRegistration, finishPasskeyRegistration, listPasskeys } from "../services/passkeys";
import { completeMfaEnrollment, endSession, endSessionsForUser } from "../services/sessions";
import { sendEmail, sendSms } from "../services/mail";
import { onUserEmailVerified } from "../services/orgs";
import {
  assertNotLastIdentification, assertUsernameAvailable, countIdentifications, deleteEmailAddress, deletePhoneNumber,
  findEmail, getUserById, isValidEmail, listEmails, listPhones, normalizeEmail, normalizePhone,
  primaryEmail, recordFailedAttempt, resetFailedAttempts, setPrimaryEmail, setPrimaryPhone, type UserRow,
} from "../services/users";
import { deleteUser } from "../services/users";
import { emitEvent } from "../services/webhooks";
import { getOAuthAdapter, isProviderEnabled, providerKeyFromStrategy } from "../services/oauth-providers";
import { relyingParty } from "../services/passkeys";
import { getOrCreateClient, clearClientCookie, requireActiveUser } from "./auth/client-auth";
import { requireReverification } from "./auth/reverification";
import { zBool, zMetadata } from "./auth/forms";
import { checkCode, getVerification, issueVerification } from "./auth/verifications";
import { createOAuthAuthorization } from "./auth/oauth-flow";
import { validateRedirectUrl } from "./auth/redirects";
import { first } from "../lib/db";

const optionalName = z.string().max(256).nullish();
const updateSchema = z.object({
  first_name: optionalName,
  last_name: optionalName,
  username: z.string().max(64).nullish(),
  unsafe_metadata: zMetadata.optional(),
  primary_email_address_id: z.string().max(64).nullish(),
  primary_phone_number_id: z.string().max(64).nullish(),
  legal_accepted: zBool.optional(),
});
const passwordChangeSchema = z.object({ current_password: z.string().max(256), new_password: z.string().max(256), sign_out_of_other_sessions: z.boolean().optional() });
const passwordRemoveSchema = z.object({ current_password: z.string().max(256) });
const emailCreateSchema = z.object({ email_address: z.string().max(320) });
const phoneCreateSchema = z.object({ phone_number: z.string().max(32) });
const phoneUpdateSchema = z.object({ reserved_for_second_factor: zBool.optional(), default_second_factor: zBool.optional() });
const verifyCodeSchema = z.object({ code: z.string().max(64), strategy: z.string().max(64).optional() });
const prepareSchema = z.object({ strategy: z.string().max(64).optional() });
const externalAccountCreateSchema = z.object({
  strategy: z.string().max(64), redirect_url: z.string().max(2048).optional(), additional_scopes: z.array(z.string().max(256)).max(50).optional(),
});
const totpAttemptSchema = z.object({ code: z.string().max(64) });
const passkeyCreateSchema = z.object({ name: z.string().max(128).optional(), authenticator_type: z.enum(["platform", "cross-platform"]).optional() });
const passkeyAttemptSchema = z.object({ public_key_credential: z.unknown(), name: z.string().max(128).optional() });
const passkeyRenameSchema = z.object({ name: z.string().min(1).max(128) });
const MAX_IMAGE_BYTES = MAX_UPLOAD_BYTES;
const imageSchema = z.object({ file: z.string().max(MAX_IMAGE_BYTES) });

export default function routes(ctx: AppContext) {
  const app = new Hono();

  // A pending session (required MFA, no factor yet) may only do what enrolling a factor takes.
  const PENDING_ALLOWED = [
    /^GET \/$/, /^GET \/totp$/, /^POST \/totp$/, /^POST \/totp\/attempt_verification$/,
    /^(GET|POST) \/phone_numbers$/, /^(GET|PATCH) \/phone_numbers\/[^/]+$/, /^POST \/phone_numbers\/[^/]+\/(prepare|attempt)_verification$/,
  ];
  const auth = async (c: Context) => {
    const client = await getOrCreateClient(ctx, c);
    const { session, user } = await requireActiveUser(ctx, client);
    if (session.status === "pending") {
      const route = `${c.req.method} ${new URL(c.req.url).pathname.replace(/^\/v1\/client\/me/, "").replace(/\/+$/, "") || "/"}`;
      if (!PENDING_ALLOWED.some((allowed) => allowed.test(route))) {
        throw new OrbitError(403, ErrorCodes.session_pending, "Finish setting up two-factor authentication before doing anything else");
      }
    }
    return { client, session, user };
  };

  /** Enrolling a factor activates the session that did it (and only that one). */
  const settleEnrollment = async (userId: string, sessionId: string) => {
    if (await userHasMfa(ctx, await reloadUser(userId))) await completeMfaEnrollment(ctx, userId, sessionId);
  };

  const userResponse = async (user: UserRow) => ({ response: await serializeUser(ctx, user) });

  const emitUserUpdated = async (userId: string) => {
    const user = await getUserById(ctx, userId);
    if (user) await emitEvent(ctx, "user.updated", await serializeUser(ctx, user, { backend: true }));
  };

  const reloadUser = async (id: string) => (await getUserById(ctx, id))!;

  // ───────────── profile ─────────────
  app.get("/", async (c) => {
    const { user } = await auth(c);
    return c.json(await userResponse(user));
  });

  app.patch("/", async (c) => {
    const { user } = await auth(c);
    const body = await parseBody(c, updateSchema);
    const patch: Partial<typeof s.users.$inferInsert> = { updatedAt: Date.now() };
    if (body.first_name !== undefined) patch.firstName = body.first_name ?? null;
    if (body.last_name !== undefined) patch.lastName = body.last_name ?? null;
    if (body.username !== undefined) {
      if (body.username !== null && body.username !== "" && !ctx.settings.get().attributes.username.enabled) {
        throw new OrbitError(422, ErrorCodes.form_param_unknown, "Usernames are disabled for this instance", { param_name: "username" });
      }
      if (body.username === null || body.username === "") {
        patch.username = null;
        patch.usernameLower = null;
      } else {
        await assertUsernameAvailable(ctx, body.username, user.id);
        patch.username = body.username;
        patch.usernameLower = body.username.toLowerCase();
      }
    }
    if (body.unsafe_metadata !== undefined) patch.unsafeMetadata = body.unsafe_metadata;
    if (body.legal_accepted) patch.legalAcceptedAt = Date.now();
    if (body.primary_email_address_id) {
      const email = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, body.primary_email_address_id), eq(s.emailAddresses.userId, user.id))));
      if (!email) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
      if (!email.verified) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "The primary email address must be verified", { param_name: "primary_email_address_id" });
      patch.primaryEmailAddressId = email.id;
    }
    if (body.primary_phone_number_id) {
      const phone = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, body.primary_phone_number_id), eq(s.phoneNumbers.userId, user.id))));
      if (!phone) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
      if (!phone.verified) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "The primary phone number must be verified", { param_name: "primary_phone_number_id" });
      patch.primaryPhoneNumberId = phone.id;
    }
    await ctx.db.update(s.users).set(patch).where(eq(s.users.id, user.id));
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });

  app.delete("/", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { client, user } = await auth(c);
    if (!ctx.settings.get().userSettings.deleteSelfEnabled || !user.deleteSelfEnabled) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Account deletion is disabled");
    }
    await deleteUser(ctx, user.id);
    await ctx.db.update(s.clients).set({ lastActiveSessionId: null, updatedAt: Date.now() }).where(eq(s.clients.id, client.id));
    clearClientCookie(c, ctx);
    return c.json({ response: { object: "user", id: user.id, deleted: true } });
  });

  app.post("/profile_image", async (c) => {
    const { user } = await auth(c);
    if (!ctx.settings.get().userSettings.allowProfileImageUpload) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Profile image uploads are disabled");
    }
    const ct = c.req.header("content-type") ?? "";
    let bytes: Buffer;
    if (ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new OrbitError(422, ErrorCodes.form_param_missing, "file is missing", { param_name: "file" });
      if (file.size > MAX_IMAGE_BYTES) throw new OrbitError(413, ErrorCodes.form_param_value_invalid, "Images must be smaller than 5MB", { param_name: "file" });
      bytes = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await parseBody(c, imageSchema);
      const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(body.file.trim());
      bytes = match ? Buffer.from(match[2]!, "base64") : Buffer.from(body.file, "base64");
    }
    if (!bytes.length) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "The uploaded file is empty", { param_name: "file" });
    if (bytes.length > MAX_IMAGE_BYTES) throw new OrbitError(413, ErrorCodes.form_param_value_invalid, "Images must be smaller than 5MB", { param_name: "file" });
    // The bytes decide: declared type and file extension are ignored (SVG and polyglots are refused).
    const kind = assertImageBytes(bytes, "file");
    const dir = resolve(ctx.env.dataDir, "uploads");
    mkdirSync(dir, { recursive: true });
    const name = randomImageName(user.id, kind);
    writeFileSync(resolve(dir, name), bytes);
    await ctx.db.update(s.users).set({
                  imageUrl: `${ctx.env.baseUrl}/v1/client/images/${name}`, hasImage: true, updatedAt: Date.now(),
                }).where(eq(s.users.id, user.id));
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });

  app.delete("/profile_image", async (c) => {
    const { user } = await auth(c);
    await ctx.db.update(s.users).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });

  // ───────────── password ─────────────
  app.post("/change_password", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { session, user } = await auth(c);
    const body = await parseBody(c, passwordChangeSchema);
    if (!user.passwordHash) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account does not have a password");
    if (!(await verifyPassword(user.passwordHash, body.current_password))) {
      await recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Current password is incorrect", { param_name: "current_password" });
    }
    await resetFailedAttempts(ctx, user.id);
    await assertPasswordValid(ctx, body.new_password);
    const passwordHash = await hashPassword(body.new_password);
    await ctx.db.update(s.users).set({ passwordHash, passwordUpdatedAt: Date.now(), updatedAt: Date.now() }).where(eq(s.users.id, user.id));
    const email = await primaryEmail(ctx, user);
    if (email) await sendEmail(ctx, { to: email.email, template: "password_changed", vars: { user_name: user.firstName ?? undefined } });
    const signOut = body.sign_out_of_other_sessions ?? ctx.settings.get().password.signOutOfOtherSessionsOnChange;
    if (signOut) await endSessionsForUser(ctx, user.id, "revoked", session.id);
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });

  app.post("/remove_password", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const body = await parseBody(c, passwordRemoveSchema);
    if (!user.passwordHash) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account does not have a password");
    if (await countIdentifications(ctx, user.id) === 0) {
      throw new OrbitError(422, ErrorCodes.strategy_for_user_invalid, "You cannot remove your only sign-in method");
    }
    if (!(await verifyPassword(user.passwordHash, body.current_password))) {
      await recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Current password is incorrect", { param_name: "current_password" });
    }
    await resetFailedAttempts(ctx, user.id);
    await ctx.db.update(s.users).set({ passwordHash: null, passwordUpdatedAt: null, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });

  // ───────────── email addresses ─────────────
  app.get("/email_addresses", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listEmails(ctx, user.id)).map(serializeEmail) });
  });

  app.post("/email_addresses", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const body = await parseBody(c, emailCreateSchema);
    if (!ctx.settings.get().attributes.emailAddress.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Email addresses are disabled for this instance", { param_name: "email_address" });
    const email = normalizeEmail(body.email_address);
    if (!isValidEmail(email)) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email_address is not valid", { param_name: "email_address" });
    if (await findEmail(ctx, email)) throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use", { param_name: "email_address" });
    const now = Date.now();
    const id = newId("idn_e");
    await ctx.db.insert(s.emailAddresses).values({
                  id, userId: user.id, email, verified: false, createdAt: now, updatedAt: now,
                });
    if (!user.primaryEmailAddressId) await setPrimaryEmail(ctx, user.id, id);
    await emitUserUpdated(user.id);
    const row = first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, id)))!;
    return c.json({ response: serializeEmail(row) });
  });

  app.get("/email_addresses/:id", async (c) => {
    const { user } = await auth(c);
    const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, c.req.param("id")!), eq(s.emailAddresses.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    return c.json({ response: serializeEmail(row) });
  });

  app.delete("/email_addresses/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, id), eq(s.emailAddresses.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    await deleteEmailAddress(ctx, user.id, id);
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "email_address", id, deleted: true } });
  });

  app.post("/email_addresses/:id/prepare_verification", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, id), eq(s.emailAddresses.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    if (row.verified) throw new OrbitError(422, ErrorCodes.verification_already_verified, "That email address is already verified");
    await hit(ctx, `add_email:prepare:${user.id}`, 10, 60_000);
    await parseBody(c, prepareSchema);
    const settings = ctx.settings.get();
    const issued = await issueVerification(ctx, {
          purpose: "add_email", strategy: "email_code", identifier: row.email, ownerId: row.id,
          lifetimeSeconds: settings.email.codeLifetimeSeconds,
        });
    await sendEmail(ctx, { to: row.email, template: "verification_code", vars: { code: issued.code, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60) } });
    return c.json({ response: serializeEmail(row) });
  });

  app.post("/email_addresses/:id/attempt_verification", async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, id), eq(s.emailAddresses.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    const body = await parseBody(c, verifyCodeSchema);
    await hit(ctx, `add_email:attempt:${user.id}`, 20, 60_000);
    const verification = await getVerification(ctx, "add_email", row.id);
    await checkCode(ctx, verification, body.code);
    const duplicate = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.email, row.email), eq(s.emailAddresses.verified, true))));
    if (duplicate && duplicate.id !== row.id) {
      throw new OrbitError(409, ErrorCodes.duplicate_record, "That email address is already verified by another account");
    }
    await ctx.db.update(s.emailAddresses).set({ verified: true, verifiedAt: Date.now(), verifiedStrategy: "email_code", updatedAt: Date.now() }).where(eq(s.emailAddresses.id, row.id));
    await onUserEmailVerified(ctx, user.id, row.email);
    await emitUserUpdated(user.id);
    return c.json({ response: serializeEmail(first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, row.id)))!) });
  });

  // ───────────── phone numbers ─────────────
  app.get("/phone_numbers", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listPhones(ctx, user.id)).map(serializePhone) });
  });

  app.post("/phone_numbers", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const body = await parseBody(c, phoneCreateSchema);
    if (!ctx.settings.get().attributes.phoneNumber.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Phone numbers are disabled for this instance", { param_name: "phone_number" });
    const phone = normalizePhone(body.phone_number);
    if (first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)))) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That phone number is already in use", { param_name: "phone_number" });
    }
    const now = Date.now();
    const id = newId("idn_p");
    await ctx.db.insert(s.phoneNumbers).values({
                  id, userId: user.id, phone, verified: false, createdAt: now, updatedAt: now,
                });
    if (!user.primaryPhoneNumberId) await setPrimaryPhone(ctx, user.id, id);
    await emitUserUpdated(user.id);
    return c.json({ response: serializePhone(first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, id)))!) });
  });

  app.get("/phone_numbers/:id", async (c) => {
    const { user } = await auth(c);
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, c.req.param("id")!), eq(s.phoneNumbers.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    return c.json({ response: serializePhone(row) });
  });

  app.patch("/phone_numbers/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user, session } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, id), eq(s.phoneNumbers.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    const body = await parseBody(c, phoneUpdateSchema);
    if ((body.reserved_for_second_factor || body.default_second_factor) && !ctx.settings.get().attributes.phoneNumber.usedForSecondFactor) {
      throw new OrbitError(422, ErrorCodes.form_param_unknown, "Phone numbers cannot be used as a second factor on this instance", { param_name: "reserved_for_second_factor" });
    }
    const patch: Partial<typeof s.phoneNumbers.$inferInsert> = { updatedAt: Date.now() };
    if (body.reserved_for_second_factor !== undefined) patch.reservedForSecondFactor = body.reserved_for_second_factor;
    if (body.default_second_factor !== undefined) {
      if (body.default_second_factor && !row.verified) throw new OrbitError(422, ErrorCodes.verification_failed, "The default second factor must be verified");
      patch.defaultSecondFactor = body.default_second_factor;
      if (body.default_second_factor) patch.reservedForSecondFactor = true;
      await ctx.db.update(s.phoneNumbers).set({ defaultSecondFactor: false }).where(and(eq(s.phoneNumbers.userId, user.id), ne(s.phoneNumbers.id, id)));
    }
    if (patch.reservedForSecondFactor && !row.verified) throw new OrbitError(422, ErrorCodes.verification_failed, "Only verified phone numbers can be a second factor");
    await ctx.db.update(s.phoneNumbers).set(patch).where(eq(s.phoneNumbers.id, id));
    await settleEnrollment(user.id, session.id);
    await emitUserUpdated(user.id);
    return c.json({ response: serializePhone(first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, id)))!) });
  });

  app.delete("/phone_numbers/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, id), eq(s.phoneNumbers.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    await deletePhoneNumber(ctx, user.id, id);
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "phone_number", id, deleted: true } });
  });

  app.post("/phone_numbers/:id/prepare_verification", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, id), eq(s.phoneNumbers.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    if (row.verified) throw new OrbitError(422, ErrorCodes.verification_already_verified, "That phone number is already verified");
    await hit(ctx, `add_phone:prepare:${user.id}`, 10, 60_000);
    const settings = ctx.settings.get();
    const issued = await issueVerification(ctx, {
          purpose: "add_phone", strategy: "phone_code", identifier: row.phone, ownerId: row.id,
          lifetimeSeconds: settings.email.codeLifetimeSeconds,
        });
    await sendSms(ctx, row.phone, `Your ${settings.application.name} verification code is ${issued.code}`);
    return c.json({ response: serializePhone(row) });
  });

  app.post("/phone_numbers/:id/attempt_verification", async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, id), eq(s.phoneNumbers.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    const body = await parseBody(c, verifyCodeSchema);
    await hit(ctx, `add_phone:attempt:${user.id}`, 20, 60_000);
    const verification = await getVerification(ctx, "add_phone", row.id);
    await checkCode(ctx, verification, body.code);
    const duplicate = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.phone, row.phone), eq(s.phoneNumbers.verified, true))));
    if (duplicate && duplicate.id !== row.id) {
      throw new OrbitError(409, ErrorCodes.duplicate_record, "That phone number is already verified by another account");
    }
    await ctx.db.update(s.phoneNumbers).set({ verified: true, verifiedAt: Date.now(), updatedAt: Date.now() }).where(eq(s.phoneNumbers.id, row.id));
    await emitUserUpdated(user.id);
    return c.json({ response: serializePhone(first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, row.id)))!) });
  });

  // ───────────── external accounts ─────────────
  app.get("/external_accounts", async (c) => {
    const { user } = await auth(c);
    const rows = (await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, user.id)));
    return c.json({ response: rows.map(serializeExternalAccount) });
  });

  app.post("/external_accounts", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { client, user } = await auth(c);
    const body = await parseBody(c, externalAccountCreateSchema);
    if (!body.strategy.startsWith("oauth_")) throw new OrbitError(422, ErrorCodes.oauth_provider_not_enabled, "strategy must be an oauth_* strategy", { param_name: "strategy" });
    const provider = providerKeyFromStrategy(body.strategy);
    if (!isProviderEnabled(ctx, provider)) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
    const adapter = await getOAuthAdapter(ctx, provider);
    if (!adapter) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Unsupported provider", { param_name: "strategy" });
    const redirectUrl = validateRedirectUrl(ctx, body.redirect_url) ?? ctx.settings.get().application.homeUrl;
    const authStart = await createOAuthAuthorization(ctx, c, provider, {
      clientId: client.id, kind: "connect", userId: user.id, redirectUrl,
      additionalScopes: body.additional_scopes,
    });
    return c.json({
      response: {
        object: "external_account",
        id: authStart.state,
        provider,
        provider_user_id: "",
        identification_id: authStart.state,
        email_address: "",
        first_name: "",
        last_name: "",
        username: null,
        image_url: null,
        avatar_url: null,
        approved_scopes: "",
        public_metadata: {},
        label: null,
        verification: { status: "unverified", strategy: `oauth_${provider}`, attempts: null, expire_at: null, external_verification_redirect_url: authStart.url },
        external_verification_redirect_url: authStart.url,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
  });

  app.delete("/external_accounts/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.externalAccounts).where(and(eq(s.externalAccounts.id, id), eq(s.externalAccounts.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.external_account_not_found, "External account not found");
    await assertNotLastIdentification(ctx, user.id);
    await ctx.db.delete(s.externalAccounts).where(eq(s.externalAccounts.id, id));
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "external_account", id, deleted: true } });
  });

  app.get("/external_accounts/:id/access_token", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.externalAccounts).where(and(eq(s.externalAccounts.id, id), eq(s.externalAccounts.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.external_account_not_found, "External account not found");
    const token = row.accessTokenEnc ? decrypt(ctx.env.encryptionKey, row.accessTokenEnc) : null;
    return c.json({
      response: {
        object: "external_account_access_token",
        token,
        expires_at: row.tokenExpiresAt,
        scopes: row.approvedScopes,
      },
    });
  });

  // ───────────── TOTP / backup codes ─────────────
  app.get("/totp", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: { object: "totp", id: user.id, verified: user.totpVerified, secret: null, uri: null, qr_code: null, backup_code_enabled: !!user.backupCodes?.length } });
  });

  app.post("/totp", async (c) => {
    const { user } = await auth(c);
    if (user.totpVerified) throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP is already enabled. Disable it before setting it up again.");
    const setup = await startTotpSetup(ctx, user);
    return c.json({
      response: {
        object: "totp", id: user.id, secret: setup.secret, uri: setup.uri, qr_code: setup.qrCode, verified: false, backup_code_enabled: false,
      },
    });
  });

  app.post("/totp/attempt_verification", async (c) => {
    const { user, session } = await auth(c);
    const body = await parseBody(c, totpAttemptSchema);
    await hit(ctx, `totp:attempt:${user.id}`, 20, 60_000);
    const { backupCodes } = await finishTotpSetup(ctx, user, body.code);
    await settleEnrollment(user.id, session.id);
    await emitUserUpdated(user.id);
    return c.json({
      response: {
        object: "totp", id: user.id, verified: true, secret: null, uri: null, qr_code: null, backup_code_enabled: true,
        backup_codes: backupCodes.map((code) => ({ object: "backup_code", code, used: false })),
      },
    });
  });

  app.delete("/totp", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    await disableTotp(ctx, user);
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "totp", id: user.id, verified: false, secret: null, uri: null, qr_code: null, backup_code_enabled: false } });
  });

  app.post("/backup_codes", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    if (!user.totpVerified) throw new OrbitError(400, ErrorCodes.totp_not_enabled, "Enable TOTP before generating backup codes");
    const codes = generateBackupCodes();
    await ctx.db.update(s.users).set({ backupCodes: codes.hashed, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
    await emitUserUpdated(user.id);
    return c.json({ response: codes.plain.map((code) => ({ object: "backup_code", code, used: false })) });
  });

  // ───────────── passkeys ─────────────
  app.get("/passkeys", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listPasskeys(ctx, user.id)).map(serializePasskey) });
  });

  app.post("/passkeys", async (c) => {
    const { user } = await auth(c);
    if (!ctx.settings.get().attributes.passkey.enabled) throw new OrbitError(400, ErrorCodes.webauthn_not_supported, "Passkeys are disabled for this instance");
    const body = await parseBody(c, passkeyCreateSchema);
    const email = await primaryEmail(ctx, user);
    const rp = relyingParty(ctx, c.req.header("origin"));
    const { passkeyId, options } = await beginPasskeyRegistration(ctx, {
      userId: user.id,
      userName: email?.email ?? user.username ?? user.id,
      displayName: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email?.email || user.id,
      rp,
      authenticatorType: body.authenticator_type,
      name: body.name,
    });
    return c.json({
      response: {
        object: "passkey", id: passkeyId, name: body.name ?? "Passkey",
        verification: { status: "unverified", strategy: "passkey", attempts: null, expire_at: null, nonce: options.challenge },
        public_key_credential_creation_options: options,
        last_used_at: null, created_at: Date.now(), updated_at: Date.now(),
      },
    });
  });

  app.post("/passkeys/:id/attempt_verification", async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const body = await parseBody(c, passkeyAttemptSchema);
    if (!body.public_key_credential) throw new OrbitError(422, ErrorCodes.form_param_missing, "public_key_credential is missing", { param_name: "public_key_credential" });
    const rp = relyingParty(ctx, c.req.header("origin"));
    const passkey = await finishPasskeyRegistration(ctx, {
      // The credential is validated at runtime by @simplewebauthn/server.
      passkeyId: id, userId: user.id, rp, credential: body.public_key_credential as unknown as RegistrationResponseJSON, name: body.name,
    });
    await emitUserUpdated(user.id);
    return c.json({ response: serializePasskey(passkey) });
  });

  app.patch("/passkeys/:id", async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.passkeys).where(and(eq(s.passkeys.id, id), eq(s.passkeys.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Passkey not found");
    const body = await parseBody(c, passkeyRenameSchema);
    await ctx.db.update(s.passkeys).set({ name: body.name, updatedAt: Date.now() }).where(eq(s.passkeys.id, id));
    await emitUserUpdated(user.id);
    return c.json({ response: serializePasskey(first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.id, id)))!) });
  });

  app.delete("/passkeys/:id", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.passkeys).where(and(eq(s.passkeys.id, id), eq(s.passkeys.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Passkey not found");
    await ctx.db.delete(s.passkeys).where(eq(s.passkeys.id, id));
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "passkey", id, deleted: true } });
  });

  // ───────────── active sessions ─────────────
  app.get("/sessions/active", async (c) => {
    const { session, user } = await auth(c);
    const rows = (await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.userId, user.id), eq(s.sessions.status, "active")))
          .orderBy(desc(s.sessions.lastActiveAt)))
      .filter((row) => row.id !== session.id && row.expireAt > Date.now());
    return c.json({ response: (await Promise.all(rows.map((row) => serializeSession(ctx, row, { withUser: true })))) });
  });

  app.post("/sessions/:id/revoke", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    const id = c.req.param("id")!;
    const row = first(await ctx.db.select().from(s.sessions).where(and(eq(s.sessions.id, id), eq(s.sessions.userId, user.id))));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
    const updated = await endSession(ctx, row, "revoked");
    return c.json({ response: await serializeSession(ctx, updated, { withUser: true }) });
  });

  return app;
}
