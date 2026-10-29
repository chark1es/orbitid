// /v1/client/sign_ins
import { Hono, type Context } from "hono";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { randomToken } from "../lib/crypto";
import { clientIp, parseBody } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { assertPasswordValid, hashPassword, verifyPassword } from "../services/passwords";
import { endSessionsForUser, getSession, sendNewSignInEmail } from "../services/sessions";
import { verifyCaptcha } from "../services/captcha";
import { consumeBackupCode, supportedSecondFactors, verifyTotp, verifiedSecondFactorPhones } from "../services/mfa";
import { finishPasskeyAuthentication, beginPasskeyAuthentication, relyingParty } from "../services/passkeys";
import { sendEmail, sendSms } from "../services/mail";
import {
  detectIdentifierType, getUserByIdentifier, getUserById, normalizeEmail, normalizePhone,
  primaryEmail, recordFailedAttempt, resetFailedAttempts, type UserRow,
} from "../services/users";
import { assertIdentifiersAllowed } from "../services/restrictions";
import { isProviderEnabled, providerKeyFromStrategy } from "../services/oauth-providers";
import { clientAzp, getOrCreateClient, rotateClientTokenOnSignIn, serializeClient } from "./auth/client-auth";
import {
  afterFirstFactor, asSignInState, assertSignInAllowed, buildSignInJSON, completeSignIn, computeFirstFactors,
  enterpriseConnectionForEmail, latestTransferableSignIn, resolveTicket, saveSignInState, verifiedEmailOf, verifiedPhoneOf,
} from "./auth/signin-core";
import type { FactorState, SignInState } from "./auth/signin-core";
import { createOAuthAuthorization } from "./auth/oauth-flow";
import { checkCode, getVerification, issueVerification, magicLinkUrl, type VerificationRow } from "./auth/verifications";
import { validateRedirectUrl } from "./auth/redirects";
import { attachErrorItems } from "./auth/errors";
import { first } from "../lib/db";

// Per-field bounds; the 1 MB body cap is the outer limit. Nothing here may grow without a stated maximum.
const shortText = (max: number) => z.string().max(max);
const createSchema = z.object({
  identifier: shortText(320).optional(),
  strategy: shortText(64).optional(),
  password: shortText(256).optional(),
  ticket: shortText(512).optional(),
  redirect_url: shortText(2048).optional(),
  action_complete_redirect_url: shortText(2048).optional(),
  captcha_token: shortText(4096).optional(),
  transfer: z.boolean().optional(),
});
const prepareFirstSchema = z.object({
  strategy: shortText(64).optional(),
  email_address_id: shortText(64).optional(),
  phone_number_id: shortText(64).optional(),
  redirect_url: shortText(2048).optional(),
  captcha_token: shortText(4096).optional(),
});
const attemptFirstSchema = z.object({
  strategy: shortText(64).optional(),
  code: shortText(64).optional(),
  password: shortText(256).optional(),
  signature: shortText(8192).optional(),
  public_key_credential: z.unknown().optional(),
});
const prepareSecondSchema = z.object({ strategy: shortText(64).optional(), phone_number_id: shortText(64).optional() });
const attemptSecondSchema = z.object({ strategy: shortText(64).optional(), code: shortText(64).optional() });
const resetPasswordSchema = z.object({
  password: shortText(256),
  sign_out_of_other_sessions: z.boolean().optional(),
  redirect_url: shortText(2048).optional(),
});

type SignInRow = typeof s.signIns.$inferSelect;

const captchaToken = (c: Context, body: { captcha_token?: string }) => body.captcha_token ?? c.req.header("x-captcha-token") ?? undefined;

/**
 * A hash that no password matches, produced with this server's own argon2id parameters (so the dummy
 * check costs exactly what a real one does). Verifying against it when the account does not exist, or
 * has no password, keeps both response paths equally slow: timing cannot be used to enumerate accounts.
 */
let dummyPasswordHash: Promise<string> | null = null;
const dummyHash = () => (dummyPasswordHash ??= hashPassword(randomToken(24)));

/** Performs the same work as a real password check without revealing whether the account exists. */
export async function spendPasswordCheck(hash: string | null | undefined, password: string | undefined): Promise<boolean> {
  if (!hash) {
    await verifyPassword(await dummyHash(), password ?? "not-the-password");
    return false;
  }
  return verifyPassword(hash, password ?? "");
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  const respond = async (c: Context, clientId: string, row: SignInRow) => {
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, clientId)))!;
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: await buildSignInJSON(ctx, row), client: clientJson });
  };

  /** Common completion options: the client token is rotated as the session is created (fixation defence). */
  const completionOpts = (c: Context, clientId: string) => ({
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? undefined,
    rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, clientId),
  });

  const reload = async (id: string) => first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, id)))!;

  const load = async (clientId: string, id: string): Promise<SignInRow> => {
    const row = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, id)));
    if (!row || row.clientId !== clientId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
    return row;
  };

  const abandonPrevious = async (clientId: string) => {
    await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
                  .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_identifier")));
    await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
                  .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_first_factor")));
    await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
                  .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_second_factor")));
    await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
                  .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_new_password")));
  };


  const userForRow = async (row: SignInRow): Promise<UserRow> => {
    if (!row.userId) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    const user = await getUserById(ctx, row.userId);
    if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
    return user;
  };

  async function checkSignInCode(user: UserRow, verification: VerificationRow | undefined, code: string | undefined) {
    try {
      return checkCode(ctx, verification, code);
    } catch (err) {
      if (err instanceof OrbitError && err.code === ErrorCodes.form_code_incorrect) await recordFailedAttempt(ctx, user.id);
      throw err;
    }
  }

  async function notifySession(user: UserRow, sessionId: string) {
    const session = await getSession(ctx, sessionId);
    if (session) await sendNewSignInEmail(ctx, user, session);
  }

  /** A first factor the instance has switched off (or the user cannot use) is refused at the API, not just hidden in the UI. */
  async function assertFirstFactorEnabled(user: UserRow | undefined, strategy: string) {
    if (strategy === "passkey") {
      // `enabled` gates registration and the ceremony; `usedForFirstFactor` gates signing in with a passkey.
      const passkeys = ctx.settings.get().attributes.passkey;
      if (!passkeys.enabled || !passkeys.usedForFirstFactor) {
        throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "Sign-in with passkeys is not enabled", { param_name: "strategy" });
      }
      return;
    }
    if (!user || !["password", "email_code", "email_link", "phone_code"].includes(strategy)) return;
    const allowed = await computeFirstFactors(ctx, user);
    if (!allowed.some((factor) => factor.strategy === strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Sign-in with "${strategy}" is not enabled for this account`, { param_name: "strategy" });
    }
  }

  async function attemptPassword(c: Context, clientId: string, row: SignInRow, password: string | undefined) {
    const user = await userForRow(row);
    await assertFirstFactorEnabled(user, "password");
    if (!user.passwordHash) {
      // Same work as a real check, so "this account has no password" is not measurably faster.
      await spendPasswordCheck(null, password);
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account does not use a password", { param_name: "strategy" });
    }
    if (!password) throw new OrbitError(422, ErrorCodes.form_param_missing, "password is missing", { param_name: "password" });
    if (!(await verifyPassword(user.passwordHash, password))) {
      await recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Password is incorrect", { param_name: "password", session_id: row.id });
    }
    await resetFailedAttempts(ctx, user.id);
    const state = asSignInState(row);
    const saved = await saveSignInState(ctx, row, { ...state, first: { strategy: "password", status: "verified" } });
    await ctx.db.update(s.signIns).set({ userId: user.id, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
    const result = await afterFirstFactor(ctx, saved, user, completionOpts(c, clientId));
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, clientId, await reload(row.id));
  }

  const startEnterprise = async (row: SignInRow, connectionId: string, identifier: string, state: SignInState) => {
    const url = new URL(`${ctx.env.baseUrl}/v1/client/enterprise/start`);
    url.searchParams.set("connection_id", connectionId);
    url.searchParams.set("identifier", identifier);
    url.searchParams.set("sign_in_id", row.id);
    url.searchParams.set("client_id", row.clientId);
    url.searchParams.set("action", "sign_in");
    url.searchParams.set("redirect_url", state.redirectUrl ?? ctx.settings.get().application.homeUrl);
    if (state.actionCompleteRedirectUrl) url.searchParams.set("action_complete_redirect_url", state.actionCompleteRedirectUrl);
    const first: FactorState = { strategy: "enterprise_sso", status: "unverified", externalVerificationRedirectUrl: url.toString() };
    await saveSignInState(ctx, row, { ...state, first, enterpriseConnectionId: connectionId });
    await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
  };

  // ───────────── create ─────────────
  app.post("/", async (c) => {
    const body = await parseBody(c, createSchema);
    const client = await getOrCreateClient(ctx, c);
    await hit(ctx, `sign_in:create:${clientIp(c)}`, 100, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    if (!ctx.settings.get().session.multiSession && client.lastActiveSessionId) {
      const active = await getSession(ctx, client.lastActiveSessionId);
      if (active && active.status === "active" && active.expireAt > Date.now()) {
        const user = await getUserById(ctx, active.userId);
        const email = user ? await primaryEmail(ctx, user) : undefined;
        throw new OrbitError(400, ErrorCodes.identifier_already_signed_in, "You are already signed in", {
          session_id: active.id, email_addresses: email ? [email.email] : [],
        });
      }
    }
    if (body.transfer && !body.identifier && !body.strategy && !body.ticket) {
      // `signIn.create({ transfer: true })` surfaces the transferable OAuth attempt instead of replacing it.
      const transferable = await latestTransferableSignIn(ctx, client.id);
      if (transferable) return respond(c, client.id, transferable);
    }
    await abandonPrevious(client.id);
    const redirectUrl = validateRedirectUrl(ctx, body.redirect_url);
    const actionComplete = validateRedirectUrl(ctx, body.action_complete_redirect_url);
    const now = Date.now();
    const id = newId("sia");
    const state: SignInState = { redirectUrl: redirectUrl ?? undefined, actionCompleteRedirectUrl: actionComplete ?? undefined, azp: clientAzp(c) };
    await ctx.db.insert(s.signIns).values({
                  id, clientId: client.id, status: "needs_identifier", identifier: body.identifier?.trim() || null,
                  state: state as Record<string, unknown>, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
                });
    let row = await reload(id);

    if (body.ticket) {
      const ticket = await resolveTicket(ctx, body.ticket);
      const user = await getUserById(ctx, ticket.userId);
      if (!user) throw new OrbitError(422, ErrorCodes.ticket_invalid, "The ticket's user no longer exists");
      assertSignInAllowed(user);
      const ticketState: SignInState = {
        ...state,
        first: { strategy: "ticket", status: "verified" },
        actor: ticket.actor,
        sessionMaxDurationSeconds: ticket.sessionMaxDurationSeconds,
      };
      await saveSignInState(ctx, row, ticketState);
      await ctx.db.update(s.signIns).set({ userId: user.id, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      // A ticket proves the identity: MFA is bypassed for impersonation (actor tokens).
      const sessionId = await completeSignIn(ctx, await reload(row.id), {
        ...completionOpts(c, client.id),
        actor: ticket.actor,
        maxLifetimeSeconds: ticket.sessionMaxDurationSeconds,
      });
      await notifySession(user, sessionId);
      return respond(c, client.id, await reload(row.id));
    }

    const strategy = body.strategy;

    if (strategy?.startsWith("oauth_")) {
      const provider = providerKeyFromStrategy(strategy);
      if (!isProviderEnabled(ctx, provider)) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Social provider "${provider}" is not enabled`, { param_name: "strategy" });
      const auth = await createOAuthAuthorization(ctx, c, provider, {
        clientId: client.id, kind: "sign_in", ownerId: row.id,
        redirectUrl: redirectUrl ?? ctx.settings.get().application.homeUrl,
        actionCompleteRedirectUrl: actionComplete ?? undefined,
      });
      await saveSignInState(ctx, row, { ...state, first: { strategy, status: "unverified", externalVerificationRedirectUrl: auth.url } });
      await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      return respond(c, client.id, await reload(row.id));
    }

    if (strategy === "enterprise_sso") {
      const identifier = body.identifier?.trim();
      if (!identifier) throw new OrbitError(422, ErrorCodes.form_param_missing, "identifier is missing", { param_name: "identifier" });
      const found = await getUserByIdentifier(ctx, identifier);
      const email = found ? (found.type === "email_address" ? identifier : (await primaryEmail(ctx, found.user))?.email) : (detectIdentifierType(identifier) === "email_address" ? identifier : undefined);
      const conn = email ? await enterpriseConnectionForEmail(ctx, normalizeEmail(email)) : undefined;
      if (!conn) {
        if (found) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No enterprise SSO connection matches this account", { param_name: "strategy" });
        throw new OrbitError(422, ErrorCodes.form_identifier_not_found, "Couldn't find your account", { param_name: "identifier" });
      }
      // The account may not exist yet: domain-based routing hands the browser to the IdP regardless.
      await ctx.db.update(s.signIns).set({ userId: found?.user.id ?? null, identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
      await startEnterprise(await reload(row.id), conn.id, identifier, state);
      return respond(c, client.id, await reload(row.id));
    }

    if (!body.identifier) {
      if (strategy === "passkey") {
        // Discoverable passkey sign-in: no identifier is required until the assertion comes back.
        await assertFirstFactorEnabled(undefined, "passkey");
        await saveSignInState(ctx, row, { ...state, first: { strategy: "passkey", status: "unverified" } });
        await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
        return respond(c, client.id, await reload(row.id));
      }
      return respond(c, client.id, row);
    }

    const identifier = body.identifier.trim();
    const type = detectIdentifierType(identifier);
    await assertIdentifiersAllowed(ctx, {
      emails: type === "email_address" ? [normalizeEmail(identifier)] : [],
      phones: type === "phone_number" ? [normalizePhone(identifier)] : [],
    }, { signIn: true });

    if (type === "email_address") {
      const conn = await enterpriseConnectionForEmail(ctx, normalizeEmail(identifier));
      if (conn) {
        await ctx.db.update(s.signIns).set({ identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
        await startEnterprise(await reload(row.id), conn.id, identifier, state);
        return respond(c, client.id, await reload(row.id));
      }
    }

    const found = await getUserByIdentifier(ctx, identifier);
    if (!found) {
      // Spend the same password work as the existing-account path before answering, then give the same
      // shape of response either way so responses and timing cannot be used to enumerate accounts.
      if (body.password) await spendPasswordCheck(null, body.password);
      if (ctx.settings.get().security.enumerationProtection) return respond(c, client.id, await reload(row.id));
      const err = new OrbitError(422, ErrorCodes.form_identifier_not_found, "Couldn't find your account", { param_name: "identifier" });
      throw attachErrorItems(err, [
        err.toItem(),
        new OrbitError(422, ErrorCodes.form_identifier_not_found, "Sign up to create an account", { param_name: "identifier" }).toItem(),
      ]);
    }
    assertSignInAllowed(found.user);
    await ctx.db.update(s.signIns).set({ userId: found.user.id, identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
    row = await reload(row.id);

    if (type === "email_address") {
      const conn = await enterpriseConnectionForEmail(ctx, normalizeEmail(identifier));
      if (conn) {
        await startEnterprise(row, conn.id, identifier, state);
        return respond(c, client.id, await reload(row.id));
      }
    }

    if (body.password && (!strategy || strategy === "password")) {
      return attemptPassword(c, client.id, row, body.password);
    }

    if (strategy && !["password", "email_code", "email_link", "phone_code", "passkey", "reset_password_email_code", "reset_password_phone_code"].includes(strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
    }

    const requestedReset = strategy === "reset_password_email_code" || strategy === "reset_password_phone_code";
    await saveSignInState(ctx, row, { ...state, requestedReset, first: strategy ? { strategy, status: "unverified" } : undefined });
    await ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
    return respond(c, client.id, await reload(row.id));
  });

  // ───────────── read ─────────────
  app.get("/:id", async (c) => {
    const client = await getOrCreateClient(ctx, c);
    const row = await load(client.id, c.req.param("id"));
    return respond(c, client.id, row);
  });

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
      const result = await afterFirstFactor(ctx, saved, authed, completionOpts(c, client.id));
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
      const result = await afterFirstFactor(ctx, saved, user, completionOpts(c, client.id));
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
    const result = await afterFirstFactor(ctx, saved, user, completionOpts(c, client.id));
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
    const { resetPassword, ...rest } = state;
    const saved = await saveSignInState(ctx, row, { ...rest, first: { strategy: resetPassword.strategy, status: "verified" } });
    const result = await afterFirstFactor(ctx, saved, user, completionOpts(c, client.id));
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, await reload(row.id));
  });

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
    const available = await supportedSecondFactors(ctx, user);
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
    let ok = false;
    if (strategy === "totp") ok = verifyTotp(ctx, user, body.code ?? "");
    else if (strategy === "backup_code") ok = await consumeBackupCode(ctx, user, body.code ?? "");
    else if (strategy === "phone_code") {
      await checkSignInCode(user, await getVerification(ctx, "sign_in_second_factor", row.id), body.code);
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
    await notifySession(user, sessionId);
    return respond(c, client.id, await reload(row.id));
  });

  return app;
}
