// OWNER: worker "core" (W1). Sign-in state machine helpers shared by the FAPI and OAuth callbacks.
import { desc, eq } from "drizzle-orm";
import {
  ErrorCodes, OrbitError,
  type SignInFactor, type SignInJSON, type SignInStatus, type VerificationJSON,
} from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";
import { serializeUser } from "../../serializers";
import { createSession } from "../../services/sessions";
import { listPasskeys } from "../../services/passkeys";
import { listEmails, listPhones, primaryEmail, primaryPhone, type UserRow } from "../../services/users";
import { supportedSecondFactors } from "../../services/mfa";
import { listEnabledSocialProviders } from "../../services/oauth-providers";
import type { ExternalProfile } from "../../services/external-identity";
import { getVerificationById, verificationJSON } from "./verifications";
import { tolerateNotImplemented } from "./errors";
import { redeemTicket } from "../../services/restrictions";

export type SignInRow = typeof s.signIns.$inferSelect;

export interface FactorState {
  strategy: string;
  verificationId?: string;
  emailId?: string;
  phoneId?: string;
  status?: "unverified" | "verified" | "transferable" | "failed" | "expired";
  nonce?: string;
  error?: { code: string; message: string } | null;
  externalVerificationRedirectUrl?: string;
}

export interface StashedProfile extends Omit<ExternalProfile, "accessToken" | "refreshToken"> {
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
}

export interface SignInState {
  first?: FactorState;
  second?: FactorState;
  resetPassword?: { verified: boolean; strategy: string };
  actor?: Record<string, unknown>;
  sessionMaxDurationSeconds?: number;
  requestedReset?: boolean;
  transferProfile?: StashedProfile;
  enterpriseConnectionId?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
  azp?: string;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asSignInState = (row: SignInRow): SignInState => asRecord(row.state) as SignInState;

export function saveSignInState(ctx: AppContext, row: SignInRow, state: SignInState) {
  ctx.db.update(s.signIns).set({ state: state as Record<string, unknown>, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
  return { ...row, state: state as Record<string, unknown> };
}

export function factorJSON(ctx: AppContext, state: FactorState | undefined): VerificationJSON | null {
  if (!state) return null;
  if (state.verificationId) {
    const row = getVerificationById(ctx, state.verificationId);
    const json = verificationJSON(row);
    if (json) return { ...json, strategy: state.strategy, nonce: state.nonce ?? json.nonce };
  }
  return {
    status: state.status ?? "unverified",
    strategy: state.strategy,
    attempts: null,
    expire_at: null,
    error: state.error ?? null,
    nonce: state.nonce ?? null,
    external_verification_redirect_url: state.externalVerificationRedirectUrl ?? null,
  };
}

export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${(local ?? "").slice(0, 1)}${"*".repeat(Math.max(3, (local ?? "").length - 1))}@${domain}`;
};
export const maskPhone = (phone: string) => `${phone.slice(0, phone.length - 4).replace(/\d/g, "*")}${phone.slice(-4)}`;

export function verifiedEmailOf(ctx: AppContext, user: UserRow) {
  return listEmails(ctx, user.id).find((e) => e.verified);
}
export function verifiedPhoneOf(ctx: AppContext, user: UserRow) {
  return listPhones(ctx, user.id).find((p) => p.verified);
}

/** Active enterprise SSO connection whose domain matches the email, if any. */
export function enterpriseConnectionForEmail(ctx: AppContext, email: string) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return undefined;
  return ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.active, true)).all()
    .find((conn) => {
      const domains = (conn.domains ?? []).map((d) => d.toLowerCase());
      return domains.includes(domain) || (conn.allowSubdomains && domains.some((d) => domain.endsWith(`.${d}`)));
    });
}

export interface FirstFactorOptions { requestedReset?: boolean; requestedStrategy?: string }

/** Factors this user may use to sign in (Clerk's `supported_first_factors`). */
export function computeFirstFactors(ctx: AppContext, user: UserRow, opts: FirstFactorOptions = {}): SignInFactor[] {
  const st = ctx.settings.get();
  const factors: SignInFactor[] = [];
  const email = verifiedEmailOf(ctx, user) ?? primaryEmail(ctx, user);
  const phone = verifiedPhoneOf(ctx, user) ?? primaryPhone(ctx, user);

  if (st.attributes.emailAddress.enabled && st.attributes.emailAddress.usedForFirstFactor && email?.verified) {
    const strategies = st.attributes.emailAddress.verifications;
    const emailStrategies = strategies.length ? strategies : ["email_code"];
    // Code + link are both first-factor friendly; a link is offered whenever code verification is enabled.
    const linkEnabled = emailStrategies.includes("email_link") || emailStrategies.includes("email_code");
    factors.push({ strategy: "email_code", email_address_id: email.id, safe_identifier: maskEmail(email.email), primary: email.id === user.primaryEmailAddressId });
    if (linkEnabled) factors.push({ strategy: "email_link", email_address_id: email.id, safe_identifier: maskEmail(email.email), primary: email.id === user.primaryEmailAddressId });
  }
  if (user.passwordHash && st.attributes.password.enabled && st.attributes.password.usedForFirstFactor) {
    factors.push({ strategy: "password" });
  }
  if (st.attributes.phoneNumber.enabled && st.attributes.phoneNumber.usedForFirstFactor && phone?.verified) {
    factors.push({ strategy: "phone_code", phone_number_id: phone.id, safe_identifier: maskPhone(phone.phone), primary: phone.id === user.primaryPhoneNumberId });
  }
  if (st.attributes.passkey.enabled && listPasskeys(ctx, user.id).length > 0) {
    factors.push({ strategy: "passkey" });
  }
  for (const provider of listEnabledSocialProviders(ctx)) {
    if (provider.authenticatable) factors.push({ strategy: `oauth_${provider.key}` });
  }
  if (email?.verified && enterpriseConnectionForEmail(ctx, email.email)) factors.push({ strategy: "enterprise_sso" });
  if (opts.requestedReset) {
    if (email?.verified) factors.push({ strategy: "reset_password_email_code", email_address_id: email.id, safe_identifier: maskEmail(email.email) });
    if (phone?.verified) factors.push({ strategy: "reset_password_phone_code", phone_number_id: phone.id, safe_identifier: maskPhone(phone.phone) });
  }
  return factors;
}

export function supportedIdentifiers(ctx: AppContext) {
  const st = ctx.settings.get();
  const ids: ("email_address" | "phone_number" | "username")[] = [];
  if (st.attributes.emailAddress.enabled && st.attributes.emailAddress.usedForFirstFactor) ids.push("email_address");
  if (st.attributes.phoneNumber.enabled && st.attributes.phoneNumber.usedForFirstFactor) ids.push("phone_number");
  if (st.attributes.username.enabled && st.attributes.username.usedForFirstFactor) ids.push("username");
  return ids;
}

export function buildSignInJSON(ctx: AppContext, row: SignInRow): SignInJSON {
  const state = asSignInState(row);
  const user = row.userId ? ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)).get() : undefined;
  const json = user ? serializeUser(ctx, user) : null;
  const requestedReset = !!state.requestedReset || state.first?.strategy.startsWith("reset_password") === true;
  return {
    object: "sign_in",
    id: row.id,
    status: row.status as SignInStatus,
    supported_identifiers: supportedIdentifiers(ctx),
    supported_first_factors: user ? computeFirstFactors(ctx, user, { requestedReset }) : null,
    supported_second_factors: user ? supportedSecondFactors(ctx, user) : null,
    first_factor_verification: factorJSON(ctx, state.first),
    second_factor_verification: factorJSON(ctx, state.second),
    identifier: row.identifier ?? null,
    user_data: json ? { first_name: json.first_name, last_name: json.last_name, image_url: json.image_url, has_image: json.has_image } : null,
    created_session_id: row.createdSessionId ?? null,
    abandon_at: row.abandonAt,
  };
}

export interface CompleteSignInOptions {
  actor?: Record<string, unknown>;
  maxLifetimeSeconds?: number;
  ip?: string;
  userAgent?: string;
  secondFactor?: boolean;
}

/** Creates the session and marks the sign-in complete. */
export async function completeSignIn(ctx: AppContext, row: SignInRow, opts: CompleteSignInOptions = {}): Promise<string> {
  if (!row.userId) throw new OrbitError(400, ErrorCodes.client_state_invalid, "Cannot complete a sign-in without a user");
  const state = asSignInState(row);
  const sessionId = await createSession(ctx, {
    clientId: row.clientId,
    userId: row.userId,
    actor: state.actor ?? opts.actor,
    ip: opts.ip,
    userAgent: opts.userAgent,
    maxLifetimeSeconds: opts.maxLifetimeSeconds ?? state.sessionMaxDurationSeconds,
    firstFactor: true,
    secondFactor: opts.secondFactor ?? false,
  });
  const nextState: SignInState = { ...state, second: opts.secondFactor ? { ...(state.second ?? { strategy: "totp" }), status: "verified" } : state.second };
  ctx.db.update(s.signIns).set({ status: "complete", createdSessionId: sessionId, state: nextState as Record<string, unknown>, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
  return sessionId;
}

/** Decides between `needs_second_factor` and a completed session after a first factor succeeded. */
export async function afterFirstFactor(ctx: AppContext, row: SignInRow, user: UserRow, opts: CompleteSignInOptions = {}): Promise<{ status: "needs_second_factor" | "complete"; sessionId?: string }> {
  const factors = supportedSecondFactors(ctx, user);
  if (factors.length > 0) {
    const state = asSignInState(row);
    const preferred = factors.find((f) => f.default) ?? factors.find((f) => f.strategy === "totp") ?? factors[0]!;
    saveSignInState(ctx, row, { ...state, second: { strategy: preferred.strategy, phoneId: preferred.phone_number_id, status: "unverified" } });
    ctx.db.update(s.signIns).set({ status: "needs_second_factor", userId: user.id, updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
    return { status: "needs_second_factor" };
  }
  const sessionId = await completeSignIn(ctx, row, opts);
  return { status: "complete", sessionId };
}

/** Stores an OAuth profile on the sign-in so the SDK can transfer it to a sign-up. */
export function stashTransferProfile(ctx: AppContext, row: SignInRow, profile: ExternalProfile, strategy: string) {
  const state = asSignInState(row);
  const stashed: StashedProfile = {
    provider: profile.provider,
    providerUserId: profile.providerUserId,
    email: profile.email,
    emailVerified: profile.emailVerified,
    firstName: profile.firstName,
    lastName: profile.lastName,
    username: profile.username,
    imageUrl: profile.imageUrl,
    scopes: profile.scopes,
    accessTokenEnc: profile.accessToken ? encrypt(ctx.env.encryptionKey, profile.accessToken) : undefined,
    refreshTokenEnc: profile.refreshToken ? encrypt(ctx.env.encryptionKey, profile.refreshToken) : undefined,
  };
  saveSignInState(ctx, row, {
    ...state,
    first: { strategy, status: "transferable" },
    transferProfile: stashed,
  });
  ctx.db.update(s.signIns).set({ status: "needs_first_factor", updatedAt: Date.now() }).where(eq(s.signIns.id, row.id)).run();
}

/** Reads + decrypts a stashed OAuth profile. */
export function readTransferProfile(ctx: AppContext, row: SignInRow): ExternalProfile | null {
  const stashed = asSignInState(row).transferProfile;
  if (!stashed) return null;
  const { accessTokenEnc, refreshTokenEnc, ...rest } = stashed;
  return {
    ...rest,
    accessToken: accessTokenEnc ? decrypt(ctx.env.encryptionKey, accessTokenEnc) : undefined,
    refreshToken: refreshTokenEnc ? decrypt(ctx.env.encryptionKey, refreshTokenEnc) : undefined,
  };
}

/** Clears the transferable state once the SDK moved it to a sign-up. */
export function clearTransferProfile(ctx: AppContext, row: SignInRow) {
  const state = asSignInState(row);
  saveSignInState(ctx, row, { ...state, transferProfile: undefined, first: undefined });
}

export type RedeemTicketResult =
  | { kind: "sign_in_token" | "actor_token"; userId: string; actor?: Record<string, unknown>; sessionMaxDurationSeconds?: number }
  | { kind: "invitation"; invitationId: string; email: string; publicMetadata: Record<string, unknown> };

/** Validates a `ticket` (sign-in token / actor token) and returns the user + impersonation actor. */
export async function resolveTicket(ctx: AppContext, ticket: string): Promise<{ userId: string; actor?: Record<string, unknown>; sessionMaxDurationSeconds?: number }> {
  const result = await tolerateNotImplemented<RedeemTicketResult | null>(() => redeemTicket(ctx, ticket), null);
  if (!result) throw new OrbitError(422, ErrorCodes.ticket_invalid, "That ticket is not valid");
  if (result.kind === "invitation") {
    throw new OrbitError(422, ErrorCodes.ticket_invalid, "This ticket can only be used to sign up");
  }
  return { userId: result.userId, actor: result.actor, sessionMaxDurationSeconds: result.sessionMaxDurationSeconds };
}

/** Throws when the user is banned/locked (with the Clerk-compatible error codes). */
export function assertSignInAllowed(user: UserRow) {
  if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
  if (user.locked && (!user.lockoutExpiresAt || user.lockoutExpiresAt > Date.now())) {
    throw new OrbitError(403, ErrorCodes.user_locked, "This account is locked due to too many failed attempts", {
      lockout_expires_in_seconds: user.lockoutExpiresAt ? Math.ceil((user.lockoutExpiresAt - Date.now()) / 1000) : null,
    });
  }
}

export const signInBelongsToClient = (row: SignInRow, clientId: string) => row.clientId === clientId && row.status !== "abandoned";
export const latestSignInForClient = (ctx: AppContext, clientId: string) =>
  ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)).orderBy(desc(s.signIns.createdAt)).get();

/** Latest sign-in that carries a transferable OAuth profile. */
export function latestTransferableSignIn(ctx: AppContext, clientId: string) {
  return ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, clientId)).orderBy(desc(s.signIns.createdAt)).all()
    .find((row) => !!asSignInState(row).transferProfile);
}
