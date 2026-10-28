// WebAuthn / passkey ceremonies (@simplewebauthn/server v10).
import type { VerifiedRegistrationResponse } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/types";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import type { UserRow } from "./users";
import { first } from "../lib/db";

export type PasskeyRow = typeof s.passkeys.$inferSelect;

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface RelyingParty { rpID: string; origin: string }

/** Derives {rpID, origin} from the caller's Origin header or the redirect/frontend URL, falling back to the instance URL. */
export function relyingParty(ctx: AppContext, originHint?: string | null): RelyingParty {
  const candidate = originHint || ctx.settings.get().application.homeUrl || ctx.env.baseUrl;
  let origin: string;
  try {
    origin = new URL(candidate).origin;
  } catch {
    origin = ctx.env.baseUrl;
  }
  const host = new URL(origin).hostname;
  return { rpID: host, origin };
}

async function storeChallenge(ctx: AppContext, purpose: "passkey_registration" | "passkey_authentication", ownerId: string, challenge: string, data: Record<string, unknown>) {
  await ctx.db.insert(s.verifications).values({
            id: newId("ver"), purpose, strategy: "passkey", identifier: challenge, ownerId,
            data, attempts: 0, maxAttempts: 5, expiresAt: Date.now() + CHALLENGE_TTL_MS, createdAt: Date.now(),
          });
}

async function loadChallenge(ctx: AppContext, purpose: string, ownerId: string) {
  const rows = (await ctx.db.select().from(s.verifications)
      .where(and(eq(s.verifications.purpose, purpose), eq(s.verifications.ownerId, ownerId))))
    .filter((r) => !r.verifiedAt && r.expiresAt > Date.now());
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0];
}

export interface BeginPasskeyRegistrationInput {
  userId: string;
  userName: string;
  displayName: string;
  rp: RelyingParty;
  /** `platform` = device-bound passkey, `cross-platform` = security key */
  authenticatorType?: "platform" | "cross-platform";
  name?: string;
}

/** Starts a registration ceremony; the passkey row is only created once the attestation verifies. */
export async function beginPasskeyRegistration(ctx: AppContext, input: BeginPasskeyRegistrationInput) {
  const st = ctx.settings.get();
  const existing = (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, input.userId)));
  const passkeyId = newId("pkey");
  const options = await generateRegistrationOptions({
    rpName: st.application.name,
    rpID: input.rp.rpID,
    userID: new TextEncoder().encode(input.userId),
    userName: input.userName,
    userDisplayName: input.displayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined })),
    authenticatorSelection: input.authenticatorType === "platform"
      ? { residentKey: "preferred", userVerification: "preferred", authenticatorAttachment: "platform" }
      : input.authenticatorType === "cross-platform"
        ? { residentKey: "preferred", userVerification: "preferred", authenticatorAttachment: "cross-platform" }
        : { residentKey: "preferred", userVerification: "preferred" },
  });
  await storeChallenge(ctx, "passkey_registration", passkeyId, options.challenge, {
        rpID: input.rp.rpID, origin: input.rp.origin, userId: input.userId, name: input.name,
      });
  return { passkeyId, options };
}

export async function finishPasskeyRegistration(ctx: AppContext, input: {
  passkeyId: string;
  userId: string;
  credential: RegistrationResponseJSON;
  rp: RelyingParty;
  name?: string;
}) {
  const stored = await loadChallenge(ctx, "passkey_registration", input.passkeyId);
  if (!stored || stored.data?.userId !== input.userId) {
    throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey registration expired. Please try again.");
  }
  let verified = false;
  let info: VerifiedRegistrationResponse["registrationInfo"];
  try {
    const result = await verifyRegistrationResponse({
      response: input.credential,
      expectedChallenge: stored.identifier,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      requireUserVerification: true,
    });
    verified = result.verified;
    info = result.registrationInfo;
  } catch {
    verified = false;
  }
  await ctx.db.update(s.verifications).set({ attempts: stored.attempts + 1, verifiedAt: verified ? Date.now() : null }).where(eq(s.verifications.id, stored.id));
  if (!verified || !info) {
    throw new OrbitError(400, ErrorCodes.passkey_registration_failure, "Passkey registration could not be verified");
  }
  if (first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.credentialId, info.credentialID)))) {
    throw new OrbitError(409, ErrorCodes.passkey_registration_failure, "This authenticator is already registered");
  }
  const now = Date.now();
  const name = input.name?.trim() || (typeof stored.data?.name === "string" ? stored.data.name : "") || "Passkey";
  await ctx.db.insert(s.passkeys).values({
            id: input.passkeyId,
            userId: input.userId,
            name,
            credentialId: info.credentialID,
            publicKey: Buffer.from(info.credentialPublicKey).toString("base64url"),
            counter: info.counter,
            transports: (input.credential.response.transports ?? []) as string[],
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            createdAt: now,
            updatedAt: now,
          });
  return first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.id, input.passkeyId)))!;
}

/** Options for `navigator.credentials.get()`. With `userId` limits to that user's credentials. */
export async function beginPasskeyAuthentication(ctx: AppContext, input: {
  rp: RelyingParty;
  userId?: string;
  ownerId: string;
  allowCredentials?: { id: string; transports?: string[] }[];
}) {
  const creds = input.allowCredentials
    ?? (input.userId
      ? (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, input.userId))).map((p) => ({ id: p.credentialId, transports: p.transports ?? undefined }))
      : []);
  const options = await generateAuthenticationOptions({
    rpID: input.rp.rpID,
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: creds.map((c) => ({ id: c.id, transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined })),
    userVerification: "preferred",
  });
  await storeChallenge(ctx, "passkey_authentication", input.ownerId, options.challenge, {
        rpID: input.rp.rpID, origin: input.rp.origin, userId: input.userId ?? null,
      });
  return options;
}

export async function finishPasskeyAuthentication(ctx: AppContext, input: {
  ownerId: string;
  credential: AuthenticationResponseJSON;
  rp: RelyingParty;
}): Promise<{ user: UserRow; passkey: PasskeyRow }> {
  const stored = await loadChallenge(ctx, "passkey_authentication", input.ownerId);
  if (!stored) throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey sign-in expired. Please try again.");
  const passkey = first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.credentialId, input.credential.id)));
  if (!passkey) {
    await ctx.db.update(s.verifications).set({ attempts: stored.attempts + 1 }).where(eq(s.verifications.id, stored.id));
    throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "Unknown passkey");
  }
  let verified = false;
  let newCounter = passkey.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response: input.credential,
      expectedChallenge: stored.identifier,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.rpID,
      authenticator: {
        credentialID: passkey.credentialId,
        credentialPublicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.counter,
        transports: (passkey.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: true,
    });
    verified = result.verified;
    newCounter = result.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  await ctx.db.update(s.verifications).set({ attempts: stored.attempts + 1, verifiedAt: verified ? Date.now() : null }).where(eq(s.verifications.id, stored.id));
  if (!verified) {
    throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "Passkey could not be verified");
  }
  await ctx.db.update(s.passkeys).set({ counter: newCounter, lastUsedAt: Date.now(), updatedAt: Date.now() }).where(eq(s.passkeys.id, passkey.id));
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, passkey.userId)))!;
  return { user, passkey: first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.id, passkey.id)))! };
}

export const listPasskeys = async (ctx: AppContext, userId: string) =>
  (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, userId)));
