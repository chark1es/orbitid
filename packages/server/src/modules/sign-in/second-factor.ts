/** Second-factor preparation and attempts. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { clientIp, parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { issueTrustedDevice, setTrustedDeviceCookie } from "../../services/trusted-devices";
import { consumeBackupCode, emailSecondFactor, supportedSecondFactors, verifiedSecondFactorPhones, verifyTotp } from "../../services/mfa";
import { sendEmail, sendSms } from "../../services/mail";
import { listEmails, recordFailedAttempt, resetFailedAttempts } from "../../services/users";
import { getOrCreateClient } from "../auth/client-auth";
import { asSignInState, assertSignInAllowed, completeSignIn, saveSignInState } from "../auth/signin-core";
import { getVerification, issueVerification } from "../auth/verifications";
import { first } from "../../lib/db";
import { prepareSecondSchema, attemptSecondSchema } from "./shared";
import type { SignInHelpers } from "./helpers";

export function registerSecondFactorRoutes(app: Hono, ctx: AppContext, helpers: SignInHelpers) {
  const { respond, completionOpts, reload, load, userForRow, checkSignInCode, notifySession } = helpers;

  // ───────────── second factor ─────────────
  app.post("/:id/prepare_second_factor", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, prepareSecondSchema);
    await hit(ctx, `sign_in:prepare_second:${clientIp(c)}`, 30, 60_000);
    const user = await userForRow(row);
    assertSignInAllowed(user);
    const state = asSignInState(row);
    if (state.first?.status !== "verified") throw new OrbitError(400, ErrorCodes.client_state_invalid, "The first factor has not been verified");
    const available = await supportedSecondFactors(ctx, user, { firstFactorStrategy: state.first?.strategy });
    if (!available.length) throw new OrbitError(400, ErrorCodes.needs_second_factor, "This account has no second factor");
    const strategy = body.strategy ?? state.second?.strategy ?? available[0]!.strategy;
    if (!available.some((f) => f.strategy === strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Second factor "${strategy}" is not available`, { param_name: "strategy" });
    }
    if (strategy === "totp") {
      if (!user.totpVerified) throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP is not enabled for this user");
      await saveSignInState(ctx, row, { ...state, second: { strategy, status: "unverified" } });
    } else if (strategy === "backup_code") {
      if (!user.backupCodes?.length) throw new OrbitError(400, ErrorCodes.mfa_not_enabled, "No backup codes available");
      await saveSignInState(ctx, row, { ...state, second: { strategy, status: "unverified" } });
    } else if (strategy === "email_code") {
      const emails = await listEmails(ctx, user.id);
      const chosen = body.email_address_id ? emails.find((e) => e.id === body.email_address_id) : undefined;
      if (body.email_address_id && !chosen) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
      const email = chosen ?? await emailSecondFactor(ctx, user);
      if (!email || !email.verified) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified email address", { param_name: "strategy" });
      const settings = ctx.settings.get();
      const issued = await issueVerification(ctx, {
              purpose: "sign_in_second_factor", strategy: "email_code", identifier: email.email, ownerId: row.id,
              lifetimeSeconds: settings.email.codeLifetimeSeconds,
            });
      await sendEmail(ctx, {
        to: email.email,
        template: "verification_code",
        vars: { code: issued.code, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60), user_name: user.firstName ?? undefined },
      });
      await saveSignInState(ctx, row, { ...state, second: { strategy, verificationId: issued.row.id, emailId: email.id, status: "unverified" } });
    } else {
      const phones = await verifiedSecondFactorPhones(ctx, user);
      const phone = body.phone_number_id ? phones.find((p) => p.id === body.phone_number_id) : phones.find((p) => p.defaultSecondFactor) ?? phones[0];
      if (!phone) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No verified phone number for second factor");
      const settings = ctx.settings.get();
      const issued = await issueVerification(ctx, {
              purpose: "sign_in_second_factor", strategy: "phone_code", identifier: phone.phone, ownerId: row.id,
              lifetimeSeconds: settings.email.codeLifetimeSeconds,
            });
      await sendSms(ctx, phone.phone, `Your ${settings.application.name} verification code is ${issued.code}`);
      await saveSignInState(ctx, row, { ...state, second: { strategy, verificationId: issued.row.id, phoneId: phone.id, status: "unverified" } });
    }
    await ctx.db.update(s.signIns).set({ status: "needs_second_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
    return respond(c, client.id, await reload(row.id));
  });

  app.post("/:id/attempt_second_factor", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, attemptSecondSchema);
    await hit(ctx, `sign_in:attempt_second:${clientIp(c)}`, 60, 60_000);
    const user = await userForRow(row);
    assertSignInAllowed(user);
    const state = asSignInState(row);
    if (row.status !== "needs_second_factor" || state.first?.status !== "verified") {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "There is no verified first factor to escalate");
    }
    const strategy = body.strategy ?? state.second?.strategy;
    if (!strategy) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No second factor in progress", { param_name: "strategy" });
    const available = await supportedSecondFactors(ctx, user, { firstFactorStrategy: state.first?.strategy });
    if (!available.some((f) => f.strategy === strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Second factor "${strategy}" is not available`, { param_name: "strategy" });
    }
    let ok = false;
    if (strategy === "totp") ok = verifyTotp(ctx, user, body.code ?? "");
    else if (strategy === "backup_code") ok = await consumeBackupCode(ctx, user, body.code ?? "");
    else if (strategy === "phone_code") {
      await checkSignInCode(user, await getVerification(ctx, "sign_in_second_factor", row.id), body.code);
      ok = true;
    } else if (strategy === "email_code") {
      const email = await emailSecondFactor(ctx, user);
      const verification = await getVerification(ctx, "sign_in_second_factor", row.id);
      if (!email || !verification || verification.strategy !== "email_code" || verification.identifier !== email.email) {
        throw new OrbitError(422, ErrorCodes.form_code_incorrect, "There is no pending verification to check", { param_name: "code" });
      }
      await checkSignInCode(user, verification, body.code);
      ok = true;
    } else {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Second factor "${strategy}" is not valid`, { param_name: "strategy" });
    }
    if (!ok) {
      await recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
    }
    await resetFailedAttempts(ctx, user.id);
    await saveSignInState(ctx, row, { ...state, second: { ...(state.second ?? { strategy }), status: "verified" } });
    const sessionId = await completeSignIn(ctx, await reload(row.id), {
      ...completionOpts(c, client.id),
      secondFactor: true,
    });
    // A successful second factor may remember this browser; the original (non-sliding) expiry is kept on rotation.
    const setting = ctx.settings.get().session;
    if (body.trust_device && setting.trustedDevicesEnabled) {
      const issued = await issueTrustedDevice(ctx, { userId: user.id, userAgent: c.req.header("user-agent") ?? undefined, ip: clientIp(c) });
      setTrustedDeviceCookie(c, ctx, issued.token, issued.row.expiresAt);
    }
    await notifySession(user, sessionId);
    return respond(c, client.id, await reload(row.id));
  });
}
