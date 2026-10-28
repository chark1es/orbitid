// OWNER: worker "core" (W1). One-time codes, magic links and their delivery.
import { and, desc, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, type VerificationJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { newId } from "../../lib/ids";
import { randomCode, randomToken, safeEqual, sha256 } from "../../lib/crypto";

export type VerificationRow = typeof s.verifications.$inferSelect;
export type VerificationPurpose =
  | "sign_in_first_factor" | "sign_in_second_factor" | "sign_up_email" | "sign_up_phone"
  | "reset_password" | "reverify" | "add_email" | "add_phone" | "passkey_registration" | "passkey_authentication";

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
export function issueVerification(ctx: AppContext, input: IssueVerificationInput): IssuedVerification {
  const now = Date.now();
  const code = isLinkStrategy(input.strategy) ? undefined : randomCode(input.codeLength ?? ctx.settings.get().email.codeLength);
  const token = isLinkStrategy(input.strategy) ? randomToken(32) : undefined;
  const id = newId("ver");
  // Invalidate older pending verifications for the same purpose/owner/identifier.
  const previous = ctx.db.select().from(s.verifications)
    .where(and(eq(s.verifications.ownerId, input.ownerId), eq(s.verifications.purpose, input.purpose), eq(s.verifications.identifier, input.identifier)))
    .all();
  for (const row of previous) {
    if (!row.verifiedAt && !row.consumedAt) {
      ctx.db.update(s.verifications).set({ expiresAt: now - 1, verifiedAt: row.verifiedAt }).where(eq(s.verifications.id, row.id)).run();
    }
  }
  ctx.db.insert(s.verifications).values({
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
  }).run();
  return { row: ctx.db.select().from(s.verifications).where(eq(s.verifications.id, id)).get()!, code, token };
}

export function getVerificationById(ctx: AppContext, id: string) {
  return ctx.db.select().from(s.verifications).where(eq(s.verifications.id, id)).get();
}

/** Most recent verification for a purpose/owner. */
export function getVerification(ctx: AppContext, purpose: VerificationPurpose, ownerId: string, identifier?: string) {
  const rows = ctx.db.select().from(s.verifications).where(and(eq(s.verifications.purpose, purpose), eq(s.verifications.ownerId, ownerId))).orderBy(desc(s.verifications.createdAt)).all();
  return rows.find((r) => !identifier || r.identifier === identifier) ?? undefined;
}

export function getVerificationByToken(ctx: AppContext, token: string) {
  return ctx.db.select().from(s.verifications).where(eq(s.verifications.tokenHash, sha256(token))).get();
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
export function checkCode(ctx: AppContext, row: VerificationRow | undefined, code: string | undefined): VerificationRow {
  if (!row) throw new OrbitError(422, ErrorCodes.form_code_incorrect, "There is no pending verification to check");
  if (row.verifiedAt) return row;
  if (isExpired(row)) throw new OrbitError(422, ErrorCodes.verification_expired, "That verification code has expired. Request a new one.");
  if (row.attempts >= row.maxAttempts) throw new OrbitError(422, ErrorCodes.too_many_attempts, "Too many incorrect attempts. Request a new code.");
  const trimmed = (code ?? "").trim();
  const ok = !!row.codeHash && !!trimmed && safeEqual(sha256(trimmed), row.codeHash);
  if (!ok) {
    const attempts = row.attempts + 1;
    ctx.db.update(s.verifications).set({ attempts }).where(eq(s.verifications.id, row.id)).run();
    if (attempts >= row.maxAttempts) throw new OrbitError(422, ErrorCodes.too_many_attempts, "Too many incorrect attempts. Request a new code.");
    throw new OrbitError(422, ErrorCodes.form_code_incorrect, "That verification code is incorrect", { param_name: "code" });
  }
  ctx.db.update(s.verifications).set({ verifiedAt: Date.now(), attempts: row.attempts }).where(eq(s.verifications.id, row.id)).run();
  return getVerificationById(ctx, row.id)!;
}

/** Marks a magic link as clicked. Cross-device: the sign-in attempt poll then sees it. */
export function consumeLink(ctx: AppContext, row: VerificationRow) {
  if (row.verifiedAt) return row;
  if (isExpired(row)) throw new OrbitError(422, ErrorCodes.verification_expired, "That link has expired");
  ctx.db.update(s.verifications).set({ consumedAt: Date.now(), verifiedAt: Date.now() }).where(eq(s.verifications.id, row.id)).run();
  return getVerificationById(ctx, row.id)!;
}

export function magicLinkUrl(ctx: AppContext, token: string, params: Record<string, string | undefined> = {}): string {
  const url = new URL(`${ctx.env.baseUrl}/v1/verify`);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
