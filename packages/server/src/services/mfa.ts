// TOTP, backup codes, second-factor discovery.
import { randomInt } from "node:crypto";
import { authenticator } from "otplib";
import { toDataURL } from "qrcode";
import { and, eq, sql } from "drizzle-orm";
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

/** `ada@example.com` → `a***@example.com` (shown in factor pickers instead of the full address). */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${(local ?? "").slice(0, 1)}${"*".repeat(Math.max(3, (local ?? "").length - 1))}@${domain}`;
};

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
/**
 * 10 single-use backup codes, formatted `xxxxx-xxxxx`. Ten characters from a 32-symbol alphabet is 50
 * bits of entropy per code, which puts online guessing far beyond any realistic attempt budget. Plaintext
 * is returned once; only sha256 hashes are stored.
 */
export function generateBackupCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < 10; j++) raw += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
    plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return { plain, hashed: plain.map(normalizeBackupCodeHash) };
}

/**
 * Backup codes are 50-bit random strings, so a plain sha256 is enough (there is no table to find them in). The
 * normalization means `ABCDE-12345`, `abcde12345` and `abcde 12345` are the same code, which is what a user typing
 * one back expects. Every writer must use this, or its rows would never match a presented code.
 */
export const hashBackupCode = (code: string) => sha256(code.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
const normalizeBackupCodeHash = hashBackupCode;

/** Checks a backup code and removes it from the user's unused set. */
export async function consumeBackupCode(ctx: AppContext, user: UserRow, code: string): Promise<boolean> {
  const hashes = user.backupCodes ?? [];
  const hash = normalizeBackupCodeHash(code);
  if (!hashes.includes(hash)) return false;
  // Compare-and-set on the serialized array: only one of several parallel requests can spend this code.
  const spent = first(await ctx.db.update(s.users)
    .set({ backupCodes: hashes.filter((h) => h !== hash), updatedAt: Date.now() })
    .where(and(eq(s.users.id, user.id), sql`${s.users.backupCodes} = ${JSON.stringify(hashes)}`))
    .returning({ id: s.users.id }));
  return !!spent;
}

export async function verifiedSecondFactorPhones(ctx: AppContext, user: UserRow, opts: { excludePhoneId?: string } = {}) {
  return (await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, user.id)))
    .filter((p) => p.verified && p.reservedForSecondFactor && p.id !== opts.excludePhoneId);
}

/** Verified email addresses that may be used as a second factor (`attributes.emailAddress.usedForSecondFactor`). */
export async function emailSecondFactors(ctx: AppContext, user: UserRow, opts: { excludeEmailId?: string } = {}) {
  const st = ctx.settings.get();
  if (!st.attributes.emailAddress.enabled || !st.attributes.emailAddress.usedForSecondFactor) return [];
  return (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, user.id)))
    .filter((e) => e.verified && e.id !== opts.excludeEmailId);
}

/** The first verified email address usable as a second factor. */
export async function emailSecondFactor(ctx: AppContext, user: UserRow, opts: { excludeEmailId?: string } = {}) {
  return (await emailSecondFactors(ctx, user, opts))[0];
}

/** The channel a first-factor strategy belongs to. A second factor must use a different channel/identifier. */
export function firstFactorChannel(strategy: string | undefined): "email" | "phone" | undefined {
  if (strategy === "email_code" || strategy === "email_link" || strategy === "reset_password_email_code") return "email";
  if (strategy === "phone_code" || strategy === "reset_password_phone_code") return "phone";
  return undefined;
}

export interface SecondFactorOptions {
  /** Strategy already used as the first factor: a second factor must be a *different* factor. */
  firstFactorStrategy?: string;
  /** The exact email used as the first factor, when it was an email strategy. */
  firstFactorEmailId?: string;
  /** The exact phone used as the first factor, when it was a phone strategy. */
  firstFactorPhoneId?: string;
}

/**
 * Second factors the user can actually perform, in priority order.
 * The channel and identifier used as the first factor are never offered again, so a recovery code for the same
 * mailbox/phone cannot satisfy both steps.
 */
export async function supportedSecondFactors(
  ctx: AppContext,
  user: UserRow,
  opts: SecondFactorOptions = {},
): Promise<SignInFactor[]> {
  const factors: SignInFactor[] = [];
  const channel = firstFactorChannel(opts.firstFactorStrategy);
  // If the exact identifier used as the first factor is unknown, fail closed for that whole channel instead of
  // guessing. Otherwise a recovery code sent to a secondary mailbox could be "verified" again by the same mailbox.
  const excludeAllPhones = channel === "phone" && !opts.firstFactorPhoneId;
  const excludeAllEmails = channel === "email" && !opts.firstFactorEmailId;
  const excludePhoneId = channel === "phone" ? opts.firstFactorPhoneId : undefined;
  const excludeEmailId = channel === "email" ? opts.firstFactorEmailId : undefined;
  if (user.totpVerified) factors.push({ strategy: "totp" });
  const phones = excludeAllPhones ? [] : await verifiedSecondFactorPhones(ctx, user, { excludePhoneId });
  for (const phone of phones) {
    factors.push({ strategy: "phone_code", phone_number_id: phone.id, default: phone.defaultSecondFactor });
  }
  const emails = excludeAllEmails ? [] : await emailSecondFactors(ctx, user, { excludeEmailId });
  for (const email of emails) {
    factors.push({ strategy: "email_code", email_address_id: email.id, safe_identifier: maskEmail(email.email), primary: email.id === user.primaryEmailAddressId });
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
