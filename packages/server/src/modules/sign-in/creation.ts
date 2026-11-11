/** Create, read, and identifier resolution for a sign-in. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { clientIp, parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { getSession, isSessionExpired } from "../../services/sessions";
import { verifyCaptcha } from "../../services/captcha";
import { detectIdentifierType, getUserById, getUserByIdentifier, normalizeEmail, normalizePhone, primaryEmail } from "../../services/users";
import { assertIdentifiersAllowed } from "../../services/restrictions";
import { isProviderEnabled, providerKeyFromStrategy } from "../../services/oauth-providers";
import { clientAzp, getOrCreateClient } from "../auth/client-auth";
import { assertSignInAllowed, enterpriseConnectionForEmail, latestTransferableSignIn, resolveTicket, saveSignInState, type SignInState } from "../auth/signin-core";
import { createOAuthAuthorization } from "../auth/oauth-flow";
import { validateRedirectUrl } from "../auth/redirects";
import { attachErrorItems } from "../auth/errors";
import { first } from "../../lib/db";
import { createSchema, captchaToken } from "./shared";
import { spendPasswordCheck } from "./shared";
import type { SignInHelpers } from "./helpers";

export function registerCreationRoutes(app: Hono, ctx: AppContext, helpers: SignInHelpers) {
  const { respond, reload, load, abandonPrevious, assertFirstFactorEnabled, attemptPassword, startEnterprise } = helpers;

  // ───────────── create ─────────────
  app.post("/", async (c) => {
    const body = await parseBody(c, createSchema);
    const client = await getOrCreateClient(ctx, c);
    await hit(ctx, `sign_in:create:${clientIp(c)}`, 100, 60_000);
    await verifyCaptcha(ctx, captchaToken(c, body), clientIp(c));
    if (!ctx.settings.get().session.multiSession && client.lastActiveSessionId) {
      const active = await getSession(ctx, client.lastActiveSessionId);
      if (active && active.status === "active" && !isSessionExpired(ctx, active)) {
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
      // Operator-minted sign-in and impersonation tickets were removed; `resolveTicket` always throws, so the
      // only way into a session is the account's own credentials (and its MFA policy).
      resolveTicket(ctx, body.ticket);
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
}
