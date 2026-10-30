/** User read, update, and metadata routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { and, eq, or } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../../lib/http";
import * as s from "../../../db/schema";
import { serializeUser } from "../../../serializers";
import { emitEvent } from "../../../services/webhooks";
import { audit } from "../../../services/audit";
import { assertRequiredProfileField } from "../../../services/users";
import { getUserOrThrow, mergeMetadata, refuseUserCredentialMutation } from "../shared";
import { first } from "../../../lib/db";
import { updateUserSchema, metadataPatchSchema, revokeSessions, AUDIT_ACTOR } from "./shared";

export function registerUpdateRoutes(app: Hono, ctx: AppContext) {
  app.get("/users/:id", async (c) => c.json(await serializeUser(ctx, await getUserOrThrow(ctx, c.req.param("id")), { backend: true })));

  app.patch("/users/:id", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, updateUserSchema);
    // Credential and sign-in-identifier fields are not operator-editable. Accepting them would let the secret-key
    // holder set a password they know, install their own authenticator, clear the user's second factor, or make an
    // address they control the primary sign-in/ reset destination: that is signing in as the user through the app.
    if (body.password !== undefined || body.password_digest !== undefined || body.password_hasher !== undefined) {
      refuseUserCredentialMutation(
        "set, replace or remove the user's password",
        "change_password / remove_password",
      );
    }
    if (body.totp_secret !== undefined || body.backup_codes !== undefined) {
      refuseUserCredentialMutation(
        "install, replace or remove the user's authenticator or backup codes",
        "POST /totp, /totp/attempt_verification and /backup_codes",
      );
    }
    if (body.primary_email_address_id !== undefined || body.primary_phone_number_id !== undefined) {
      refuseUserCredentialMutation(
        "move the user's primary sign-in identifier",
        "PATCH /me with primary_email_address_id / primary_phone_number_id after verifying the identifier",
      );
    }
    const now = Date.now();
    const patch: Partial<typeof s.users.$inferInsert> = { updatedAt: now };

    if (body.external_id !== undefined) {
      if (body.external_id && first(await ctx.db.select().from(s.users).where(eq(s.users.externalId, body.external_id)))?.id !== existing.id) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This external_id is already in use.", { param_name: "external_id" });
      }
      patch.externalId = body.external_id;
    }
    if (body.username !== undefined) {
      const username = body.username?.trim() || null;
      // A username is an identifier the operator may keep managing: unlike an email address or a phone number it is
      // not a delivery channel and not a credential, so knowing or changing it does not let anyone complete a sign-in
      // (the password or a code sent to the user's own mailbox/number is still required). Replacing it only changes
      // what the user types, which stays a user-facing profile edit and an operator-facing support action.
      assertRequiredProfileField(ctx, "username", username);
      if (username) {
        const taken = first(await ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())));
        if (taken && taken.id !== existing.id) throw new OrbitError(422, ErrorCodes.form_identifier_exists, "This username is already taken.", { param_name: "username" });
      }
      patch.username = username;
      patch.usernameLower = username ? username.toLowerCase() : null;
    }
    if (body.first_name !== undefined) {
      assertRequiredProfileField(ctx, "firstName", body.first_name);
      patch.firstName = body.first_name;
    }
    if (body.last_name !== undefined) {
      assertRequiredProfileField(ctx, "lastName", body.last_name);
      patch.lastName = body.last_name;
    }
    if (body.public_metadata !== undefined) patch.publicMetadata = body.public_metadata;
    if (body.private_metadata !== undefined) patch.privateMetadata = body.private_metadata;
    if (body.unsafe_metadata !== undefined) patch.unsafeMetadata = body.unsafe_metadata;
    if (body.delete_self_enabled !== undefined) patch.deleteSelfEnabled = body.delete_self_enabled;
    if (body.create_organization_enabled !== undefined) patch.createOrganizationEnabled = body.create_organization_enabled;
    if (body.create_organizations_limit !== undefined) patch.createOrganizationsLimit = body.create_organizations_limit;
    if (body.legal_accepted_at !== undefined) patch.legalAcceptedAt = body.legal_accepted_at;

    await ctx.db.update(s.users).set(patch).where(eq(s.users.id, existing.id));
    if (body.sign_out_of_other_sessions) await revokeSessions(ctx, existing.id);

    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.updated", targetType: "user", targetId: existing.id, metadata: { fields: Object.keys(body) } });
    return c.json(json);
  });

  app.patch("/users/:id/metadata", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, metadataPatchSchema);
    await ctx.db
                  .update(s.users)
                  .set({
                    publicMetadata: body.public_metadata ? mergeMetadata(existing.publicMetadata ?? {}, body.public_metadata) : existing.publicMetadata,
                    privateMetadata: body.private_metadata ? mergeMetadata(existing.privateMetadata ?? {}, body.private_metadata) : existing.privateMetadata,
                    unsafeMetadata: body.unsafe_metadata ? mergeMetadata(existing.unsafeMetadata ?? {}, body.unsafe_metadata) : existing.unsafeMetadata,
                    updatedAt: Date.now(),
                  })
                  .where(eq(s.users.id, existing.id));
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.metadata.updated", targetType: "user", targetId: existing.id });
    return c.json(json);
  });
}
