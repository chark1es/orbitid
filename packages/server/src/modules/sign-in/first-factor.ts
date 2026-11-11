/** First-factor preparation, attempts, and password reset. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { clientIp, parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { assertPasswordValid, hashPassword } from "../../services/passwords";
import { assertAdditionalIdentificationsAllowed } from "../../services/enterprise-access";
import { endSessionsForUser } from "../../services/sessions";
import { revokeGrantsForUser } from "../../services/oidc/revocation";
import { revokeAllTrustedDevices } from "../../services/trusted-devices";
import { verifyCaptcha } from "../../services/captcha";
import { beginPasskeyAuthentication, finishPasskeyAuthentication, relyingParty } from "../../services/passkeys";
import { sendEmail, sendSms } from "../../services/mail";
import { getUserById, listEmails, listPhones, primaryEmail, resetFailedAttempts, type UserRow } from "../../services/users";
import { isProviderEnabled, providerKeyFromStrategy } from "../../services/oauth-providers";
import { getOrCreateClient } from "../auth/client-auth";
import { asSignInState, assertSignInAllowed, enterpriseConnectionForEmail, saveSignInState, verifiedEmailOf, verifiedPhoneOf, type FactorState, type SignInState } from "../auth/signin-core";
import { createOAuthAuthorization } from "../auth/oauth-flow";
import { getVerification, getVerificationById, issueVerification, magicLinkUrl, type VerificationRow } from "../auth/verifications";
import { validateRedirectUrl } from "../auth/redirects";
import { first } from "../../lib/db";
import { prepareFirstSchema, attemptFirstSchema, resetPasswordSchema, captchaToken } from "./shared";
import type { SignInHelpers } from "./helpers";

interface RecoveryFactor {
  strategy: "reset_password_email_code" | "reset_password_phone_code";
  emailId?: string;
  phoneId?: string;
}

/**
 * First factors that need no prepare step because the attempt itself carries and checks the credential.
 * They must not be matched against the strategy that was prepared: the UI can move from an email code
 * straight to the password screen, and the password attempt is validated by `attemptPassword` (plus the
 * sign-in state gate). Every strategy whose prepare step issues a code, link, or ceremony challenge
 * (email_code, phone_code, email_link, reset_password_*, passkey) keeps the prepared-strategy binding so
 * one channel's artifact cannot be relabelled as another. Redirect flows and tickets are refused in the
 * attempt route before any verification, so their binding is moot.
 */
const PREPARATION_FREE_FIRST_FACTORS = new Set(["password"]);

/**
 * Maps a verified `reset_password` record to the recovery factor it authorized. The record is authoritative
 * for the channel and identifier; the request body never decides which mailbox or handset was recovered.
 */
async function recoveryFactorFromVerification(
  ctx: AppContext,
  user: UserRow,
  verification: VerificationRow,
): Promise<RecoveryFactor | undefined> {
  if (verification.strategy === "email_code") {
    const email = (await listEmails(ctx, user.id)).find((e) => e.email === verification.identifier && e.verified);
    return email ? { strategy: "reset_password_email_code", emailId: email.id } : undefined;
  }
  if (verification.strategy === "phone_code") {
    const phone = (await listPhones(ctx, user.id)).find((p) => p.phone === verification.identifier && p.verified);
    return phone ? { strategy: "reset_password_phone_code", phoneId: phone.id } : undefined;
  }
  return undefined;
}

export function registerFirstFactorRoutes(app: Hono, ctx: AppContext, helpers: SignInHelpers) {
  const { respond, reload, load, userForRow, checkSignInCode, notifySession, afterFirst, assertFirstFactorEnabled, attemptPassword, startEnterprise } = helpers;

  // ───────────── prepare first factor ─────────────
  app.post("/:id/prepare_first_factor", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    const body = await parseBody(c, prepareFirstSchema);
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy ?? "password";
    // A first factor may only be prepared while the sign-in is still waiting for one: the normal first
    // step, or the identifier-first passkey (conditional UI) step. This keeps a sign-in that already
    // advanced to MFA, or already reset its password, from being walked back into another reset.
    if (row.status !== "needs_first_factor" && !(row.status === "needs_identifier" && strategy === "passkey")) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is not waiting for a first factor");
    }
    await hit(ctx, `sign_in:prepare:${clientIp(c)}`, 30, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
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
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy;
    // Attempts are only accepted from the state that is waiting for a first factor (the normal first step,
    // or the identifier-first passkey step). Without this gate a sign-in parked at `needs_second_factor` or
    // `needs_new_password` could be pushed back to re-verify a first-factor code that was already spent.
    if (row.status !== "needs_first_factor" && !(row.status === "needs_identifier" && strategy === "passkey")) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is not waiting for a first factor");
    }
    await hit(ctx, `sign_in:attempt:${clientIp(c)}`, 60, 60_000);
    if (!strategy) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No first-factor strategy in progress", { param_name: "strategy" });
    // The strategy a caller names must be the one that was actually prepared, except for strategies such
    // as password that carry their own credential and need no preparation. Without this binding a valid code
    // for one channel could be submitted under another strategy and persisted as the factor that was verified.
    const preparedStrategy = state.first?.strategy;
    if (body.strategy && preparedStrategy && body.strategy !== preparedStrategy
      && !PREPARATION_FREE_FIRST_FACTORS.has(body.strategy)) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid,
        "The attempted strategy does not match the first factor that was prepared", { param_name: "strategy" });
    }
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
      // Only the verification row created at prepare time may authorize this reset, and only for the channel
      // the caller prepared. The verified record — not the request body — decides which identifier was recovered.
      const prepared = state.first;
      const expectedVerificationStrategy = strategy === "reset_password_email_code" ? "email_code" : "phone_code";
      const verification = prepared?.verificationId ? await getVerificationById(ctx, prepared.verificationId) : undefined;
      if (!prepared || prepared.strategy !== strategy || !verification
        || verification.purpose !== "reset_password" || verification.ownerId !== row.id
        || verification.strategy !== expectedVerificationStrategy || verification.consumedAt) {
        throw new OrbitError(400, ErrorCodes.client_state_invalid, "No matching password recovery is in progress", { param_name: "strategy" });
      }
      await checkSignInCode(user, verification, body.code);
      const recovery = await recoveryFactorFromVerification(ctx, user, verification);
      if (!recovery) {
        throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account no longer has the recovery identifier", { param_name: "strategy" });
      }
      const saved = await saveSignInState(ctx, row, {
              ...state,
              first: { strategy: recovery.strategy, status: "verified", verificationId: verification.id, emailId: recovery.emailId, phoneId: recovery.phoneId },
              resetPassword: { verified: true, strategy: recovery.strategy },
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
    // Re-derive the recovered channel and identifier from the verified record, never from stored request input.
    const verification = state.first?.verificationId ? await getVerificationById(ctx, state.first.verificationId) : undefined;
    const recovery = verification && verification.purpose === "reset_password" && verification.verifiedAt && !verification.consumedAt
      ? await recoveryFactorFromVerification(ctx, user, verification)
      : undefined;
    if (!verification || !recovery || verification.ownerId !== row.id || state.first?.strategy !== recovery.strategy) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    }
    // Recovery must not create a local credential the enterprise connection forbids.
    await assertAdditionalIdentificationsAllowed(ctx, user.id);
    await assertPasswordValid(ctx, body.password);
    const passwordHash = await hashPassword(body.password);
    const now = Date.now();
    // The recovery authorization itself is single-use: consume the verified record atomically. A replayed
    // code — or a parallel duplicate — finds it already spent and never reaches the password write.
    const consumed = await ctx.db.update(s.verifications).set({ consumedAt: now })
      .where(and(eq(s.verifications.id, verification.id), isNull(s.verifications.consumedAt), isNotNull(s.verifications.verifiedAt)))
      .returning({ id: s.verifications.id });
    if (!consumed.length) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    // One request wins the authorization; a parallel duplicate finds the attempt already claimed.
    const claimed = await ctx.db.update(s.signIns).set({ status: "resetting_password", updatedAt: now })
      .where(and(eq(s.signIns.id, row.id), eq(s.signIns.status, "needs_new_password"))).returning({ id: s.signIns.id });
    if (!claimed.length) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    await ctx.db.update(s.users).set({ passwordHash, passwordUpdatedAt: now, failedAttempts: 0, locked: false, lockoutExpiresAt: null, updatedAt: now }).where(eq(s.users.id, user.id));
    // Recovery is the step an attacker who stole a session is least able to survive. Revoke every other session,
    // every OIDC grant (including device-flow grants with no browser session) and every trusted device *before*
    // any notification mail: a failed email send must never leave the attacker's session alive. The recovering
    // browser keeps signing in with the new password and receives its new session below.
    const signOut = body.sign_out_of_other_sessions ?? ctx.settings.get().password.signOutOfOtherSessionsOnReset;
    if (signOut) {
      await endSessionsForUser(ctx, user.id, "revoked");
      await revokeGrantsForUser(ctx, user.id);
    }
    // A reset password invalidates every remembered browser.
    await revokeAllTrustedDevices(ctx, user.id);
    const email = await primaryEmail(ctx, user);
    if (email) {
      await sendEmail(ctx, { to: email.email, template: "password_changed", vars: { user_name: user.firstName ?? undefined } });
    }
    const rest: SignInState = { ...state };
    delete rest.resetPassword;
    // Keep the verified identifier the reset was authorized with: dropping it made MFA fall back to the first
    // stored address, so the recovery mailbox could also satisfy the second factor.
    const saved = await saveSignInState(ctx, row, {
      ...rest,
      first: {
        strategy: recovery.strategy,
        status: "verified",
        verificationId: verification.id,
        emailId: recovery.emailId,
        phoneId: recovery.phoneId,
      },
    });
    const result = await afterFirst(c, client.id, saved, user);
    if (result.status === "needs_sign_in") {
      // The reset itself succeeded, but recovery already used the channel of the account's only enrolled
      // second factor, so no eligible factor is left. Do not mint a session that never passed MFA; hand the
      // browser back to the password step so the normal password flow can ask for the second factor.
      await saveSignInState(ctx, row, {
        ...rest,
        requestedReset: false,
        second: undefined,
        first: {
          strategy: "password",
          status: "unverified",
          error: {
            code: ErrorCodes.needs_second_factor,
            message: "MFA is required. Sign in with your new password to complete a second factor.",
          },
        },
      });
      await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      return respond(c, client.id, await reload(row.id));
    }
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, await reload(row.id));
  });
}
