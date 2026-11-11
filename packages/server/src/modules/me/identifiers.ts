/** Email-address and phone-number routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { and, eq, ne } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { assertIdentifiersAllowed } from "../../services/restrictions";
import { assertAdditionalIdentificationsAllowed } from "../../services/enterprise-access";
import { serializeEmail, serializePhone } from "../../serializers";
import { verifiedSecondFactorPhones } from "../../services/mfa";
import { sendEmail, sendSms } from "../../services/mail";
import { onUserEmailVerified } from "../../services/orgs";
import { deleteEmailAddress, deletePhoneNumber, findEmail, isValidEmail, listEmails, listPhones, normalizeEmail, normalizePhone, purgeUnverifiedClaims, setPrimaryEmail, setPrimaryPhone, upgradeAnonymousUser } from "../../services/users";
import { revokeAllTrustedDevices } from "../../services/trusted-devices";
import { requireReverification } from "../auth/reverification";
import { checkCode, getVerification, issueVerification } from "../auth/verifications";
import { first } from "../../lib/db";
import { emailCreateSchema, phoneCreateSchema, phoneUpdateSchema, verifyCodeSchema, prepareSchema } from "./shared";
import type { MeHelpers } from "./helpers";

export function registerIdentifierRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth, settleEnrollment, emitUserUpdated, reloadUser } = helpers;

  // ───────────── email addresses ─────────────
  app.get("/email_addresses", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listEmails(ctx, user.id)).map(serializeEmail) });
  });

  app.post("/email_addresses", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
    const body = await parseBody(c, emailCreateSchema);
    if (!ctx.settings.get().attributes.emailAddress.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Email addresses are disabled for this instance", { param_name: "email_address" });
    const email = normalizeEmail(body.email_address);
    if (!isValidEmail(email)) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email_address is not valid", { param_name: "email_address" });
    // Claiming an address is allowed while nobody has verified it (the owner of the mailbox settles it by verifying);
    // an address another account has verified, or one this account already holds, is taken.
    const claimed = await findEmail(ctx, email);
    if (claimed && (claimed.verified || claimed.userId === user.id)) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use", { param_name: "email_address" });
    }
    // Turning a guest into a registered user is a sign-up: it must pass the same allowlist and blocklist checks.
    if (user.isAnonymous) await assertIdentifiersAllowed(ctx, { emails: [email] });
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
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
    await purgeUnverifiedClaims(ctx, row.email, user.id);
    await onUserEmailVerified(ctx, user.id, row.email);
    // A verified email address turns a guest account into a regular one.
    await upgradeAnonymousUser(ctx, user.id);
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
    const body = await parseBody(c, phoneCreateSchema);
    if (!ctx.settings.get().attributes.phoneNumber.enabled) throw new OrbitError(422, ErrorCodes.form_param_unknown, "Phone numbers are disabled for this instance", { param_name: "phone_number" });
    const phone = normalizePhone(body.phone_number);
    if (first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)))) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That phone number is already in use", { param_name: "phone_number" });
    }
    if (user.isAnonymous) await assertIdentifiersAllowed(ctx, { phones: [phone] });
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
    // Turning off the last second factor invalidates remembered browsers.
    if (patch.reservedForSecondFactor === false || (body.default_second_factor === false && row.reservedForSecondFactor)) {
      const remaining = (await reloadUser(user.id));
      if (!remaining.totpVerified && !(await verifiedSecondFactorPhones(ctx, remaining)).length) {
        await revokeAllTrustedDevices(ctx, user.id);
      }
    }
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
    // Removing a second factor also forgets every browser that was allowed to skip it.
    if (row.reservedForSecondFactor && !user.totpVerified && !(await verifiedSecondFactorPhones(ctx, await reloadUser(user.id))).length) {
      await revokeAllTrustedDevices(ctx, user.id);
    }
    await emitUserUpdated(user.id);
    return c.json({ response: { object: "phone_number", id, deleted: true } });
  });

  app.post("/phone_numbers/:id/prepare_verification", requireReverification(ctx, "first_factor", 10), async (c) => {
    const { user } = await auth(c);
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
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
    await upgradeAnonymousUser(ctx, user.id);
    await emitUserUpdated(user.id);
    return c.json({ response: serializePhone(first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, row.id)))!) });
  });
}
