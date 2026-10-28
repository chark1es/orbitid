// Sign-up requirement computation, serialization and completion.
import { and, eq } from "drizzle-orm";
import {
  ErrorCodes, OrbitError,
  type SignUpJSON, type SignUpStatus, type VerificationJSON,
} from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { encrypt } from "../../lib/crypto";
import { createSession } from "../../services/sessions";
import { createUser, findEmail, normalizeEmail, type UserRow } from "../../services/users";
import { markInvitationAccepted, assertIdentifiersAllowed } from "../../services/restrictions";
import type { ExternalProfile } from "../../services/external-identity";
import { getVerificationById, verificationJSON } from "./verifications";
import { first } from "../../lib/db";

export type SignUpRow = typeof s.signUps.$inferSelect;

export interface StashedExternalAccount {
  provider: string;
  providerUserId: string;
  emailAddress: string;
  firstName: string;
  lastName: string;
  username: string | null;
  imageUrl: string | null;
  approvedScopes: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  tokenExpiresAt?: number;
}

export interface SignUpFields {
  emailAddress?: string;
  phoneNumber?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  passwordHash?: string;
  externalId?: string | null;
  legalAcceptedAt?: number | null;
  externalAccount?: StashedExternalAccount;
}

export interface VerificationSnapshot {
  verificationId?: string;
  status: "unverified" | "verified" | "transferable" | "failed" | "expired";
  strategy: string;
  attempts?: number | null;
  expireAt?: number | null;
  identifier?: string;
  externalVerificationRedirectUrl?: string;
}

export interface SignUpVerifications {
  email_address?: VerificationSnapshot;
  phone_number?: VerificationSnapshot;
  external_account?: VerificationSnapshot;
  web3_wallet?: VerificationSnapshot;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asSignUpFields = (row: SignUpRow): SignUpFields => asRecord(row.fields) as SignUpFields;
export const asSignUpVerifications = (row: SignUpRow): SignUpVerifications => asRecord(row.verifications) as SignUpVerifications;

export async function snapshotJSON(ctx: AppContext, snapshot: VerificationSnapshot | undefined): Promise<VerificationJSON | null> {
  if (!snapshot) return null;
  if (snapshot.verificationId) {
    const json = verificationJSON(await getVerificationById(ctx, snapshot.verificationId));
    if (json) return { ...json, strategy: snapshot.strategy };
  }
  return {
    status: snapshot.status,
    strategy: snapshot.strategy,
    attempts: snapshot.attempts ?? null,
    expire_at: snapshot.expireAt ?? null,
    error: snapshot.status === "expired" ? { code: ErrorCodes.verification_expired, message: "Verification expired" } : null,
    nonce: null,
    external_verification_redirect_url: snapshot.externalVerificationRedirectUrl ?? null,
  };
}

const verificationStrategyFor = (provider: string) => (provider.startsWith("enterprise_") ? "enterprise_sso" : `from_oauth_${provider}`);

const fieldValue = (fields: SignUpFields, kind: "email_address" | "phone_number" | "username" | "first_name" | "last_name" | "password"): string | undefined => {
  switch (kind) {
    case "email_address": return fields.emailAddress;
    case "phone_number": return fields.phoneNumber;
    case "username": return fields.username;
    case "first_name": return fields.firstName;
    case "last_name": return fields.lastName;
    case "password": return fields.passwordHash;
  }
};

export interface SignUpRequirements {
  required_fields: string[];
  optional_fields: string[];
  missing_fields: string[];
  unverified_fields: string[];
}

/** Computes Clerk-style required/optional/missing/unverified field lists from instance settings. */
export function computeRequirements(ctx: AppContext, fields: SignUpFields, verifications: SignUpVerifications): SignUpRequirements {
  const st = ctx.settings.get();
  const attrs = st.attributes;
  const entries = [
    { kind: "email_address" as const, attr: attrs.emailAddress },
    { kind: "phone_number" as const, attr: attrs.phoneNumber },
    { kind: "username" as const, attr: attrs.username },
    { kind: "first_name" as const, attr: attrs.firstName },
    { kind: "last_name" as const, attr: attrs.lastName },
    { kind: "password" as const, attr: attrs.password },
  ];
  const required: string[] = [];
  const optional: string[] = [];
  const missing: string[] = [];
  const unverified: string[] = [];
  if (st.signUp.legalConsentRequired) {
    required.push("legal_accepted");
    if (!fields.legalAcceptedAt) missing.push("legal_accepted");
  }
  for (const { kind, attr } of entries) {
    if (!attr.enabled) continue;
    if (attr.required) required.push(kind);
    else optional.push(kind);
    const value = fieldValue(fields, kind);
    const present = typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
    if (attr.required && !present) {
      missing.push(kind);
      continue;
    }
    if (!present) continue;
    if (kind !== "email_address" && kind !== "phone_number") continue;
    if (!attr.verifyAtSignUp) continue;
    const verified = kind === "email_address" ? emailIsVerified(fields, verifications) : verifications.phone_number?.status === "verified";
    if (!verified) unverified.push(kind);
  }
  return { required_fields: required, optional_fields: optional, missing_fields: missing, unverified_fields: unverified };
}

/**
 * An email counts as verified only when the verified snapshot was issued for the address that is on the
 * sign-up now: a code, link or OAuth profile for one mailbox must never vouch for another.
 */
export function emailIsVerified(fields: SignUpFields, verifications: SignUpVerifications): boolean {
  const snapshot = verifications.email_address;
  return snapshot?.status === "verified" && !!fields.emailAddress && snapshot.identifier === fields.emailAddress;
}

export async function buildSignUpJSON(ctx: AppContext, row: SignUpRow): Promise<SignUpJSON> {
  const fields = asSignUpFields(row);
  const verifications = asSignUpVerifications(row);
  const req = computeRequirements(ctx, fields, verifications);
  return {
    object: "sign_up",
    id: row.id,
    status: row.status as SignUpStatus,
    required_fields: req.required_fields,
    optional_fields: req.optional_fields,
    missing_fields: req.missing_fields,
    unverified_fields: req.unverified_fields,
    verifications: {
      email_address: await snapshotJSON(ctx, verifications.email_address),
      phone_number: await snapshotJSON(ctx, verifications.phone_number),
      external_account: await snapshotJSON(ctx, verifications.external_account),
      web3_wallet: await snapshotJSON(ctx, verifications.web3_wallet),
    },
    username: fields.username ?? null,
    email_address: fields.emailAddress ?? null,
    phone_number: fields.phoneNumber ?? null,
    first_name: fields.firstName ?? null,
    last_name: fields.lastName ?? null,
    password_enabled: !!fields.passwordHash,
    unsafe_metadata: row.unsafeMetadata,
    public_metadata: {},
    custom_action: false,
    external_id: fields.externalId ?? null,
    created_session_id: row.createdSessionId ?? null,
    created_user_id: row.createdUserId ?? null,
    abandon_at: row.abandonAt,
    legal_accepted_at: fields.legalAcceptedAt ?? null,
  };
}

export async function saveSignUp(ctx: AppContext, row: SignUpRow, patch: Partial<{ fields: SignUpFields; verifications: SignUpVerifications; status: string; unsafeMetadata: Record<string, unknown>; invitationId: string | null; orgInvitationId: string | null }>) {
  const set: Partial<typeof s.signUps.$inferInsert> = { updatedAt: Date.now() };
  if (patch.fields) set.fields = patch.fields as Record<string, unknown>;
  if (patch.verifications) set.verifications = patch.verifications as Record<string, unknown>;
  if (patch.status) set.status = patch.status;
  if (patch.unsafeMetadata) set.unsafeMetadata = patch.unsafeMetadata;
  if (patch.invitationId !== undefined) set.invitationId = patch.invitationId;
  if (patch.orgInvitationId !== undefined) set.orgInvitationId = patch.orgInvitationId;
  await ctx.db.update(s.signUps).set(set).where(eq(s.signUps.id, row.id));
  return first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, row.id)))!;
}

const matchesDomainPattern = (identifier: string, pattern: string) => {
  const domain = identifier.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  const p = pattern.toLowerCase().replace(/^\*?@?/, "");
  return pattern.startsWith("@") || pattern.startsWith("*@") ? domain === p || domain.endsWith(`.${p}`) : identifier.toLowerCase() === pattern.toLowerCase();
};

/** Rejects identifiers already claimed by another account or blocked by instance restrictions. */
export async function assertSignUpIdentifiers(ctx: AppContext, fields: SignUpFields, opts: { ticket?: boolean; invitationTicket?: string } = {}) {
  const st = ctx.settings.get();
  const email = fields.emailAddress ? normalizeEmail(fields.emailAddress) : undefined;
  if (fields.phoneNumber && !st.attributes.phoneNumber.enabled) {
    throw new OrbitError(422, ErrorCodes.form_param_unknown, "Phone numbers are disabled for this instance", { param_name: "phone_number" });
  }
  if (fields.username && !st.attributes.username.enabled) {
    throw new OrbitError(422, ErrorCodes.form_param_unknown, "Usernames are disabled for this instance", { param_name: "username" });
  }
  if (email) {
    if (await findEmail(ctx, email)) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use", { param_name: "email_address" });
    }
    if (!st.attributes.emailAddress.enabled) {
      throw new OrbitError(422, ErrorCodes.form_param_unknown, "Email addresses are disabled for this instance", { param_name: "email_address" });
    }
    if (st.restrictions.blockEmailSubaddresses && /\+[^@]*@/.test(email)) {
      throw new OrbitError(422, ErrorCodes.identifier_not_allowed, "Email subaddresses are not allowed", { param_name: "email_address" });
    }
    const blocked = (await ctx.db.select().from(s.blocklistIdentifiers)).some((row) => matchesDomainPattern(email, row.identifier));
    if (blocked) throw new OrbitError(422, ErrorCodes.identifier_not_allowed, "This identifier is not allowed", { param_name: "email_address" });
    const allowlisted = (await ctx.db.select().from(s.allowlistIdentifiers)).some((row) => matchesDomainPattern(email, row.identifier));
    if (!opts.ticket) {
      if (st.restrictions.allowlistEnabled && !allowlisted) {
        throw new OrbitError(422, ErrorCodes.sign_up_restricted, "Sign-ups are restricted to allowlisted identifiers", { param_name: "email_address" });
      }
      if (st.signUp.mode === "waitlist") {
        throw new OrbitError(422, ErrorCodes.waitlist_mode, "Sign-ups are currently limited to the waitlist", { param_name: "email_address" });
      }
      if (st.signUp.mode === "restricted" && !allowlisted) {
        throw new OrbitError(422, ErrorCodes.sign_up_restricted, "Sign-ups are restricted on this instance", { param_name: "email_address" });
      }
    }
  }
  await assertIdentifiersAllowed(
    ctx,
    { emails: email ? [email] : [], phones: fields.phoneNumber ? [fields.phoneNumber] : [], invitationTicket: opts.invitationTicket ?? null },
    {},
  );
}

export interface CompleteSignUpOptions { ip?: string; userAgent?: string }

/** Creates the user (and session) and marks the sign-up complete. */
export async function completeSignUp(ctx: AppContext, row: SignUpRow, opts: CompleteSignUpOptions = {}): Promise<{ userId: string; sessionId: string; user: UserRow }> {
  const fields = asSignUpFields(row);
  const verifications = asSignUpVerifications(row);
  const emailVerified = emailIsVerified(fields, verifications);
  const phoneVerified = verifications.phone_number?.status === "verified";

  const user = await createUser(ctx, {
      email: fields.emailAddress ?? null,
      phone: fields.phoneNumber ?? null,
      username: fields.username ?? null,
      firstName: fields.firstName ?? null,
      lastName: fields.lastName ?? null,
      passwordHash: fields.passwordHash ?? null,
      externalId: fields.externalId ?? null,
      unsafeMetadata: row.unsafeMetadata,
      legalAcceptedAt: fields.legalAcceptedAt ?? null,
      emailVerified,
      phoneVerified,
    emailVerifiedStrategy: verifications.email_address?.strategy ?? verifications.external_account?.strategy ?? "email_code",
  });

  if (fields.externalAccount) {
    const ext = fields.externalAccount;
    const existing = first(await ctx.db.select().from(s.externalAccounts)
          .where(and(eq(s.externalAccounts.provider, ext.provider), eq(s.externalAccounts.providerUserId, ext.providerUserId))));
    if (!existing) {
      const now = Date.now();
      await ctx.db.insert(s.externalAccounts).values({
                        id: newId("eac"), userId: user.id, provider: ext.provider, providerUserId: ext.providerUserId,
                        emailAddress: ext.emailAddress, firstName: ext.firstName, lastName: ext.lastName, username: ext.username,
                        imageUrl: ext.imageUrl, approvedScopes: ext.approvedScopes, accessTokenEnc: ext.accessTokenEnc ?? null,
                        refreshTokenEnc: ext.refreshTokenEnc ?? null, tokenExpiresAt: ext.tokenExpiresAt ?? null,
                        createdAt: now, updatedAt: now,
                      });
    }
  }

  if (row.invitationId) {
    await markInvitationAccepted(ctx, row.invitationId, user.id);
  }

  const sessionId = await createSession(ctx, {
    clientId: row.clientId,
    userId: user.id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    firstFactor: true,
  });
  await ctx.db.update(s.signUps).set({ status: "complete", createdUserId: user.id, createdSessionId: sessionId, updatedAt: Date.now() }).where(eq(s.signUps.id, row.id));
  // The client is signed in: hide any other in-flight attempts.
  for (const signIn of (await ctx.db.select().from(s.signIns).where(eq(s.signIns.clientId, row.clientId)))) {
    if (signIn.status !== "complete" && signIn.status !== "abandoned") {
      await ctx.db.update(s.signIns).set({ status: "abandoned", updatedAt: Date.now() }).where(eq(s.signIns.id, signIn.id));
    }
  }
  for (const other of (await ctx.db.select().from(s.signUps).where(eq(s.signUps.clientId, row.clientId)))) {
    if (other.id !== row.id && other.status !== "complete" && other.status !== "abandoned") {
      await ctx.db.update(s.signUps).set({ status: "abandoned", updatedAt: Date.now() }).where(eq(s.signUps.id, other.id));
    }
  }
  return { userId: user.id, sessionId, user };
}

/** Completes automatically when nothing is missing/unverified; otherwise keeps `missing_requirements`. */
export async function maybeCompleteSignUp(ctx: AppContext, row: SignUpRow, opts: CompleteSignUpOptions = {}) {
  const fields = asSignUpFields(row);
  const verifications = asSignUpVerifications(row);
  const req = computeRequirements(ctx, fields, verifications);
  if (req.missing_fields.length === 0 && req.unverified_fields.length === 0) {
    return completeSignUp(ctx, row, opts);
  }
  await saveSignUp(ctx, row, { status: "missing_requirements" });
  return null;
}

/** Merges an OAuth profile into the sign-up fields/verifications (used by the callback + transfer). */
export function applyExternalProfile(ctx: AppContext, row: SignUpRow, profile: ExternalProfile) {
  const fields = asSignUpFields(row);
  const verifications = asSignUpVerifications(row);
  const email = profile.email ? normalizeEmail(profile.email) : undefined;
  const nextFields: SignUpFields = {
    ...fields,
    emailAddress: fields.emailAddress ?? email,
    phoneNumber: fields.phoneNumber,
    firstName: fields.firstName ?? profile.firstName,
    lastName: fields.lastName ?? profile.lastName,
    username: fields.username,
    externalAccount: {
      provider: profile.provider,
      providerUserId: profile.providerUserId,
      emailAddress: email ?? "",
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      username: profile.username ?? null,
      imageUrl: profile.imageUrl ?? null,
      approvedScopes: profile.scopes ?? "",
      accessTokenEnc: profile.accessToken ? encrypt(ctx.env.encryptionKey, profile.accessToken) : undefined,
      refreshTokenEnc: profile.refreshToken ? encrypt(ctx.env.encryptionKey, profile.refreshToken) : undefined,
      tokenExpiresAt: profile.expiresAt,
    },
  };
  const nextVerifications: SignUpVerifications = {
    ...verifications,
    external_account: { status: "verified", strategy: verificationStrategyFor(profile.provider), attempts: null, expireAt: null },
  };
  // Do not downgrade an email that was already verified by the user.
  if (email && verifications.email_address?.status !== "verified") {
    nextVerifications.email_address = profile.emailVerified
      ? { status: "verified", strategy: verificationStrategyFor(profile.provider), attempts: null, expireAt: null, identifier: email }
      : { status: "unverified", strategy: "email_code", attempts: 0, expireAt: null, identifier: email };
  }
  return saveSignUp(ctx, row, { fields: nextFields, verifications: nextVerifications });
}
