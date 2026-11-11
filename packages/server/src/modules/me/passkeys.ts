/** Passkey routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { type RegistrationResponseJSON } from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { serializePasskey } from "../../serializers";
import { beginPasskeyRegistration, finishPasskeyRegistration, listPasskeys, relyingParty } from "../../services/passkeys";
import { assertAdditionalIdentificationsAllowed } from "../../services/enterprise-access";
import { primaryEmail } from "../../services/users";
import { requireReverification } from "../auth/reverification";
import { first } from "../../lib/db";
import { passkeyCreateSchema, passkeyAttemptSchema, passkeyRenameSchema } from "./shared";
import type { MeHelpers } from "./helpers";

export function registerPasskeyRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth, emitUserUpdated } = helpers;

  // ───────────── passkeys ─────────────
  app.get("/passkeys", async (c) => {
    const { user } = await auth(c);
    return c.json({ response: (await listPasskeys(ctx, user.id)).map(serializePasskey) });
  });

  app.post("/passkeys", async (c) => {
    const { user } = await auth(c);
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
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
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
    const id = c.req.param("id")!;
    const body = await parseBody(c, passkeyAttemptSchema);
    if (!body.public_key_credential) throw new OrbitError(422, ErrorCodes.form_param_missing, "public_key_credential is missing", { param_name: "public_key_credential" });
    const passkey = await finishPasskeyRegistration(ctx, {
      // The credential is validated at runtime by @simplewebauthn/server.
      passkeyId: id, userId: user.id, credential: body.public_key_credential as unknown as RegistrationResponseJSON, name: body.name,
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
}
