// Shared by social OAuth and enterprise SAML/OIDC.
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { encrypt } from "../lib/crypto";
import { createSession } from "./sessions";
import { findEmail, findUserByVerifiedEmail, getUserById, type UserRow } from "./users";
import {
  afterFirstFactor, asSignInState, assertSignInAllowed, saveSignInState, stashTransferProfile,
} from "../modules/auth/signin-core";
import { applyExternalProfile, assertSignUpIdentifiers, maybeCompleteSignUp } from "../modules/auth/signup-core";
import { withQuery } from "../modules/auth/redirects";
import { assertIdentifiersAllowed } from "./restrictions";

export interface ExternalProfile {
  provider: string; // "google" | "github" | "saml_<connId>" | "oidc_<connId>"
  providerUserId: string;
  email?: string; emailVerified?: boolean;
  firstName?: string; lastName?: string; username?: string; imageUrl?: string;
  accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string;
  raw?: Record<string, unknown>;
}

export interface ExternalIdentityFlow {
  clientId: string;
  kind: "sign_in" | "sign_up" | "connect";
  ownerId?: string;
  userId?: string;
  redirectUrl: string;
  actionCompleteRedirectUrl?: string;
}

const successStatus = (status: string) => ({ __orbit_status: status });

/** Sign-in must honour the instance blocklist (OAuth flows have no identifier at create time). */
async function assertSignInIdentityAllowed(ctx: AppContext, email: string | undefined) {
  if (!email) return;
  await assertIdentifiersAllowed(ctx, { emails: [email] }, { signIn: true });
}

/** Hides stale, still-in-flight attempts once a flow finished (they belong to another sign-in/up). */
function abandonOtherAttempts(ctx: AppContext, clientId: string, kind: "sign_in" | "sign_up", exceptId: string) {
  const now = Date.now();
  if (kind === "sign_in") {
    for (const row of ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)).all()) {
      if (row.id !== exceptId && row.status !== "complete" && row.status !== "abandoned") {
        ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: now }).where(eq(s.signIns.id, row.id)).run();
      }
    }
    return;
  }
  for (const row of ctx.db.select().from(s.signUps).where(eq(s.signUps.clientId, clientId)).all()) {
    if (row.id !== exceptId && row.status !== "complete" && row.status !== "abandoned") {
      ctx.db.update(s.signUps).set({ status: "abandoned", updatedAt: now }).where(eq(s.signUps.id, row.id)).run();
    }
  }
}
const isEnterprise = (provider: string) => provider.startsWith("enterprise_");
const signInStrategyFor = (provider: string) => (isEnterprise(provider) ? "enterprise_sso" : `oauth_${provider}`);

/** Creates or refreshes the external_account row and links it to `userId`. */
export function linkExternalAccount(ctx: AppContext, userId: string, profile: ExternalProfile) {
  const now = Date.now();
  const accessTokenEnc = profile.accessToken ? encrypt(ctx.env.encryptionKey, profile.accessToken) : null;
  const refreshTokenEnc = profile.refreshToken ? encrypt(ctx.env.encryptionKey, profile.refreshToken) : null;
  const existing = ctx.db.select().from(s.externalAccounts)
    .where(and(eq(s.externalAccounts.provider, profile.provider), eq(s.externalAccounts.providerUserId, profile.providerUserId)))
    .get();
  if (existing) {
    const owner = existing.userId;
    if (owner && owner !== userId) {
      throw new OrbitError(409, ErrorCodes.external_account_exists, "This external account is already linked to another user");
    }
    ctx.db.update(s.externalAccounts).set({
      userId,
      emailAddress: profile.email ?? existing.emailAddress,
      firstName: profile.firstName ?? existing.firstName,
      lastName: profile.lastName ?? existing.lastName,
      username: profile.username ?? existing.username,
      imageUrl: profile.imageUrl ?? existing.imageUrl,
      approvedScopes: profile.scopes ?? existing.approvedScopes,
      accessTokenEnc: accessTokenEnc ?? existing.accessTokenEnc,
      refreshTokenEnc: refreshTokenEnc ?? existing.refreshTokenEnc,
      tokenExpiresAt: profile.expiresAt ?? existing.tokenExpiresAt,
      updatedAt: now,
    }).where(eq(s.externalAccounts.id, existing.id)).run();
    return ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.id, existing.id)).get()!;
  }
  const id = newId("eac");
  ctx.db.insert(s.externalAccounts).values({
    id, userId, provider: profile.provider, providerUserId: profile.providerUserId,
    emailAddress: profile.email ?? "", firstName: profile.firstName ?? "", lastName: profile.lastName ?? "",
    username: profile.username ?? null, imageUrl: profile.imageUrl ?? null, approvedScopes: profile.scopes ?? "",
    accessTokenEnc, refreshTokenEnc, tokenExpiresAt: profile.expiresAt ?? null, createdAt: now, updatedAt: now,
  }).run();
  return ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.id, id)).get()!;
}

async function signInExistingUser(ctx: AppContext, flow: ExternalIdentityFlow, user: UserRow, profile: ExternalProfile): Promise<{ redirectTo: string }> {
  assertSignInAllowed(user);
  let ownerId = flow.ownerId;
  if (!ownerId) {
    // Enterprise callbacks may not have a sign-in row: create one so the SDK gets a complete resource.
    const now = Date.now();
    ownerId = newId("sia");
    ctx.db.insert(s.signIns).values({
      id: ownerId, clientId: flow.clientId, status: "needs_first_factor", identifier: profile.email ?? null, userId: user.id,
      state: { first: { strategy: signInStrategyFor(profile.provider), status: "verified" } }, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
    }).run();
  }
  const row = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, ownerId)).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
  const state = asSignInState(row);
  saveSignInState(ctx, row, {
    ...state,
    first: { strategy: signInStrategyFor(profile.provider), status: "verified" },
  });
  ctx.db.update(s.signIns).set({ userId: user.id, identifier: row.identifier ?? profile.email ?? null, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
  const updated = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, row.id)).get()!;
  const result = await afterFirstFactor(ctx, updated, user, {});
  abandonOtherAttempts(ctx, flow.clientId, "sign_in", updated.id);
  const target = flow.actionCompleteRedirectUrl || flow.redirectUrl;
  return { redirectTo: withQuery(target, successStatus(result.status === "complete" ? "complete" : "needs_second_factor")) };
}

/** Completes a sign-up-owned OAuth flow for a user that already exists (OAuth account matched). */
async function completeSignUpForExistingUser(ctx: AppContext, flow: ExternalIdentityFlow, signUpId: string, user: UserRow): Promise<{ redirectTo: string }> {
  assertSignInAllowed(user);
  const sessionId = await createSession(ctx, { clientId: flow.clientId, userId: user.id, firstFactor: true });
  ctx.db.update(s.signUps).set({ status: "complete", createdUserId: user.id, createdSessionId: sessionId, updatedAt: Date.now() }).where(eq(s.signUps.id, signUpId)).run();
  abandonOtherAttempts(ctx, flow.clientId, "sign_up", signUpId);
  return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, successStatus("complete")) };
}

/**
 * Resolve an authenticated external identity inside a client's flow.
 *  - Existing external_account → complete the sign-in (creates session, handles MFA requirement → needs_second_factor).
 *  - Verified email matches an existing user → link & sign in (per settings).
 *  - Otherwise → create/advance sign_up (transferable) and complete if requirements satisfied.
 * `flow.kind === "connect"` links to flow.userId instead. Returns the redirect URL the browser should be sent to.
 */
export async function handleExternalIdentity(
  ctx: AppContext,
  flow: ExternalIdentityFlow,
  profile: ExternalProfile,
): Promise<{ redirectTo: string }> {
  try {
    const account = ctx.db.select().from(s.externalAccounts)
      .where(and(eq(s.externalAccounts.provider, profile.provider), eq(s.externalAccounts.providerUserId, profile.providerUserId)))
      .get();

    if (flow.kind === "connect") {
      if (!flow.userId) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No user to connect the account to");
      if (account?.userId && account.userId !== flow.userId) {
        throw new OrbitError(409, ErrorCodes.external_account_exists, "This external account is already linked to another user");
      }
      const linked = linkExternalAccount(ctx, flow.userId, profile);
      return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, { __orbit_status: "connected", external_account_id: linked.id }) };
    }

    if (flow.kind === "sign_up") {
      let ownerId = flow.ownerId;
      if (!ownerId) {
        const now = Date.now();
        ownerId = newId("sua");
        ctx.db.insert(s.signUps).values({
          id: ownerId, clientId: flow.clientId, status: "missing_requirements",
          fields: {}, unsafeMetadata: {}, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
        }).run();
      }
      const signUp = ctx.db.select().from(s.signUps).where(eq(s.signUps.id, ownerId)).get();
      if (!signUp) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
      const existingUser = account?.userId ? getUserById(ctx, account.userId) : undefined;
      if (existingUser) {
        await assertSignInIdentityAllowed(ctx, profile.email);
        linkExternalAccount(ctx, existingUser.id, profile);
        return completeSignUpForExistingUser(ctx, flow, signUp.id, existingUser);
      }
      const verifiedEmailUser = profile.email && profile.emailVerified ? findUserByVerifiedEmail(ctx, profile.email) : undefined;
      if (verifiedEmailUser) {
        await assertSignInIdentityAllowed(ctx, profile.email);
        linkExternalAccount(ctx, verifiedEmailUser.id, profile);
        return completeSignUpForExistingUser(ctx, flow, signUp.id, verifiedEmailUser);
      }
      // Signing up with an email that belongs to an existing account must not create a duplicate.
      if (profile.email) {
        const claimed = findEmail(ctx, profile.email);
        if (claimed?.userId) {
          throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use");
        }
      }
      if (profile.email) await assertSignUpIdentifiers(ctx, { emailAddress: profile.email });
      applyExternalProfile(ctx, signUp, profile);
      const row = ctx.db.select().from(s.signUps).where(eq(s.signUps.id, signUp.id)).get()!;
      const completed = await maybeCompleteSignUp(ctx, row, {});
      if (completed) abandonOtherAttempts(ctx, flow.clientId, "sign_up", signUp.id);
      return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, successStatus(completed ? "complete" : "missing_requirements")) };
    }

    // kind === "sign_in"
    await assertSignInIdentityAllowed(ctx, profile.email);
    const existingUser = account?.userId ? getUserById(ctx, account.userId) : undefined;
    if (existingUser) {
      linkExternalAccount(ctx, existingUser.id, profile);
      return signInExistingUser(ctx, flow, existingUser, profile);
    }
    if (account && !account.userId) {
      // Orphaned link (no user): behave like a fresh sign-in.
      ctx.db.delete(s.externalAccounts).where(eq(s.externalAccounts.id, account.id)).run();
    }

    const verifiedEmailUser = profile.email && profile.emailVerified ? findUserByVerifiedEmail(ctx, profile.email) : undefined;
    if (verifiedEmailUser) {
      linkExternalAccount(ctx, verifiedEmailUser.id, profile);
      return signInExistingUser(ctx, flow, verifiedEmailUser, profile);
    }

    // No account: make the sign-in transferable to a sign-up (Clerk behaviour).
    let ownerId = flow.ownerId;
    if (!ownerId) {
      const now = Date.now();
      ownerId = newId("sia");
      ctx.db.insert(s.signIns).values({
        id: ownerId, clientId: flow.clientId, status: "needs_first_factor", identifier: profile.email ?? null,
        state: {}, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
      }).run();
    }
    const row = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, ownerId)).get();
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
    stashTransferProfile(ctx, row, profile, signInStrategyFor(profile.provider));
    abandonOtherAttempts(ctx, flow.clientId, "sign_in", row.id);
    return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, successStatus("transferable")) };
  } catch (err) {
    if (err instanceof OrbitError) {
      const target = flow.actionCompleteRedirectUrl || flow.redirectUrl;
      return { redirectTo: withQuery(target, { __orbit_error: err.code, __orbit_error_message: err.message }) };
    }
    throw err;
  }
}
