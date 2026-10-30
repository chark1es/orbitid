/** First-factor preparation, attempts, and password reset. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { clientIp, parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { assertPasswordValid, hashPassword } from "../../services/passwords";
import { endSessionsForUser } from "../../services/sessions";
import { revokeAllTrustedDevices } from "../../services/trusted-devices";
import { verifyCaptcha } from "../../services/captcha";
import { beginPasskeyAuthentication, finishPasskeyAuthentication, relyingParty } from "../../services/passkeys";
import { sendEmail, sendSms } from "../../services/mail";
import { getUserById, primaryEmail, resetFailedAttempts } from "../../services/users";
import { isProviderEnabled, providerKeyFromStrategy } from "../../services/oauth-providers";
import { getOrCreateClient } from "../auth/client-auth";
import { asSignInState, assertSignInAllowed, enterpriseConnectionForEmail, saveSignInState, verifiedEmailOf, verifiedPhoneOf, type FactorState, type SignInState } from "../auth/signin-core";
import { createOAuthAuthorization } from "../auth/oauth-flow";
import { getVerification, issueVerification, magicLinkUrl } from "../auth/verifications";
import { validateRedirectUrl } from "../auth/redirects";
import { first } from "../../lib/db";
import { prepareFirstSchema, attemptFirstSchema, resetPasswordSchema, captchaToken } from "./shared";
import type { SignInHelpers } from "./helpers";

export function registerFirstFactorRoutes(app: Hono, ctx: AppContext, helpers: SignInHelpers) {
  const { respond, reload, load, userForRow, checkSignInCode, notifySession, afterFirst, assertFirstFactorEnabled, attemptPassword, startEnterprise } = helpers;

  // ───────────── prepare first factor ─────────────
  app.post("/:id/prepare_first_factor", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, prepareFirstSchema);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is already complete");
    await hit(ctx, `sign_in:prepare:${clientIp(c)}`, 30, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy ?? "password";
    const user = row.userId ? await getUserById(ctx, row.userId) : undefined;
    if (!user && strategy !== "passkey") throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    if (user) assertSignInAllowed(user);
    await assertFirstFactorEnabled(user, strategy);
    const email = body.email_address_id
      ? first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, body.email_address_id)))
      : user ? await verifiedEmailOf(ctx, user) : undefined;
    const phone = body.phone_number_id
      ? first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, body.phone_number_id)))
      : user ? await verifiedPhoneOf(ctx, user) : undefined;
    if (email && user && email.userId !== user.id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    if (phone && user && phone.userId !== user.id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    const settings = ctx.settings.get();
    const targetEmail = email ?? (user ? await primaryEmail(ctx, user) : undefined);

    const withFirst = async (first: FactorState, extra: Partial<SignInState> = {}) => {
      await saveSignInState(ctx, row, { ...state, ...extra, first });
      await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      return respond(c, client.id, await reload(row.id));
    };

    switch (strategy) {
      case "password":
        return withFirst({ strategy, status: "unverified" });
      case "email_code":
      case "reset_password_email_code": {
        if (!targetEmail?.verified) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified email address", { param_name: "strategy" });
        const issued = await issueVerification(ctx, {
                  purpose: strategy === "email_code" ? "sign_in_first_factor" : "reset_password",
                  strategy: "email_code", identifier: targetEmail.email, ownerId: row.id,
                  lifetimeSeconds: settings.email.codeLifetimeSeconds,
                });
        await sendEmail(ctx, {
          to: targetEmail.email,
          template: strategy === "email_code" ? "verification_code" : "reset_password_code",
          vars: { code: issued.code, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60), user_name: user?.firstName ?? undefined },
        });
        return withFirst({ strategy, verificationId: issued.row.id, emailId: targetEmail.id, status: "unverified" }, { requestedReset: strategy.startsWith("reset_password") });
      }
      case "email_link": {
        if (!targetEmail?.verified) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified email address", { param_name: "strategy" });
        const issued = await issueVerification(ctx, {
                  purpose: "sign_in_first_factor", strategy: "email_link", identifier: targetEmail.email, ownerId: row.id,
                  lifetimeSeconds: settings.email.linkLifetimeSeconds,
                  redirectUrl: validateRedirectUrl(ctx, body.redirect_url) ?? state.redirectUrl ?? null,
                });
        const link = magicLinkUrl(ctx, issued.token!, { sign_in_id: row.id });
        await sendEmail(ctx, {
          to: targetEmail.email, template: "magic_link",
          vars: { link, expires_in_minutes: Math.round(settings.email.linkLifetimeSeconds / 60), user_name: user?.firstName ?? undefined },
        });
        return withFirst({ strategy, verificationId: issued.row.id, emailId: targetEmail.id, status: "unverified" });
      }
      case "phone_code":
      case "reset_password_phone_code": {
        if (!phone?.verified) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified phone number", { param_name: "strategy" });
        const issued = await issueVerification(ctx, {
                  purpose: strategy === "phone_code" ? "sign_in_first_factor" : "reset_password",
                  strategy: "phone_code", identifier: phone.phone, ownerId: row.id, lifetimeSeconds: settings.email.codeLifetimeSeconds,
                });
        await sendSms(ctx, phone.phone, `Your ${settings.application.name} verification code is ${issued.code}`);
        return withFirst({ strategy, verificationId: issued.row.id, phoneId: phone.id, status: "unverified" }, { requestedReset: strategy.startsWith("reset_password") });
      }
      case "passkey": {
        const rp = relyingParty(ctx, c.req.header("origin"));
        const allowCredentials = user
          ? (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, user.id))).map((p) => ({ id: p.credentialId, transports: p.transports ?? undefined }))
          : [];
        const options = await beginPasskeyAuthentication(ctx, { rp, userId: user?.id, ownerId: row.id, allowCredentials });
        return withFirst({ strategy, status: "unverified", nonce: JSON.stringify(options) });
      }
      default: {
        if (strategy.startsWith("oauth_")) {
          const provider = providerKeyFromStrategy(strategy);
          if (!isProviderEnabled(ctx, provider)) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
          const auth = await createOAuthAuthorization(ctx, c, provider, {
            clientId: client.id, kind: "sign_in", ownerId: row.id,
            redirectUrl: state.redirectUrl ?? ctx.settings.get().application.homeUrl,
            actionCompleteRedirectUrl: state.actionCompleteRedirectUrl,
          });
          return withFirst({ strategy, status: "unverified", externalVerificationRedirectUrl: auth.url });
        }
        if (strategy === "enterprise_sso") {
          const emailAddr = targetEmail?.email;
          if (!emailAddr) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified email address");
          const conn = await enterpriseConnectionForEmail(ctx, emailAddr);
          if (!conn) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No enterprise SSO connection matches this account");
          await startEnterprise(row, conn.id, row.identifier ?? emailAddr, state);
          return respond(c, client.id, await reload(row.id));
        }
        throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
      }
    }
  });

  // ───────────── attempt first factor ─────────────
  app.post("/:id/attempt_first_factor", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, attemptFirstSchema);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is already complete");
    await hit(ctx, `sign_in:attempt:${clientIp(c)}`, 60, 60_000);
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy;
    if (!strategy) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No first-factor strategy in progress", { param_name: "strategy" });
    const existingUser = row.userId ? await getUserById(ctx, row.userId) : undefined;
    if (strategy !== "passkey") {
      if (!existingUser) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
      assertSignInAllowed(existingUser);
    }
    await assertFirstFactorEnabled(existingUser, strategy);

    if (strategy === "password") return attemptPassword(c, client.id, row, body.password);
    if (strategy.startsWith("oauth_") || strategy === "enterprise_sso" || strategy === "ticket") {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, `Strategy "${strategy}" is completed through its redirect flow`, { param_name: "strategy" });
    }

    if (strategy === "passkey") {
      if (!body.public_key_credential) throw new OrbitError(422, ErrorCodes.form_param_missing, "public_key_credential is missing", { param_name: "public_key_credential" });
      const { user: authed } = await finishPasskeyAuthentication(ctx, {
        ownerId: row.id,
        // The assertion is validated at runtime by @simplewebauthn/server.
        credential: body.public_key_credential as unknown as AuthenticationResponseJSON,
      });
      if (existingUser && authed.id !== existingUser.id) throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "That passkey belongs to another account");
      assertSignInAllowed(authed);
      await ctx.db.update(s.signIns).set({ userId: authed.id, identifier: row.identifier ?? authed.username ?? null, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      const current = await reload(row.id);
      const saved = await saveSignInState(ctx, current, { ...asSignInState(current), first: { strategy: "passkey", status: "verified" } });
      const result = await afterFirst(c, client.id, saved, authed);
      if (result.sessionId) await notifySession(authed, result.sessionId);
      return respond(c, client.id, await reload(row.id));
    }

    if (!existingUser) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    const user = existingUser;
    if (strategy === "email_link") {
      const verification = state.first?.verificationId ? await getVerification(ctx, "sign_in_first_factor", row.id) : undefined;
      if (!verification || !(verification.verifiedAt || verification.consumedAt)) {
        // Cross-device polling: the link has not been clicked yet.
        return respond(c, client.id, await reload(row.id));
      }
      const saved = await saveSignInState(ctx, row, { ...state, first: { ...(state.first ?? { strategy }), status: "verified" } });
      const result = await afterFirst(c, client.id, saved, user);
      if (result.sessionId) await notifySession(user, result.sessionId);
      return respond(c, client.id, await reload(row.id));
    }

    if (strategy === "reset_password_email_code" || strategy === "reset_password_phone_code") {
      const verification = await getVerification(ctx, "reset_password", row.id);
      await checkSignInCode(user, verification, body.code);
      const saved = await saveSignInState(ctx, row, {
              ...state, first: { ...(state.first ?? { strategy }), status: "verified" }, resetPassword: { verified: true, strategy },
            });
      await ctx.db.update(s.signIns).set({ status: "needs_new_password", state: saved.state as Record<string, unknown>, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      return respond(c, client.id, await reload(row.id));
    }

    if (strategy !== "email_code" && strategy !== "phone_code") {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
    }
    const verification = await getVerification(ctx, "sign_in_first_factor", row.id);
    await checkSignInCode(user, verification, body.code);
    await resetFailedAttempts(ctx, user.id);
    const saved = await saveSignInState(ctx, row, { ...state, first: { ...(state.first ?? { strategy }), status: "verified" } });
    const result = await afterFirst(c, client.id, saved, user);
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, await reload(row.id));
  });

  // ───────────── reset password ─────────────
  app.post("/:id/reset_password", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, resetPasswordSchema);
    const state = asSignInState(row);
    // The authorization is single-use: only a live attempt that is still waiting for a new password counts.
    if (row.status !== "needs_new_password" || row.abandonAt <= Date.now() || !state.resetPassword?.verified) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    }
    const user = await userForRow(row);
    if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
    await assertPasswordValid(ctx, body.password);
    const passwordHash = await hashPassword(body.password);
    const now = Date.now();
    // One request wins the authorization; a parallel duplicate finds the attempt already claimed.
    const claimed = await ctx.db.update(s.signIns).set({ status: "resetting_password", updatedAt: now })
      .where(and(eq(s.signIns.id, row.id), eq(s.signIns.status, "needs_new_password"))).returning({ id: s.signIns.id });
    if (!claimed.length) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    await ctx.db.update(s.users).set({ passwordHash, passwordUpdatedAt: now, failedAttempts: 0, locked: false, lockoutExpiresAt: null, updatedAt: now }).where(eq(s.users.id, user.id));
    const email = await primaryEmail(ctx, user);
    if (email) {
      await sendEmail(ctx, { to: email.email, template: "password_changed", vars: { user_name: user.firstName ?? undefined } });
    }
    const signOut = body.sign_out_of_other_sessions ?? ctx.settings.get().password.signOutOfOtherSessionsOnChange;
    if (signOut) await endSessionsForUser(ctx, user.id, "revoked");
    // A reset password invalidates every remembered browser.
    await revokeAllTrustedDevices(ctx, user.id);
    const { resetPassword, ...rest } = state;
    const saved = await saveSignInState(ctx, row, { ...rest, first: { strategy: resetPassword.strategy, status: "verified" } });
    const result = await afterFirst(c, client.id, saved, user);
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, await reload(row.id));
  });
}
