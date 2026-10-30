/** User creation route. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { eq, or } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../../lib/http";
import { encrypt } from "../../../lib/crypto";
import { newId } from "../../../lib/ids";
import * as s from "../../../db/schema";
import { serializeUser } from "../../../serializers";
import { emitEvent } from "../../../services/webhooks";
import { audit } from "../../../services/audit";
import { hashBackupCode } from "../../../services/mfa";
import { assertPasswordDigest, assertPasswordPolicy, hashPassword } from "../passwords";
import { getUserOrThrow, normalizeEmail } from "../shared";
import { first } from "../../../lib/db";
import { createUserSchema, AUDIT_ACTOR } from "./shared";

export function registerCreateRoutes(app: Hono, ctx: AppContext) {
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
        ? (assertPasswordDigest(body.password_digest, body.password_hasher!), body.password_digest)
        : null;
    if (!passwordHash && !body.skip_password_requirement && settings.attributes.password.enabled && settings.attributes.password.required) {
      throw new OrbitError(422, ErrorCodes.form_param_missing, "password is required.", { param_name: "password" });
    }

    const username = body.username?.trim() || null;
    if (username && first(await ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())))) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This username is already taken.", { param_name: "username" });
    }
    if (body.external_id && first(await ctx.db.select().from(s.users).where(eq(s.users.externalId, body.external_id)))) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This external_id is already in use.", { param_name: "external_id" });
    }
    const emails = (body.email_address ?? []).map(normalizeEmail);
    const phones = (body.phone_number ?? []).map((p) => p.trim());
    // A required attribute is a prerequisite of every account, not a UI suggestion. `skip_password_requirement`
    // is the documented escape hatch an import uses; without it, the Backend API enforces the same requirements
    // sign-up does (this is what keeps "email is required" true for accounts created by a script).
    if (!body.skip_password_requirement) {
      const attrs = settings.attributes;
      if (attrs.emailAddress.enabled && attrs.emailAddress.required && !emails.length) {
        throw new OrbitError(422, ErrorCodes.form_param_missing, "email_address is required on this instance.", { param_name: "email_address" });
      }
      if (attrs.phoneNumber.enabled && attrs.phoneNumber.required && !phones.length) {
        throw new OrbitError(422, ErrorCodes.form_param_missing, "phone_number is required on this instance.", { param_name: "phone_number" });
      }
      if (attrs.username.enabled && attrs.username.required && !username) {
        throw new OrbitError(422, ErrorCodes.form_param_missing, "username is required on this instance.", { param_name: "username" });
      }
      if (attrs.firstName.enabled && attrs.firstName.required && !body.first_name?.trim()) {
        throw new OrbitError(422, ErrorCodes.form_param_missing, "first_name is required on this instance.", { param_name: "first_name" });
      }
      if (attrs.lastName.enabled && attrs.lastName.required && !body.last_name?.trim()) {
        throw new OrbitError(422, ErrorCodes.form_param_missing, "last_name is required on this instance.", { param_name: "last_name" });
      }
    }
    if (new Set(emails).size !== emails.length) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "email_address contains the same address twice.", { param_name: "email_address" });
    }
    for (const email of emails) {
      if (first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, email)))) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, `${email} is already in use.`, { param_name: "email_address" });
      }
    }
    if (new Set(phones).size !== phones.length) {
      throw new OrbitError(422, ErrorCodes.duplicate_record, "phone_number contains the same number twice.", { param_name: "phone_number" });
    }

    const now = Date.now();
    const created = body.created_at ?? now;
    const id = newId(ID_PREFIX.user);
    const row = first(await ctx.db
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
            backupCodes: body.backup_codes ? body.backup_codes.map(hashBackupCode) : null,
            deleteSelfEnabled: body.delete_self_enabled ?? true,
            createOrganizationEnabled: body.create_organization_enabled ?? true,
            legalAcceptedAt: body.legal_accepted_at ?? null,
            createdAt: created,
            updatedAt: created,
          })
          .returning())!;

    const emailIds = await Promise.all(emails.map(async (email) =>
      first(await ctx.db
                .insert(s.emailAddresses)
                .values({ id: newId(ID_PREFIX.email), userId: id, email, verified: true, verifiedAt: now, verifiedStrategy: "email_code", createdAt: now, updatedAt: now })
                .returning())!,
    ));
    const phoneIds = await Promise.all(phones.map(async (phone) =>
      first(await ctx.db
                .insert(s.phoneNumbers)
                .values({ id: newId(ID_PREFIX.phone), userId: id, phone, verified: true, verifiedAt: now, createdAt: now, updatedAt: now })
                .returning())!,
    ));
    if (emailIds[0] || phoneIds[0]) {
      await ctx.db
                        .update(s.users)
                        .set({ primaryEmailAddressId: emailIds[0]?.id ?? null, primaryPhoneNumberId: phoneIds[0]?.id ?? null, updatedAt: now })
                        .where(eq(s.users.id, id));
    }

    const user = await getUserOrThrow(ctx, id);
    const json = await serializeUser(ctx, user, { backend: true });
    await emitEvent(ctx, "user.created", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.created", targetType: "user", targetId: id, metadata: { email_addresses: emails, username } });
    return c.json(json);
  });
}
