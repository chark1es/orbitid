// One-time codes, magic links and their delivery.
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { ErrorCodes, OrbitError, type VerificationJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { randomCode, randomToken, safeEqual, sha256 } from "../../lib/crypto";
import { first } from "../../lib/db";

export type VerificationRow = typeof s.verifications.$inferSelect;
export type VerificationPurpose =
  | "sign_in_first_factor" | "sign_in_second_factor" | "sign_up_email" | "sign_up_phone"
  | "reset_password" | "reverify_first_factor" | "reverify_second_factor" | "add_email" | "add_phone" | "passkey_registration" | "passkey_authentication";

export interface IssueVerificationInput {
  purpose: VerificationPurpose;
  strategy: string;
  identifier: string;
  ownerId: string;
  redirectUrl?: string | null;
  data?: Record<string, unknown>;
  lifetimeSeconds: number;
  maxAttempts?: number;
  codeLength?: number;
}

export interface IssuedVerification {
  row: VerificationRow;
  /** numeric code (email_code / phone_code / reset_password_*) */
  code?: string;
  /** opaque token for magic links */
  token?: string;
}

const isLinkStrategy = (strategy: string) => strategy === "email_link" || strategy === "reset_password_link";

/** Creates a hashed one-time code or link token. Never stores plaintext. */
export async function issueVerification(ctx: AppContext, input: IssueVerificationInput): Promise<IssuedVerification> {
  const now = Date.now();
  const code = isLinkStrategy(input.strategy) ? undefined : randomCode(input.codeLength ?? ctx.settings.get().email.codeLength);
  const token = isLinkStrategy(input.strategy) ? randomToken(32) : undefined;
  const id = newId("ver");
  // Invalidate older pending verifications for the same purpose/owner/identifier.
  const previous = (await ctx.db.select().from(s.verifications)
      .where(and(eq(s.verifications.ownerId, input.ownerId), eq(s.verifications.purpose, input.purpose), eq(s.verifications.identifier, input.identifier))));
  for (const row of previous) {
    if (!row.verifiedAt && !row.consumedAt) {
      await ctx.db.update(s.verifications).set({ expiresAt: now - 1, verifiedAt: row.verifiedAt }).where(eq(s.verifications.id, row.id));
    }
  }
  await ctx.db.insert(s.verifications).values({
            id,
            purpose: input.purpose,
            strategy: input.strategy,
            identifier: input.identifier,
            ownerId: input.ownerId,
            codeHash: code ? sha256(code) : null,
            tokenHash: token ? sha256(token) : null,
            attempts: 0,
            maxAttempts: input.maxAttempts ?? 5,
            redirectUrl: input.redirectUrl ?? null,
            data: input.data ?? null,
            expiresAt: now + input.lifetimeSeconds * 1000,
            createdAt: now,
          });
  return { row: first(await ctx.db.select().from(s.verifications).where(eq(s.verifications.id, id)))!, code, token };
}

export async function getVerificationById(ctx: AppContext, id: string) {
  return first(await ctx.db.select().from(s.verifications).where(eq(s.verifications.id, id)));
}

/** Most recent verification for a purpose/owner. */
export async function getVerification(ctx: AppContext, purpose: VerificationPurpose, ownerId: string, identifier?: string) {
  const rows = (await ctx.db.select().from(s.verifications).where(and(eq(s.verifications.purpose, purpose), eq(s.verifications.ownerId, ownerId))).orderBy(desc(s.verifications.createdAt)));
  return rows.find((r) => !identifier || r.identifier === identifier) ?? undefined;
}

export async function getVerificationByToken(ctx: AppContext, token: string) {
  return first(await ctx.db.select().from(s.verifications).where(eq(s.verifications.tokenHash, sha256(token))));
}

const isExpired = (row: VerificationRow) => row.expiresAt <= Date.now();

/** Wire status of a verification row (`transferable` is stored explicitly in `data.transferable`). */
export function verificationJSON(row: VerificationRow | null | undefined, fallbackStrategy?: string): VerificationJSON | null {
  if (!row) return null;
  const strategy = row.strategy;
  if (row.data?.transferable === true && !row.verifiedAt) {
    return { status: "transferable", strategy: fallbackStrategy ?? strategy, attempts: row.attempts, expire_at: row.expiresAt, error: null, nonce: null };
  }
  if (row.verifiedAt || row.consumedAt) {
    return { status: "verified", strategy, attempts: row.attempts, expire_at: row.expiresAt, error: null, nonce: (row.data?.nonce as string | undefined) ?? null };
  }
  if (row.attempts >= row.maxAttempts) {
    return { status: "failed", strategy, attempts: row.attempts, expire_at: row.expiresAt, error: { code: ErrorCodes.too_many_attempts, message: "Too many attempts" }, nonce: null };
  }
  if (isExpired(row)) {
    return { status: "expired", strategy, attempts: row.attempts, expire_at: row.expiresAt, error: { code: ErrorCodes.verification_expired, message: "Verification expired" }, nonce: null };
  }
  return { status: "unverified", strategy, attempts: row.attempts, expire_at: row.expiresAt, error: null, nonce: (row.data?.nonce as string | undefined) ?? null };
}

/** Verifies a numeric code, counting attempts and enforcing expiry/attempt limits. */
export async function checkCode(ctx: AppContext, row: VerificationRow | undefined, code: string | undefined): Promise<VerificationRow> {
  if (!row) throw new OrbitError(422, ErrorCodes.form_code_incorrect, "There is no pending verification to check");
  const now = Date.now();
  if (isExpired(row)) throw new OrbitError(422, ErrorCodes.verification_expired, "That verification code has expired. Request a new one.");
  if (row.attempts >= row.maxAttempts) throw new OrbitError(422, ErrorCodes.too_many_attempts, "Too many incorrect attempts. Request a new code.");
  // The attempt is claimed before the code is compared: parallel guesses can never exceed max_attempts.
  const claimed = first(await ctx.db.update(s.verifications)
    .set({ attempts: sql`${s.verifications.attempts} + 1` })
    .where(and(
      eq(s.verifications.id, row.id),
      sql`${s.verifications.attempts} < ${s.verifications.maxAttempts}`,
      gt(s.verifications.expiresAt, now),
    ))
    .returning());
  if (!claimed) {
    const current = await getVerificationById(ctx, row.id);
    if (!current || isExpired(current)) throw new OrbitError(422, ErrorCodes.verification_expired, "That verification code has expired. Request a new one.");
    throw new OrbitError(422, ErrorCodes.too_many_attempts, "Too many incorrect attempts. Request a new code.");
  }
  const trimmed = (code ?? "").trim();
  const ok = !!claimed.codeHash && !!trimmed && safeEqual(sha256(trimmed), claimed.codeHash);
  if (!ok) {
    if (claimed.attempts >= claimed.maxAttempts) throw new OrbitError(422, ErrorCodes.too_many_attempts, "Too many incorrect attempts. Request a new code.");
    throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
  }
  await ctx.db.update(s.verifications).set({ verifiedAt: now }).where(eq(s.verifications.id, claimed.id));
  return (await getVerificationById(ctx, claimed.id))!;
}

/** Marks a magic link as clicked. Cross-device: the sign-in attempt poll then sees it. */
export async function consumeLink(ctx: AppContext, row: VerificationRow) {
  if (row.verifiedAt) return row;
  const now = Date.now();
  const claimed = first(await ctx.db.update(s.verifications)
    .set({ consumedAt: now, verifiedAt: now })
    .where(and(eq(s.verifications.id, row.id), isNull(s.verifications.consumedAt), gt(s.verifications.expiresAt, now)))
    .returning());
  if (claimed) return claimed;
  // A parallel click won: the link is already consumed, which is what the caller wants.
  const current = await getVerificationById(ctx, row.id);
  if (current?.verifiedAt) return current;
  throw new OrbitError(422, ErrorCodes.verification_expired, "That link has expired");
}

export function magicLinkUrl(ctx: AppContext, token: string, params: Record<string, string | undefined> = {}): string {
  const url = new URL(`${ctx.env.baseUrl}/v1/verify`);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
