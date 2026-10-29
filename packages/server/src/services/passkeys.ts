// WebAuthn / passkey ceremonies (@simplewebauthn/server v13).
import type { VerifiedRegistrationResponse } from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { requestOriginAllowed } from "../lib/security";
import type { UserRow } from "./users";
import { first } from "../lib/db";

export type PasskeyRow = typeof s.passkeys.$inferSelect;

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface RelyingParty { rpID: string; origin: string }

const originOf = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * Derives {rpID, origin} for a ceremony. The browser scopes a credential to the *page's* origin, so the
 * `Origin` header wins — but only when this instance trusts it; anything else falls back to the
 * configured app URL and then to the instance URL. `rpID` is the hostname without the port, which is
 * what the WebAuthn `rpId` field requires.
 */
export function relyingParty(ctx: AppContext, originHint?: string | null): RelyingParty {
  const app = ctx.settings.get().application;
  const trusted = (value: string | null | undefined) => {
    const origin = originOf(value);
    return origin && requestOriginAllowed(ctx, origin) ? origin : null;
  };
  const origin = trusted(originHint) ?? trusted(app.homeUrl) ?? originOf(ctx.env.baseUrl)!;
  return { rpID: new URL(origin).hostname, origin };
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
    .filter((r) => !r.verifiedAt && !r.consumedAt && r.expiresAt > Date.now());
  return rows.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * Takes exclusive ownership of a challenge before any signature work, so one challenge can never be
 * presented twice: concurrent requests that loaded the same row race on this single statement and only
 * one of them gets it back. `consumedAt` is released again when verification fails, which keeps the
 * existing retry-up-to-maxAttempts behaviour. The security decisions of the ceremony (rpID, origin,
 * user) were fixed when the challenge was issued and are not taken from the finishing request.
 */
async function claimChallenge(ctx: AppContext, stored: PasskeyVerificationRow) {
  return first(await ctx.db.update(s.verifications)
    .set({ consumedAt: Date.now(), attempts: sql`${s.verifications.attempts} + 1` })
    .where(and(
      eq(s.verifications.id, stored.id),
      isNull(s.verifications.verifiedAt),
      isNull(s.verifications.consumedAt),
      lt(s.verifications.attempts, s.verifications.maxAttempts),
      gt(s.verifications.expiresAt, Date.now()),
    ))
    .returning());
}

type PasskeyVerificationRow = typeof s.verifications.$inferSelect;

/** The relying party captured when the ceremony started; a later request cannot move it. */
function ceremonyRelyingParty(stored: PasskeyVerificationRow): RelyingParty {
  const rpID = typeof stored.data?.rpID === "string" ? stored.data.rpID : "";
  const origin = typeof stored.data?.origin === "string" ? stored.data.origin : "";
  if (!rpID || !origin) {
    throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey ceremony expired. Please try again.");
  }
  return { rpID, origin };
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
  name?: string;
}) {
  const stored = await loadChallenge(ctx, "passkey_registration", input.passkeyId);
  if (!stored || stored.data?.userId !== input.userId) {
    throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey registration expired. Please try again.");
  }
  const claimed = await claimChallenge(ctx, stored);
  if (!claimed) {
    throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey registration expired. Please try again.");
  }
  // The ceremony's relying party was fixed when the challenge was issued; this request cannot move it.
  const rp = ceremonyRelyingParty(claimed);
  let verified = false;
  let info: VerifiedRegistrationResponse["registrationInfo"];
  try {
    const result = await verifyRegistrationResponse({
      response: input.credential,
      expectedChallenge: claimed.identifier,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
    });
    verified = result.verified;
    info = result.registrationInfo;
  } catch {
    verified = false;
  }
  if (!verified || !info) {
    // Give the attempt back so the browser can retry within the challenge lifetime.
    await ctx.db.update(s.verifications).set({ consumedAt: null }).where(eq(s.verifications.id, claimed.id));
    throw new OrbitError(400, ErrorCodes.passkey_registration_failure, "Passkey registration could not be verified");
  }
  await ctx.db.update(s.verifications).set({ verifiedAt: Date.now() }).where(eq(s.verifications.id, claimed.id));
  if (first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.credentialId, info.credential.id)))) {
    throw new OrbitError(409, ErrorCodes.passkey_registration_failure, "This authenticator is already registered");
  }
  const now = Date.now();
  const name = input.name?.trim() || (typeof claimed.data?.name === "string" ? claimed.data.name : "") || "Passkey";
  // A unique index on `credential_id` settles the two-challenges-at-once case the same way as the check above.
  const inserted = await ctx.db.insert(s.passkeys).values({
            id: input.passkeyId,
            userId: input.userId,
            name,
            credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
            counter: info.credential.counter,
            transports: (input.credential.response.transports ?? []) as string[],
            deviceType: info.credentialDeviceType,
            backedUp: info.credentialBackedUp,
            createdAt: now,
            updatedAt: now,
          }).onConflictDoNothing().returning();
  if (!inserted.length) {
    throw new OrbitError(409, ErrorCodes.passkey_registration_failure, "This authenticator is already registered");
  }
  return inserted[0]!;
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
}): Promise<{ user: UserRow; passkey: PasskeyRow }> {
  const stored = await loadChallenge(ctx, "passkey_authentication", input.ownerId);
  if (!stored) throw new OrbitError(400, ErrorCodes.verification_expired, "Passkey sign-in expired. Please try again.");
  // Take the challenge before any signature work: one challenge, one attempt, however many requests race.
  const claimed = await claimChallenge(ctx, stored);
  if (!claimed) throw new OrbitError(400, ErrorCodes.verification_expired, "Too many passkey attempts. Please try again.");
  const rp = ceremonyRelyingParty(claimed);
  const passkey = first(await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.credentialId, input.credential.id)));
  if (!passkey) {
    throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "Unknown passkey");
  }
  let verified = false;
  let newCounter = passkey.counter;
  try {
    const result = await verifyAuthenticationResponse({
      response: input.credential,
      expectedChallenge: claimed.identifier,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
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
  if (!verified) {
    // Hand the challenge back so the user can retry (bounded by maxAttempts) while it is still valid.
    await ctx.db.update(s.verifications).set({ consumedAt: null }).where(eq(s.verifications.id, claimed.id));
    throw new OrbitError(400, ErrorCodes.passkey_authentication_failure, "Passkey could not be verified");
  }
  await ctx.db.update(s.verifications).set({ verifiedAt: Date.now() }).where(eq(s.verifications.id, claimed.id));
  const now = Date.now();
  const updated = first(await ctx.db.update(s.passkeys)
    .set({
      counter: sql`case when ${s.passkeys.counter} < ${newCounter} then ${newCounter} else ${s.passkeys.counter} end`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(s.passkeys.id, passkey.id))
    .returning());
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, passkey.userId)))!;
  return { user, passkey: updated! };
}

export const listPasskeys = async (ctx: AppContext, userId: string) =>
  (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, userId)));
