/** TOTP and backup-code routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { disableTotp, finishTotpSetup, generateBackupCodes, startTotpSetup } from "../../services/mfa";
import { revokeAllTrustedDevices } from "../../services/trusted-devices";
import { requireReverification } from "../auth/reverification";
import { totpAttemptSchema } from "./shared";
import type { MeHelpers } from "./helpers";

export function registerMfaRoutes(app: Hono, ctx: AppContext, helpers: MeHelpers) {
  const { auth, settleEnrollment, emitUserUpdated } = helpers;

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
    // Removing a second factor also forgets every browser that was allowed to skip it.
    await revokeAllTrustedDevices(ctx, user.id);
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
}
