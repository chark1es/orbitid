/** Closures shared by the sign-in route groups: state loading, client responses, and factor completion. */
import { type Context } from "hono";
import type { AppContext } from "../../context";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { clientIp } from "../../lib/http";
import { verifyPassword } from "../../services/passwords";
import { getSession, sendNewSignInEmail } from "../../services/sessions";
import { applyTrustedDeviceCookie, readTrustedDeviceToken } from "../../services/trusted-devices";
import { getUserById, recordFailedAttempt, resetFailedAttempts, type UserRow } from "../../services/users";
import { clientAzp, rotateClientTokenOnSignIn, serializeClient } from "../auth/client-auth";
import { afterFirstFactor, asSignInState, buildSignInJSON, computeFirstFactors, saveSignInState, type FactorState, type SignInState } from "../auth/signin-core";
import { checkCode, type VerificationRow } from "../auth/verifications";
import { first } from "../../lib/db";
import { spendPasswordCheck, type SignInRow } from "./shared";

const unused = 0;

export function createSignInHelpers(ctx: AppContext) {
  const respond = async (c: Context, clientId: string, row: SignInRow) => {
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, clientId)))!;
    const clientJson = await serializeClient(ctx, client, { azp: clientAzp(c), mintTokens: true });
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

  /** Persist the trusted-device cookie outcome of a first-factor verification. */
  function applyTrustedDevice(c: Context, result: { trustedDeviceToken?: string; trustedDeviceExpiresAt?: number; clearTrustedDevice?: boolean }) {
    applyTrustedDeviceCookie(c, ctx, result);
  }

  /** Runs the post-first-factor step and keeps the trusted-device cookie in sync. */
  async function afterFirst(c: Context, clientId: string, row: Awaited<ReturnType<typeof saveSignInState>>, user: UserRow) {
    const result = await afterFirstFactor(ctx, row, user, { ...completionOpts(c, clientId), trustedDeviceToken: readTrustedDeviceToken(c) });
    applyTrustedDevice(c, result);
    return result;
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
    const result = await afterFirst(c, clientId, saved, user);
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

  return {
    respond, completionOpts, reload, load, abandonPrevious, userForRow, checkSignInCode, notifySession,
    applyTrustedDevice, afterFirst, assertFirstFactorEnabled, attemptPassword, startEnterprise,
  };
}

export type SignInHelpers = ReturnType<typeof createSignInHelpers>;
