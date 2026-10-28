// TOTP, backup codes, second-factor discovery.
import { randomInt } from "node:crypto";
import { authenticator } from "otplib";
import { toDataURL } from "qrcode";
import { eq } from "drizzle-orm";
import type { SignInFactor } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { decrypt, encrypt, sha256 } from "../lib/crypto";
import type { UserRow } from "./users";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import { first } from "../lib/db";

// Allow ±1 time step of clock drift.
authenticator.options = { window: 1, step: 30 };

export const generateTotpSecret = () => authenticator.generateSecret(20);

export function totpUri(secret: string, accountName: string, issuer: string): string {
  return authenticator.keyuri(accountName, issuer, secret);
}

export const qrCodeDataUrl = (uri: string): Promise<string> => toDataURL(uri, { margin: 1, width: 220 });

export function verifyTotp(ctx: AppContext, user: UserRow, code: string): boolean {
  if (!user.totpSecretEnc || !user.totpVerified) return false;
  try {
    return authenticator.check(code.replace(/\s/g, ""), decrypt(ctx.env.encryptionKey, user.totpSecretEnc));
  } catch {
    return false;
  }
}

/** Verifies a freshly-scanned secret before it is enabled. */
export function checkTotpAgainstSecret(secret: string, code: string): boolean {
  try {
    return authenticator.check(code.replace(/\s/g, ""), secret);
  } catch {
    return false;
  }
}

export const encryptTotpSecret = (ctx: AppContext, secret: string) => encrypt(ctx.env.encryptionKey, secret);

const BACKUP_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
/** 10 single-use backup codes, formatted `xxxx-xxxx`. Plaintext is returned once; only sha256 hashes are stored. */
export function generateBackupCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 8; j++) raw += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
    plain.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return { plain, hashed: plain.map(normalizeBackupCodeHash) };
}

const normalizeBackupCodeHash = (code: string) => sha256(code.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));

/** Checks a backup code and removes it from the user's unused set. */
export async function consumeBackupCode(ctx: AppContext, user: UserRow, code: string): Promise<boolean> {
  const hashes = user.backupCodes ?? [];
  const hash = normalizeBackupCodeHash(code);
  if (!hashes.includes(hash)) return false;
  await ctx.db.update(s.users).set({ backupCodes: hashes.filter((h) => h !== hash), updatedAt: Date.now() }).where(eq(s.users.id, user.id));
  return true;
}

export async function verifiedSecondFactorPhones(ctx: AppContext, user: UserRow) {
  return (await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, user.id)))
    .filter((p) => p.verified && p.reservedForSecondFactor);
}

/** Second factors the user can actually perform, in Clerk's priority order. */
export async function supportedSecondFactors(ctx: AppContext, user: UserRow): Promise<SignInFactor[]> {
  const factors: SignInFactor[] = [];
  if (user.totpVerified) factors.push({ strategy: "totp" });
  for (const phone of await verifiedSecondFactorPhones(ctx, user)) {
    factors.push({ strategy: "phone_code", phone_number_id: phone.id, default: phone.defaultSecondFactor });
  }
  if ((user.backupCodes?.length ?? 0) > 0) factors.push({ strategy: "backup_code" });
  return factors;
}

export const userHasMfa = async (ctx: AppContext, user: UserRow): Promise<boolean> => (await supportedSecondFactors(ctx, user)).length > 0;

/** `mfa.required` only bites when the user has no factor yet and the instance offers one they could enrol. */
export async function mfaEnrollmentRequired(ctx: AppContext, user: UserRow): Promise<boolean> {
  const st = ctx.settings.get();
  const canEnrol = st.attributes.authenticatorApp.enabled || st.attributes.phoneNumber.usedForSecondFactor;
  return st.mfa.required && canEnrol && !await userHasMfa(ctx, user);
}

export interface TotpSetup { secret: string; uri: string; qrCode: string }

/** Creates (but does not enable) a TOTP secret for a user. */
export async function startTotpSetup(ctx: AppContext, user: UserRow): Promise<TotpSetup> {
  const st = ctx.settings.get();
  const secret = generateTotpSecret();
  const account = user.username ?? first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId ?? "")))?.email ?? user.id;
  const uri = totpUri(secret, account, st.application.name);
  await ctx.db.update(s.users).set({ totpSecretEnc: encryptTotpSecret(ctx, secret), totpVerified: false, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
  return { secret, uri, qrCode: await qrCodeDataUrl(uri) };
}

/** Verifies a TOTP code for a pending setup, enables it and returns fresh plaintext backup codes. */
export async function finishTotpSetup(ctx: AppContext, user: UserRow, code: string): Promise<{ backupCodes: string[] }> {
  if (!user.totpSecretEnc) throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP has not been set up for this user");
  let secret: string;
  try {
    secret = decrypt(ctx.env.encryptionKey, user.totpSecretEnc);
  } catch {
    throw new OrbitError(400, ErrorCodes.totp_not_enabled, "TOTP secret is unreadable; set up TOTP again");
  }
  if (!checkTotpAgainstSecret(secret, code)) {
    throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
  }
  const codes = generateBackupCodes();
  await ctx.db.update(s.users).set({ totpVerified: true, backupCodes: codes.hashed, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
  return { backupCodes: codes.plain };
}

/** Disables TOTP + backup codes. */
export async function disableTotp(ctx: AppContext, user: UserRow) {
  await ctx.db.update(s.users).set({ totpSecretEnc: null, totpVerified: false, backupCodes: null, updatedAt: Date.now() }).where(eq(s.users.id, user.id));
}
