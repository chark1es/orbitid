// /v1/client/sign_ins
import { Hono, type Context } from "hono";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
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
import { clientAzp, getOrCreateClient, serializeClient } from "./auth/client-auth";
import {
  afterFirstFactor, asSignInState, assertSignInAllowed, buildSignInJSON, completeSignIn,
  enterpriseConnectionForEmail, latestTransferableSignIn, resolveTicket, saveSignInState, verifiedEmailOf, verifiedPhoneOf,
} from "./auth/signin-core";
import type { FactorState, SignInState } from "./auth/signin-core";
import { createOAuthAuthorization } from "./auth/oauth-flow";
import { checkCode, getVerification, issueVerification, magicLinkUrl, type VerificationRow } from "./auth/verifications";
import { validateRedirectUrl } from "./auth/redirects";
import { attachErrorItems } from "./auth/errors";

const createSchema = z.object({
  identifier: z.string().optional(),
  strategy: z.string().optional(),
  password: z.string().optional(),
  ticket: z.string().optional(),
  redirect_url: z.string().optional(),
  action_complete_redirect_url: z.string().optional(),
  captcha_token: z.string().optional(),
  transfer: z.boolean().optional(),
});
const prepareFirstSchema = z.object({
  strategy: z.string().optional(),
  email_address_id: z.string().optional(),
  phone_number_id: z.string().optional(),
  redirect_url: z.string().optional(),
  captcha_token: z.string().optional(),
});
const attemptFirstSchema = z.object({
  strategy: z.string().optional(),
  code: z.string().optional(),
  password: z.string().optional(),
  signature: z.string().optional(),
  public_key_credential: z.unknown().optional(),
});
const prepareSecondSchema = z.object({ strategy: z.string().optional(), phone_number_id: z.string().optional() });
const attemptSecondSchema = z.object({ strategy: z.string().optional(), code: z.string().optional() });
const resetPasswordSchema = z.object({
  password: z.string(),
  sign_out_of_other_sessions: z.boolean().optional(),
  redirect_url: z.string().optional(),
});

type SignInRow = typeof s.signIns.$inferSelect;

const captchaToken = (c: Context, body: { captcha_token?: string }) => body.captcha_token ?? c.req.header("x-captcha-token") ?? undefined;

export default function routes(ctx: AppContext) {
  const app = new Hono();

  const respond = async (c: Context, clientId: string, row: SignInRow) => {
    const client = ctx.db.select().from(s.clients).where(eq(s.clients.id, clientId)).get()!;
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c) });
    return c.json({ response: buildSignInJSON(ctx, row), client: clientJson });
  };

  const reload = (id: string) => ctx.db.select().from(s.signIns).where(eq(s.signIns.id, id)).get()!;

  const load = (clientId: string, id: string): SignInRow => {
    const row = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, id)).get();
    if (!row || row.clientId !== clientId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
    return row;
  };

  const abandonPrevious = (clientId: string) => {
    ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
      .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_identifier"))).run();
    ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
      .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_first_factor"))).run();
    ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
      .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_second_factor"))).run();
    ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() })
      .where(and(eq(s.signIns.clientId, clientId), eq(s.signIns.status, "needs_new_password"))).run();
  };


  const userForRow = (row: SignInRow): UserRow => {
    if (!row.userId) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    const user = getUserById(ctx, row.userId);
    if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
    return user;
  };

  function checkSignInCode(user: UserRow, verification: VerificationRow | undefined, code: string | undefined) {
    try {
      return checkCode(ctx, verification, code);
    } catch (err) {
      if (err instanceof OrbitError && err.code === ErrorCodes.form_code_incorrect) recordFailedAttempt(ctx, user.id);
      throw err;
    }
  }

  async function notifySession(user: UserRow, sessionId: string) {
    const session = getSession(ctx, sessionId);
    if (session) await sendNewSignInEmail(ctx, user, session);
  }

  async function attemptPassword(c: Context, clientId: string, row: SignInRow, password: string | undefined) {
    const user = userForRow(row);
    if (!user.passwordHash) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account does not use a password", { param_name: "strategy" });
    if (!password) throw new OrbitError(422, ErrorCodes.form_param_missing, "password is missing", { param_name: "password" });
    if (!(await verifyPassword(user.passwordHash, password))) {
      recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_password_incorrect, "Password is incorrect", { param_name: "password", session_id: row.id });
    }
    resetFailedAttempts(ctx, user.id);
    const state = asSignInState(row);
    const saved = saveSignInState(ctx, row, { ...state, first: { strategy: "password", status: "verified" } });
    ctx.db.update(s.signIns).set({ userId: user.id, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
    const result = await afterFirstFactor(ctx, saved, user, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, clientId, reload(row.id));
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
    saveSignInState(ctx, row, { ...state, first, enterpriseConnectionId: connectionId });
    ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
  };

  // ───────────── create ─────────────
  app.post("/", async (c) => {
    const body = await parseBody(c, createSchema);
    const client = getOrCreateClient(ctx, c);
    hit(ctx, `sign_in:create:${clientIp(c)}`, 100, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    if (!ctx.settings.get().session.multiSession && client.lastActiveSessionId) {
      const active = getSession(ctx, client.lastActiveSessionId);
      if (active && active.status === "active" && active.expireAt > Date.now()) {
        const user = getUserById(ctx, active.userId);
        const email = user ? primaryEmail(ctx, user) : undefined;
        throw new OrbitError(400, ErrorCodes.identifier_already_signed_in, "You are already signed in", {
          session_id: active.id, email_addresses: email ? [email.email] : [],
        });
      }
    }
    if (body.transfer && !body.identifier && !body.strategy && !body.ticket) {
      // `signIn.create({ transfer: true })` surfaces the transferable OAuth attempt instead of replacing it.
      const transferable = latestTransferableSignIn(ctx, client.id);
      if (transferable) return respond(c, client.id, transferable);
    }
    abandonPrevious(client.id);
    const redirectUrl = validateRedirectUrl(ctx, body.redirect_url);
    const actionComplete = validateRedirectUrl(ctx, body.action_complete_redirect_url);
    const now = Date.now();
    const id = newId("sia");
    const state: SignInState = { redirectUrl: redirectUrl ?? undefined, actionCompleteRedirectUrl: actionComplete ?? undefined, azp: clientAzp(c) };
    ctx.db.insert(s.signIns).values({
      id, clientId: client.id, status: "needs_identifier", identifier: body.identifier?.trim() || null,
      state: state as Record<string, unknown>, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
    }).run();
    let row = reload(id);

    if (body.ticket) {
      const ticket = await resolveTicket(ctx, body.ticket);
      const user = getUserById(ctx, ticket.userId);
      if (!user) throw new OrbitError(422, ErrorCodes.ticket_invalid, "The ticket's user no longer exists");
      assertSignInAllowed(user);
      const ticketState: SignInState = {
        ...state,
        first: { strategy: "ticket", status: "verified" },
        actor: ticket.actor,
        sessionMaxDurationSeconds: ticket.sessionMaxDurationSeconds,
      };
      saveSignInState(ctx, row, ticketState);
      ctx.db.update(s.signIns).set({ userId: user.id, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      // A ticket proves the identity: MFA is bypassed for impersonation (Clerk actor tokens).
      const sessionId = await completeSignIn(ctx, reload(row.id), { actor: ticket.actor, maxLifetimeSeconds: ticket.sessionMaxDurationSeconds, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
      await notifySession(user, sessionId);
      return respond(c, client.id, reload(row.id));
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
      saveSignInState(ctx, row, { ...state, first: { strategy, status: "unverified", externalVerificationRedirectUrl: auth.url } });
      ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      return respond(c, client.id, reload(row.id));
    }

    if (strategy === "enterprise_sso") {
      const identifier = body.identifier?.trim();
      if (!identifier) throw new OrbitError(422, ErrorCodes.form_param_missing, "identifier is missing", { param_name: "identifier" });
      const found = getUserByIdentifier(ctx, identifier);
      const email = found ? (found.type === "email_address" ? identifier : primaryEmail(ctx, found.user)?.email) : (detectIdentifierType(identifier) === "email_address" ? identifier : undefined);
      const conn = email ? enterpriseConnectionForEmail(ctx, normalizeEmail(email)) : undefined;
      if (!conn) {
        if (found) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No enterprise SSO connection matches this account", { param_name: "strategy" });
        throw new OrbitError(422, ErrorCodes.form_identifier_not_found, "Couldn't find your account", { param_name: "identifier" });
      }
      // The account may not exist yet: domain-based routing hands the browser to the IdP regardless.
      ctx.db.update(s.signIns).set({ userId: found?.user.id ?? null, identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      await startEnterprise(reload(row.id), conn.id, identifier, state);
      return respond(c, client.id, reload(row.id));
    }

    if (!body.identifier) {
      if (strategy === "passkey") {
        // Discoverable passkey sign-in: no identifier is required until the assertion comes back.
        saveSignInState(ctx, row, { ...state, first: { strategy: "passkey", status: "unverified" } });
        ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
        return respond(c, client.id, reload(row.id));
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
      const conn = enterpriseConnectionForEmail(ctx, normalizeEmail(identifier));
      if (conn) {
        ctx.db.update(s.signIns).set({ identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
        await startEnterprise(reload(row.id), conn.id, identifier, state);
        return respond(c, client.id, reload(row.id));
      }
    }

    const found = getUserByIdentifier(ctx, identifier);
    if (!found) {
      if (ctx.settings.get().security.enumerationProtection) return respond(c, client.id, reload(row.id));
      const err = new OrbitError(422, ErrorCodes.form_identifier_not_found, "Couldn't find your account", { param_name: "identifier" });
      throw attachErrorItems(err, [
        err.toItem(),
        new OrbitError(422, ErrorCodes.form_identifier_not_found, "Sign up to create an account", { param_name: "identifier" }).toItem(),
      ]);
    }
    assertSignInAllowed(found.user);
    ctx.db.update(s.signIns).set({ userId: found.user.id, identifier, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
    row = reload(row.id);

    if (type === "email_address") {
      const conn = enterpriseConnectionForEmail(ctx, normalizeEmail(identifier));
      if (conn) {
        await startEnterprise(row, conn.id, identifier, state);
        return respond(c, client.id, reload(row.id));
      }
    }

    if (body.password && (!strategy || strategy === "password")) {
      return attemptPassword(c, client.id, row, body.password);
    }

    if (strategy && !["password", "email_code", "email_link", "phone_code", "passkey", "reset_password_email_code", "reset_password_phone_code"].includes(strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
    }

    const requestedReset = strategy === "reset_password_email_code" || strategy === "reset_password_phone_code";
    saveSignInState(ctx, row, { ...state, requestedReset, first: strategy ? { strategy, status: "unverified" } : undefined });
    ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
    return respond(c, client.id, reload(row.id));
  });

  // ───────────── read ─────────────
  app.get("/:id", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    return respond(c, client.id, row);
  });

  // ───────────── prepare first factor ─────────────
  app.post("/:id/prepare_first_factor", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    const body = await parseBody(c, prepareFirstSchema);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is already complete");
    hit(ctx, `sign_in:prepare:${clientIp(c)}`, 30, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy ?? "password";
    const user = row.userId ? getUserById(ctx, row.userId) : undefined;
    if (!user && strategy !== "passkey") throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    if (user) assertSignInAllowed(user);
    const email = body.email_address_id
      ? ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, body.email_address_id)).get()
      : user ? verifiedEmailOf(ctx, user) : undefined;
    const phone = body.phone_number_id
      ? ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, body.phone_number_id)).get()
      : user ? verifiedPhoneOf(ctx, user) : undefined;
    if (email && user && email.userId !== user.id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
    if (phone && user && phone.userId !== user.id) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
    const settings = ctx.settings.get();
    const targetEmail = email ?? (user ? primaryEmail(ctx, user) : undefined);

    const withFirst = async (first: FactorState, extra: Partial<SignInState> = {}) => {
      saveSignInState(ctx, row, { ...state, ...extra, first });
      ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      return respond(c, client.id, reload(row.id));
    };

    switch (strategy) {
      case "password":
        return withFirst({ strategy, status: "unverified" });
      case "email_code":
      case "reset_password_email_code": {
        if (!targetEmail?.verified) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "This account has no verified email address", { param_name: "strategy" });
        const issued = issueVerification(ctx, {
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
        const issued = issueVerification(ctx, {
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
        const issued = issueVerification(ctx, {
          purpose: strategy === "phone_code" ? "sign_in_first_factor" : "reset_password",
          strategy: "phone_code", identifier: phone.phone, ownerId: row.id, lifetimeSeconds: settings.email.codeLifetimeSeconds,
        });
        await sendSms(ctx, phone.phone, `Your ${settings.application.name} verification code is ${issued.code}`);
        return withFirst({ strategy, verificationId: issued.row.id, phoneId: phone.id, status: "unverified" }, { requestedReset: strategy.startsWith("reset_password") });
      }
      case "passkey": {
        const rp = relyingParty(ctx, c.req.header("origin"));
        const allowCredentials = user
          ? ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, user.id)).all().map((p) => ({ id: p.credentialId, transports: p.transports ?? undefined }))
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
          const conn = enterpriseConnectionForEmail(ctx, emailAddr);
          if (!conn) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No enterprise SSO connection matches this account");
          await startEnterprise(row, conn.id, row.identifier ?? emailAddr, state);
          return respond(c, client.id, reload(row.id));
        }
        throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
      }
    }
  });

  // ───────────── attempt first factor ─────────────
  app.post("/:id/attempt_first_factor", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    const body = await parseBody(c, attemptFirstSchema);
    if (row.status === "complete") throw new OrbitError(400, ErrorCodes.client_state_invalid, "This sign-in is already complete");
    hit(ctx, `sign_in:attempt:${clientIp(c)}`, 60, 60_000);
    const state = asSignInState(row);
    const strategy = body.strategy ?? state.first?.strategy;
    if (!strategy) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No first-factor strategy in progress", { param_name: "strategy" });
    const existingUser = row.userId ? getUserById(ctx, row.userId) : undefined;
    if (strategy !== "passkey") {
      if (!existingUser) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
      assertSignInAllowed(existingUser);
    }

    if (strategy === "password") return attemptPassword(c, client.id, row, body.password);
    if (strategy.startsWith("oauth_") || strategy === "enterprise_sso" || strategy === "ticket") {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, `Strategy "${strategy}" is completed through its redirect flow`, { param_name: "strategy" });
    }

    if (strategy === "passkey") {
      if (!body.public_key_credential) throw new OrbitError(422, ErrorCodes.form_param_missing, "public_key_credential is missing", { param_name: "public_key_credential" });
      const rp = relyingParty(ctx, c.req.header("origin"));
      const { user: authed } = await finishPasskeyAuthentication(ctx, {
        ownerId: row.id,
        rp,
        // The assertion is validated at runtime by @simplewebauthn/server.
        credential: body.public_key_credential as unknown as AuthenticationResponseJSON,
      });
      if (existingUser && authed.id !== existingUser.id) throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "That passkey belongs to another account");
      assertSignInAllowed(authed);
      ctx.db.update(s.signIns).set({ userId: authed.id, identifier: row.identifier ?? authed.username ?? null, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      const current = reload(row.id);
      const saved = saveSignInState(ctx, current, { ...asSignInState(current), first: { strategy: "passkey", status: "verified" } });
      const result = await afterFirstFactor(ctx, saved, authed, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
      if (result.sessionId) await notifySession(authed, result.sessionId);
      return respond(c, client.id, reload(row.id));
    }

    if (!existingUser) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Sign-in has no user");
    const user = existingUser;
    if (strategy === "email_link") {
      const verification = state.first?.verificationId ? getVerification(ctx, "sign_in_first_factor", row.id) : undefined;
      if (!verification || !(verification.verifiedAt || verification.consumedAt)) {
        // Cross-device polling: the link has not been clicked yet.
        return respond(c, client.id, reload(row.id));
      }
      const saved = saveSignInState(ctx, row, { ...state, first: { ...(state.first ?? { strategy }), status: "verified" } });
      const result = await afterFirstFactor(ctx, saved, user, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
      if (result.sessionId) await notifySession(user, result.sessionId);
      return respond(c, client.id, reload(row.id));
    }

    if (strategy === "reset_password_email_code" || strategy === "reset_password_phone_code") {
      const verification = getVerification(ctx, "reset_password", row.id);
      checkSignInCode(user, verification, body.code);
      const saved = saveSignInState(ctx, row, {
        ...state, first: { ...(state.first ?? { strategy }), status: "verified" }, resetPassword: { verified: true, strategy },
      });
      ctx.db.update(s.signIns).set({ status: "needs_new_password", state: saved.state as Record<string, unknown>, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
      return respond(c, client.id, reload(row.id));
    }

    if (strategy !== "email_code" && strategy !== "phone_code") {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Strategy "${strategy}" is not valid for this user`, { param_name: "strategy" });
    }
    const verification = getVerification(ctx, "sign_in_first_factor", row.id);
    checkSignInCode(user, verification, body.code);
    resetFailedAttempts(ctx, user.id);
    const saved = saveSignInState(ctx, row, { ...state, first: { ...(state.first ?? { strategy }), status: "verified" } });
    const result = await afterFirstFactor(ctx, saved, user, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, reload(row.id));
  });

  // ───────────── reset password ─────────────
  app.post("/:id/reset_password", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    const body = await parseBody(c, resetPasswordSchema);
    const state = asSignInState(row);
    // The authorization is single-use: only a live attempt that is still waiting for a new password counts.
    if (row.status !== "needs_new_password" || row.abandonAt <= Date.now() || !state.resetPassword?.verified) {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "Password reset has not been verified");
    }
    const user = userForRow(row);
    if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
    await assertPasswordValid(ctx, body.password);
    const passwordHash = await hashPassword(body.password);
    const now = Date.now();
    ctx.db.update(s.users).set({ passwordHash, passwordUpdatedAt: now, failedAttempts: 0, locked: false, lockoutExpiresAt: null, updatedAt: now }).where(eq(s.users.id, user.id)).run();
    const email = primaryEmail(ctx, user);
    if (email) {
      await sendEmail(ctx, { to: email.email, template: "password_changed", vars: { user_name: user.firstName ?? undefined } });
    }
    const signOut = body.sign_out_of_other_sessions ?? ctx.settings.get().password.signOutOfOtherSessionsOnChange;
    if (signOut) await endSessionsForUser(ctx, user.id, "revoked");
    const { resetPassword, ...rest } = state;
    const saved = saveSignInState(ctx, row, { ...rest, first: { strategy: resetPassword.strategy, status: "verified" } });
    const result = await afterFirstFactor(ctx, saved, user, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
    if (result.sessionId) await notifySession(user, result.sessionId);
    return respond(c, client.id, reload(row.id));
  });

  // ───────────── second factor ─────────────
  app.post("/:id/prepare_second_factor", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    const body = await parseBody(c, prepareSecondSchema);
    hit(ctx, `sign_in:prepare_second:${clientIp(c)}`, 30, 60_000);
    const user = userForRow(row);
    assertSignInAllowed(user);
    const state = asSignInState(row);
    if (state.first?.status !== "verified") throw new OrbitError(400, ErrorCodes.client_state_invalid, "The first factor has not been verified");
    const available = supportedSecondFactors(ctx, user);
    if (!available.length) throw new OrbitError(400, ErrorCodes.needs_second_factor, "This account has no second factor");
    const strategy = body.strategy ?? state.second?.strategy ?? available[0]!.strategy;
    if (!available.some((f) => f.strategy === strategy)) {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Second factor "${strategy}" is not available`, { param_name: "strategy" });
    }
    if (strategy === "totp") {
      if (!user.totpVerified) throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP is not enabled for this user");
      saveSignInState(ctx, row, { ...state, second: { strategy, status: "unverified" } });
    } else if (strategy === "backup_code") {
      if (!user.backupCodes?.length) throw new OrbitError(400, ErrorCodes.mfa_not_enabled, "No backup codes available");
      saveSignInState(ctx, row, { ...state, second: { strategy, status: "unverified" } });
    } else {
      const phones = verifiedSecondFactorPhones(ctx, user);
      const phone = body.phone_number_id ? phones.find((p) => p.id === body.phone_number_id) : phones.find((p) => p.defaultSecondFactor) ?? phones[0];
      if (!phone) throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, "No verified phone number for second factor");
      const settings = ctx.settings.get();
      const issued = issueVerification(ctx, {
        purpose: "sign_in_second_factor", strategy: "phone_code", identifier: phone.phone, ownerId: row.id,
        lifetimeSeconds: settings.email.codeLifetimeSeconds,
      });
      await sendSms(ctx, phone.phone, `Your ${settings.application.name} verification code is ${issued.code}`);
      saveSignInState(ctx, row, { ...state, second: { strategy, verificationId: issued.row.id, phoneId: phone.id, status: "unverified" } });
    }
    ctx.db.update(s.signIns).set({ status: "needs_second_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
    return respond(c, client.id, reload(row.id));
  });

  app.post("/:id/attempt_second_factor", async (c) => {
    const client = getOrCreateClient(ctx, c);
    const row = load(client.id, c.req.param("id"));
    const body = await parseBody(c, attemptSecondSchema);
    hit(ctx, `sign_in:attempt_second:${clientIp(c)}`, 60, 60_000);
    const user = userForRow(row);
    assertSignInAllowed(user);
    const state = asSignInState(row);
    if (row.status !== "needs_second_factor" || state.first?.status !== "verified") {
      throw new OrbitError(400, ErrorCodes.client_state_invalid, "There is no verified first factor to escalate");
    }
    const strategy = body.strategy ?? state.second?.strategy;
    if (!strategy) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No second factor in progress", { param_name: "strategy" });
    let ok = false;
    if (strategy === "totp") ok = verifyTotp(ctx, user, body.code ?? "");
    else if (strategy === "backup_code") ok = consumeBackupCode(ctx, user, body.code ?? "");
    else if (strategy === "phone_code") {
      checkSignInCode(user, getVerification(ctx, "sign_in_second_factor", row.id), body.code);
      ok = true;
    } else {
      throw new OrbitError(400, ErrorCodes.strategy_for_user_invalid, `Second factor "${strategy}" is not valid`, { param_name: "strategy" });
    }
    if (!ok) {
      recordFailedAttempt(ctx, user.id);
      throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
    }
    resetFailedAttempts(ctx, user.id);
    saveSignInState(ctx, row, { ...state, second: { ...(state.second ?? { strategy }), status: "verified" } });
    const sessionId = await completeSignIn(ctx, reload(row.id), {
      secondFactor: true,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? undefined,
    });
    await notifySession(user, sessionId);
    return respond(c, client.id, reload(row.id));
  });

  return app;
}
