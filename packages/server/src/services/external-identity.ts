// Shared by social OAuth and enterprise SAML/OIDC.
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { encrypt } from "../lib/crypto";
import { createSession } from "./sessions";
import { findEmail, findUserByVerifiedEmail, getUserById, upgradeAnonymousUser, type UserRow } from "./users";
import {
  afterFirstFactor, asSignInState, assertSignInAllowed, saveSignInState, stashTransferProfile,
} from "../modules/auth/signin-core";
import { applyExternalProfile, assertSignUpIdentifiers, maybeCompleteSignUp } from "../modules/auth/signup-core";
import { withQuery } from "../modules/auth/redirects";
import { assertIdentifiersAllowed } from "./restrictions";
import { first } from "../lib/db";

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
  /** Presented `__orbit_trusted` token: a valid one skips the second factor for this browser. */
  trustedDeviceToken?: string;
}

const successStatus = (status: string) => ({ __orbit_status: status });

/** Sign-in must honour the instance blocklist (OAuth flows have no identifier at create time). */
async function assertSignInIdentityAllowed(ctx: AppContext, email: string | undefined) {
  if (!email) return;
  await assertIdentifiersAllowed(ctx, { emails: [email] }, { signIn: true });
}

/** Hides stale, still-in-flight attempts once a flow finished (they belong to another sign-in/up). */
async function abandonOtherAttempts(ctx: AppContext, clientId: string, kind: "sign_in" | "sign_up", exceptId: string) {
  const now = Date.now();
  if (kind === "sign_in") {
    for (const row of (await ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)))) {
      if (row.id !== exceptId && row.status !== "complete" && row.status !== "abandoned") {
        await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: now }).where(eq(s.signIns.id, row.id));
      }
    }
    return;
  }
  for (const row of (await ctx.db.select().from(s.signUps).where(eq(s.signUps.clientId, clientId)))) {
    if (row.id !== exceptId && row.status !== "complete" && row.status !== "abandoned") {
      await ctx.db.update(s.signUps).set({ status: "abandoned", updatedAt: now }).where(eq(s.signUps.id, row.id));
    }
  }
}
const isEnterprise = (provider: string) => provider.startsWith("enterprise_");
const signInStrategyFor = (provider: string) => (isEnterprise(provider) ? "enterprise_sso" : `oauth_${provider}`);

/** Creates or refreshes the external_account row and links it to `userId`. */
export async function linkExternalAccount(ctx: AppContext, userId: string, profile: ExternalProfile) {
  const now = Date.now();
  const accessTokenEnc = profile.accessToken ? encrypt(ctx.env.encryptionKey, profile.accessToken) : null;
  const refreshTokenEnc = profile.refreshToken ? encrypt(ctx.env.encryptionKey, profile.refreshToken) : null;
  const existing = first(await ctx.db.select().from(s.externalAccounts)
      .where(and(eq(s.externalAccounts.provider, profile.provider), eq(s.externalAccounts.providerUserId, profile.providerUserId))));
  if (existing) {
    const owner = existing.userId;
    if (owner && owner !== userId) {
      throw new OrbitError(409, ErrorCodes.external_account_exists, "This external account is already linked to another user");
    }
    await ctx.db.update(s.externalAccounts).set({
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
                }).where(eq(s.externalAccounts.id, existing.id));
    return first(await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.id, existing.id)))!;
  }
  const id = newId("eac");
  await ctx.db.insert(s.externalAccounts).values({
            id, userId, provider: profile.provider, providerUserId: profile.providerUserId,
            emailAddress: profile.email ?? "", firstName: profile.firstName ?? "", lastName: profile.lastName ?? "",
            username: profile.username ?? null, imageUrl: profile.imageUrl ?? null, approvedScopes: profile.scopes ?? "",
            accessTokenEnc, refreshTokenEnc, tokenExpiresAt: profile.expiresAt ?? null, createdAt: now, updatedAt: now,
          });
  return first(await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.id, id)))!;
}

async function signInExistingUser(ctx: AppContext, flow: ExternalIdentityFlow, user: UserRow, profile: ExternalProfile): Promise<ExternalIdentityResult> {
  assertSignInAllowed(user);
  let ownerId = flow.ownerId;
  if (!ownerId) {
    // Enterprise callbacks may not have a sign-in row: create one so the SDK gets a complete resource.
    const now = Date.now();
    ownerId = newId("sia");
    await ctx.db.insert(s.signIns).values({
                  id: ownerId, clientId: flow.clientId, status: "needs_first_factor", identifier: profile.email ?? null, userId: user.id,
                  state: { first: { strategy: signInStrategyFor(profile.provider), status: "verified" } }, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
                });
  }
  const row = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, ownerId)));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
  const state = asSignInState(row);
  await saveSignInState(ctx, row, {
        ...state,
        first: { strategy: signInStrategyFor(profile.provider), status: "verified" },
      });
  await ctx.db.update(s.signIns).set({ userId: user.id, identifier: row.identifier ?? profile.email ?? null, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id));
  const updated = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, row.id)))!;
  // A remembered browser skips the second factor here too; the callback rotates the cookie.
  const result = await afterFirstFactor(ctx, updated, user, { trustedDeviceToken: flow.trustedDeviceToken });
  await abandonOtherAttempts(ctx, flow.clientId, "sign_in", updated.id);
  const target = flow.actionCompleteRedirectUrl || flow.redirectUrl;
  return {
    redirectTo: withQuery(target, successStatus(result.status === "complete" ? "complete" : "needs_second_factor")),
    trustedDeviceToken: result.trustedDeviceToken,
    trustedDeviceExpiresAt: result.trustedDeviceExpiresAt,
    clearTrustedDevice: result.clearTrustedDevice,
  };
}

/** An OAuth sign-up that matched an existing user is a sign-in, so that user's second factor still applies. */
async function completeSignUpForExistingUser(ctx: AppContext, flow: ExternalIdentityFlow, signUpId: string, user: UserRow, profile: ExternalProfile): Promise<ExternalIdentityResult> {
  await ctx.db.update(s.signUps).set({ status: "abandoned", updatedAt: Date.now() }).where(eq(s.signUps.id, signUpId));
  return signInExistingUser(ctx, { ...flow, kind: "sign_in", ownerId: undefined }, user, profile);
}

/**
 * Resolve an authenticated external identity inside a client's flow.
 *  - Existing external_account → complete the sign-in (creates session, handles MFA requirement → needs_second_factor).
 *  - Verified email matches an existing user → link & sign in (per settings).
 *  - Otherwise → create/advance sign_up (transferable) and complete if requirements satisfied.
 * `flow.kind === "connect"` links to flow.userId instead. Returns the redirect URL the browser should be sent to,
 * plus a rotated trusted-device token when a remembered browser skipped the second factor.
 */
export interface ExternalIdentityResult {
  redirectTo: string;
  /** Rotated `__orbit_trusted` value to set on the response, if a remembered browser was used. */
  trustedDeviceToken?: string;
  trustedDeviceExpiresAt?: number;
  /** The presented device token was stale: clear the cookie. */
  clearTrustedDevice?: boolean;
}

export async function handleExternalIdentity(
  ctx: AppContext,
  flow: ExternalIdentityFlow,
  profile: ExternalProfile,
): Promise<ExternalIdentityResult> {
  try {
    return await resolveExternalIdentity(ctx, flow, profile);
  } catch (err) {
    if (err instanceof OrbitError) {
      const target = flow.actionCompleteRedirectUrl || flow.redirectUrl;
      return { redirectTo: withQuery(target, { __orbit_error: err.code, __orbit_error_message: err.message }) };
    }
    throw err;
  }
}

async function resolveExternalIdentity(
  ctx: AppContext,
  flow: ExternalIdentityFlow,
  profile: ExternalProfile,
): Promise<ExternalIdentityResult> {
  const account = first(await ctx.db.select().from(s.externalAccounts)
      .where(and(eq(s.externalAccounts.provider, profile.provider), eq(s.externalAccounts.providerUserId, profile.providerUserId))));

  if (flow.kind === "connect") {
    if (!flow.userId) throw new OrbitError(400, ErrorCodes.client_state_invalid, "No user to connect the account to");
    if (account?.userId && account.userId !== flow.userId) {
      throw new OrbitError(409, ErrorCodes.external_account_exists, "This external account is already linked to another user");
    }
    const linked = await linkExternalAccount(ctx, flow.userId, profile);
    // Connecting an account gives a guest a way to sign in again.
    await upgradeAnonymousUser(ctx, flow.userId);
    return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, { __orbit_status: "connected", external_account_id: linked.id }) };
  }

  if (flow.kind === "sign_up") {
    let ownerId = flow.ownerId;
    if (!ownerId) {
      const now = Date.now();
      ownerId = newId("sua");
      await ctx.db.insert(s.signUps).values({
                            id: ownerId, clientId: flow.clientId, status: "missing_requirements",
                            fields: {}, unsafeMetadata: {}, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
                          });
    }
    const signUp = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, ownerId)));
    if (!signUp) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-up not found");
    const existingUser = account?.userId ? await getUserById(ctx, account.userId) : undefined;
    if (existingUser) {
      await assertSignInIdentityAllowed(ctx, profile.email);
      await linkExternalAccount(ctx, existingUser.id, profile);
      return completeSignUpForExistingUser(ctx, flow, signUp.id, existingUser, profile);
    }
    const verifiedEmailUser = profile.email && profile.emailVerified ? await findUserByVerifiedEmail(ctx, profile.email) : undefined;
    if (verifiedEmailUser) {
      await assertSignInIdentityAllowed(ctx, profile.email);
      await linkExternalAccount(ctx, verifiedEmailUser.id, profile);
      return completeSignUpForExistingUser(ctx, flow, signUp.id, verifiedEmailUser, profile);
    }
    // Signing up with an email that belongs to an existing account must not create a duplicate.
    if (profile.email) {
      const claimed = await findEmail(ctx, profile.email);
      if (claimed?.userId) {
        throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use");
      }
    }
    if (profile.email) await assertSignUpIdentifiers(ctx, { emailAddress: profile.email });
    await applyExternalProfile(ctx, signUp, profile);
    const row = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, signUp.id)))!;
    const completed = await maybeCompleteSignUp(ctx, row, {});
    if (completed) await abandonOtherAttempts(ctx, flow.clientId, "sign_up", signUp.id);
    return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, successStatus(completed ? "complete" : "missing_requirements")) };
  }

  // kind === "sign_in"
  await assertSignInIdentityAllowed(ctx, profile.email);
  const existingUser = account?.userId ? await getUserById(ctx, account.userId) : undefined;
  if (existingUser) {
    await linkExternalAccount(ctx, existingUser.id, profile);
    return signInExistingUser(ctx, flow, existingUser, profile);
  }
  if (account && !account.userId) {
    // Orphaned link (no user): behave like a fresh sign-in.
    await ctx.db.delete(s.externalAccounts).where(eq(s.externalAccounts.id, account.id));
  }

  const verifiedEmailUser = profile.email && profile.emailVerified ? await findUserByVerifiedEmail(ctx, profile.email) : undefined;
  if (verifiedEmailUser) {
    await linkExternalAccount(ctx, verifiedEmailUser.id, profile);
    return signInExistingUser(ctx, flow, verifiedEmailUser, profile);
  }

  // No account: make the sign-in transferable to a sign-up.
  let ownerId = flow.ownerId;
  if (!ownerId) {
    const now = Date.now();
    ownerId = newId("sia");
    await ctx.db.insert(s.signIns).values({
                      id: ownerId, clientId: flow.clientId, status: "needs_first_factor", identifier: profile.email ?? null,
                      state: {}, abandonAt: now + 86_400_000, createdAt: now, updatedAt: now,
                    });
  }
  const row = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, ownerId)));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Sign-in not found");
  await stashTransferProfile(ctx, row, profile, signInStrategyFor(profile.provider));
  await abandonOtherAttempts(ctx, flow.clientId, "sign_in", row.id);
  return { redirectTo: withQuery(flow.actionCompleteRedirectUrl || flow.redirectUrl, successStatus("transferable")) };
}
