/** Profile, avatar, and password routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { assertImageBytes, randomImageName } from "../../lib/images";
import { assertPasswordValid, hashPassword, verifyPassword } from "../../services/passwords";
import { endSessionsForUser } from "../../services/sessions";
import { sendEmail } from "../../services/mail";
import { assertRequiredProfileField, assertUsernameAvailable, countIdentifications, deleteUser, hasVerifiedIdentifier, primaryEmail, recordFailedAttempt, resetFailedAttempts, upgradeAnonymousUser } from "../../services/users";
import { assertAdditionalIdentificationsAllowed } from "../../services/enterprise-access";
import { revokeAllTrustedDevices } from "../../services/trusted-devices";
import { clearClientCookie } from "../auth/client-auth";
import { requireReverification } from "../auth/reverification";
import { first } from "../../lib/db";
import { updateSchema, passwordChangeSchema, passwordRemoveSchema, MAX_IMAGE_BYTES, imageSchema } from "./shared";
import type { MeHelpers } from "./helpers";

export function registerProfileRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth, userResponse, emitUserUpdated, reloadUser } = helpers;

  // ───────────── profile ─────────────
  app.get("/", async (c) => {
    const { user } = await auth(c);
    return c.json(await userResponse(user));
  });

  app.patch("/", async (c) => {
    const { user } = await auth(c);
    const body = await parseBody(c, updateSchema);
    const patch: Partial<typeof s.users.$inferInsert> = { updatedAt: Date.now() };
    if (body.first_name !== undefined) {
      assertRequiredProfileField(ctx, "firstName", body.first_name);
      patch.firstName = body.first_name ?? null;
    }
    if (body.last_name !== undefined) {
      assertRequiredProfileField(ctx, "lastName", body.last_name);
      patch.lastName = body.last_name ?? null;
    }
    if (body.username !== undefined) {
      if (body.username !== null && body.username !== "" && !ctx.settings.get().attributes.username.enabled) {
        throw new OrbitError(422, ErrorCodes.form_param_unknown, "Usernames are disabled for this instance", { param_name: "username" });
      }
      if (body.username === null || body.username === "") {
        assertRequiredProfileField(ctx, "username", null);
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
    const body = await parseBody(c, passwordChangeSchema);
    // An account without a password (a guest upgrading, or a passwordless account) sets one directly.
    if (user.passwordHash) {
      if (!body.current_password) throw new OrbitError(422, ErrorCodes.form_param_missing, "current_password is missing", { param_name: "current_password" });
      if (!(await verifyPassword(user.passwordHash, body.current_password))) {
        await recordFailedAttempt(ctx, user.id);
        throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Current password is incorrect", { param_name: "current_password" });
      }
      await resetFailedAttempts(ctx, user.id);
    }
    // A guest has to be able to come back before a password means anything: verify an email or phone first.
    if (user.isAnonymous && !(await hasVerifiedIdentifier(ctx, user.id))) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "Add and verify an email address or phone number before setting a password.", { param_name: "new_password" });
    }
    await assertPasswordValid(ctx, body.new_password);
    const passwordHash = await hashPassword(body.new_password);
    await ctx.db.update(s.users).set({ passwordHash, passwordUpdatedAt: Date.now(), updatedAt: Date.now() }).where(eq(s.users.id, user.id));
    // A changed password invalidates every remembered browser.
    await revokeAllTrustedDevices(ctx, user.id);
    // Setting a password is one of the ways a guest account upgrades in place.
    await upgradeAnonymousUser(ctx, user.id);
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
    await revokeAllTrustedDevices(ctx, user.id);
    await emitUserUpdated(user.id);
    return c.json(await userResponse(await reloadUser(user.id)));
  });
}
