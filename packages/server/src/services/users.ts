// Reusable user/identifier helpers (also used by the Backend API).
import { and, eq, sql } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { serializeUser } from "../serializers";
import { emitEvent } from "./webhooks";
import { onUserDeleted, onUserEmailVerified } from "./orgs";
import { revokeAllTrustedDevices } from "./trusted-devices";
import { first } from "../lib/db";

export type UserRow = typeof s.users.$inferSelect;
export type EmailRow = typeof s.emailAddresses.$inferSelect;
export type PhoneRow = typeof s.phoneNumbers.$inferSelect;

export const normalizeEmail = (value: string) => value.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (value: string) => EMAIL_RE.test(value);

/** Normalizes a phone number to E.164 (`+` + digits). Throws `form_param_format_invalid` when it cannot be. */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  const normalized = trimmed.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  if (!/^\+[1-9]\d{6,14}$/.test(normalized)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "phone_number must be a valid E.164 number", { param_name: "phone_number" });
  }
  return normalized;
}

export type IdentifierType = "email_address" | "phone_number" | "username";
/** Best-effort detection of what a sign-in/sign-up `identifier` is. */
export function detectIdentifierType(identifier: string): IdentifierType {
  const v = identifier.trim();
  if (v.includes("@")) return "email_address";
  if (/^\+?[\d][\d\s().-]{5,}$/.test(v)) return "phone_number";
  return "username";
}

export const getUserById = async (ctx: AppContext, id: string): Promise<UserRow | undefined> =>
  first(await ctx.db.select().from(s.users).where(eq(s.users.id, id)));

export async function requireUser(ctx: AppContext, id: string): Promise<UserRow> {
  const u = await getUserById(ctx, id);
  if (!u) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
  return u;
}

export const findEmail = async (ctx: AppContext, email: string): Promise<EmailRow | undefined> =>
  first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, normalizeEmail(email))));

export const findPhone = async (ctx: AppContext, phone: string): Promise<PhoneRow | undefined> =>
  first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, normalizePhone(phone))));

export const listEmails = async (ctx: AppContext, userId: string): Promise<EmailRow[]> =>
  (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, userId)));

export const listPhones = async (ctx: AppContext, userId: string): Promise<PhoneRow[]> =>
  (await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, userId)));

export async function primaryEmail(ctx: AppContext, user: UserRow): Promise<EmailRow | undefined> {
  if (user.primaryEmailAddressId) {
    const row = first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId)));
    if (row) return row;
  }
  return (await listEmails(ctx, user.id))[0];
}

export async function primaryPhone(ctx: AppContext, user: UserRow): Promise<PhoneRow | undefined> {
  if (user.primaryPhoneNumberId) {
    const row = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, user.primaryPhoneNumberId)));
    if (row) return row;
  }
  return (await listPhones(ctx, user.id))[0];
}

/** Finds a user by email address, phone number or username. */
export async function getUserByIdentifier(ctx: AppContext, identifier: string): Promise<{ user: UserRow; type: IdentifierType } | null> {
  const v = identifier.trim();
  if (!v) return null;
  const type = detectIdentifierType(v);
  if (type === "email_address") {
    const e = await findEmail(ctx, v);
    if (!e?.userId) return null;
    const user = await getUserById(ctx, e.userId);
    return user ? { user, type } : null;
  }
  if (type === "phone_number") {
    let phone: string | undefined;
    try { phone = normalizePhone(v); } catch { return null; }
    const p = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)));
    if (!p?.userId) return null;
    const user = await getUserById(ctx, p.userId);
    return user ? { user, type } : null;
  }
  const u = first(await ctx.db.select().from(s.users).where(eq(s.users.usernameLower, v.toLowerCase())));
  return u ? { user: u, type } : null;
}

export const findUserByUsername = async (ctx: AppContext, username: string): Promise<UserRow | undefined> =>
  first(await ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())));

/** Username syntax + length + uniqueness. Throws OrbitError. */
export async function assertUsernameAvailable(ctx: AppContext, username: string, exceptUserId?: string) {
  const st = ctx.settings.get();
  if (username.length < st.username.minLength) {
    throw new OrbitError(422, ErrorCodes.form_username_invalid_length, `username must be at least ${st.username.minLength} characters`, { param_name: "username" });
  }
  if (username.length > st.username.maxLength) {
    throw new OrbitError(422, ErrorCodes.form_username_invalid_length, `username must be at most ${st.username.maxLength} characters`, { param_name: "username" });
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    throw new OrbitError(422, ErrorCodes.form_username_invalid_character, "username may only contain letters, numbers, '_', '-' and '.'", { param_name: "username" });
  }
  const existing = await findUserByUsername(ctx, username);
  if (existing && existing.id !== exceptUserId) {
    throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That username is taken", { param_name: "username" });
  }
}

export interface CreateUserInput {
  email?: string | null;
  phone?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  passwordHash?: string | null;
  externalId?: string | null;
  imageUrl?: string | null;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  /** strategy recorded on a pre-verified email (e.g. `oauth_google`) */
  emailVerifiedStrategy?: string | null;
  publicMetadata?: Record<string, unknown>;
  unsafeMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
  legalAcceptedAt?: number | null;
  /** Guest account without any identifier (`POST /v1/client/sign_ups` with `strategy: "anonymous"`). */
  isAnonymous?: boolean;
  /** skip the `user.created` webhook (bulk imports) */
  silent?: boolean;
}

/** Creates a user plus its email/phone identification rows and primary pointers. */
export async function createUser(ctx: AppContext, input: CreateUserInput): Promise<UserRow> {
  const now = Date.now();
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (
    !email &&
    !phone &&
    !input.username &&
    !input.isAnonymous
  ) {
    throw new OrbitError(422, ErrorCodes.form_param_missing, "At least one identifier is required");
  }
  if (email) {
    if (!isValidEmail(email)) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email_address is not valid", { param_name: "email_address" });
    const existing = await findEmail(ctx, email);
    if (existing?.verified || (existing?.userId && !input.silent)) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use", { param_name: "email_address" });
    }
  }
  if (phone) {
    const existing = first(await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)));
    if (existing?.userId) throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That phone number is already in use", { param_name: "phone_number" });
  }
  if (input.username) await assertUsernameAvailable(ctx, input.username);

  const id = newId("user");
  const verified = !!input.emailVerified;
  await ctx.db.insert(s.users).values({
            id,
            externalId: input.externalId ?? null,
            username: input.username ?? null,
            usernameLower: input.username ? input.username.toLowerCase() : null,
            firstName: input.firstName ?? null,
            lastName: input.lastName ?? null,
            imageUrl: input.imageUrl ?? null,
            hasImage: false,
            passwordHash: input.passwordHash ?? null,
            passwordUpdatedAt: input.passwordHash ? now : null,
            publicMetadata: input.publicMetadata ?? {},
            privateMetadata: input.privateMetadata ?? {},
            unsafeMetadata: input.unsafeMetadata ?? {},
            legalAcceptedAt: input.legalAcceptedAt ?? null,
            isAnonymous: !!input.isAnonymous,
            lastSignInAt: null,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
          });

  if (email) {
    const emailId = newId("idn_e");
    await ctx.db.insert(s.emailAddresses).values({
                  id: emailId, userId: id, email, verified, verifiedAt: verified ? now : null,
                  verifiedStrategy: verified ? input.emailVerifiedStrategy ?? "email_code" : null, createdAt: now, updatedAt: now,
                });
    await ctx.db.update(s.users).set({ primaryEmailAddressId: emailId }).where(eq(s.users.id, id));
  }
  if (phone) {
    const phoneId = newId("idn_p");
    await ctx.db.insert(s.phoneNumbers).values({
                  id: phoneId, userId: id, phone, verified: !!input.phoneVerified, verifiedAt: input.phoneVerified ? now : null, createdAt: now, updatedAt: now,
                });
    await ctx.db.update(s.users).set({ primaryPhoneNumberId: phoneId }).where(eq(s.users.id, id));
  }

  const user = (await getUserById(ctx, id))!;
  if (!input.silent) {
    const json = await serializeUser(ctx, user, { backend: true });
    await emitEvent(ctx, "user.created", json);
  }
  if (email && verified) await onUserEmailVerified(ctx, id, email);
  return user;
}

export async function setPrimaryEmail(ctx: AppContext, userId: string, emailId: string) {
  const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, emailId), eq(s.emailAddresses.userId, userId))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
  await ctx.db.update(s.users).set({ primaryEmailAddressId: emailId, updatedAt: Date.now() }).where(eq(s.users.id, userId));
  return row;
}

export async function setPrimaryPhone(ctx: AppContext, userId: string, phoneId: string) {
  const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, phoneId), eq(s.phoneNumbers.userId, userId))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
  await ctx.db.update(s.users).set({ primaryPhoneNumberId: phoneId, updatedAt: Date.now() }).where(eq(s.users.id, userId));
  return row;
}

export async function countIdentifications(ctx: AppContext, userId: string): Promise<number> {
  const emails = (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, userId))).length;
  const phones = (await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, userId))).length;
  const externals = (await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, userId))).length;
  const passkeys = (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, userId))).filter((p) => !p.credentialId.startsWith("pending_")).length;
  const username = (await getUserById(ctx, userId))?.username ? 1 : 0;
  return emails + phones + externals + passkeys + username;
}

/** Rejects removing the only way a user can sign in. */
export async function assertNotLastIdentification(ctx: AppContext, userId: string) {
  if (await countIdentifications(ctx, userId) <= 1) {
    throw new OrbitError(422, ErrorCodes.last_identification_cannot_be_removed, "You cannot remove your last identification");
  }
}

export async function deleteEmailAddress(ctx: AppContext, userId: string, emailId: string) {
  const row = first(await ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, emailId), eq(s.emailAddresses.userId, userId))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
  await assertNotLastIdentification(ctx, userId);
  await ctx.db.delete(s.emailAddresses).where(eq(s.emailAddresses.id, emailId));
  const user = (await getUserById(ctx, userId))!;
  if (user.primaryEmailAddressId === emailId) {
    const next = (await listEmails(ctx, userId))[0];
    await ctx.db.update(s.users).set({ primaryEmailAddressId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.users.id, userId));
  }
}

export async function deletePhoneNumber(ctx: AppContext, userId: string, phoneId: string) {
  const row = first(await ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, phoneId), eq(s.phoneNumbers.userId, userId))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
  await assertNotLastIdentification(ctx, userId);
  await ctx.db.delete(s.phoneNumbers).where(eq(s.phoneNumbers.id, phoneId));
  const user = (await getUserById(ctx, userId))!;
  if (user.primaryPhoneNumberId === phoneId) {
    const next = (await listPhones(ctx, userId))[0];
    await ctx.db.update(s.users).set({ primaryPhoneNumberId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.users.id, userId));
  }
}

/** Locks the account after too many failed attempts (per settings.mfa.maxAttempts / lockoutDurationSeconds). */
export async function recordFailedAttempt(ctx: AppContext, userId: string) {
  const st = ctx.settings.get();
  const now = Date.now();
  // One statement so parallel wrong passwords cannot lose increments and slip under the lockout threshold.
  const updated = first(await ctx.db.update(s.users)
    .set({ failedAttempts: sql`${s.users.failedAttempts} + 1`, updatedAt: now })
    .where(eq(s.users.id, userId))
    .returning());
  if (!updated || updated.failedAttempts < st.mfa.maxAttempts) return;
  await ctx.db.update(s.users).set({
            failedAttempts: 0,
            locked: true,
            lockoutExpiresAt: now + st.mfa.lockoutDurationSeconds * 1000,
            updatedAt: now,
          }).where(eq(s.users.id, userId));
  // A locked account must not keep a browser that can walk past the second factor.
  await revokeAllTrustedDevices(ctx, userId);
}

export async function resetFailedAttempts(ctx: AppContext, userId: string) {
  await ctx.db.update(s.users).set({ failedAttempts: 0, locked: false, lockoutExpiresAt: null, updatedAt: Date.now() }).where(eq(s.users.id, userId));
}

export async function touchUser(ctx: AppContext, userId: string, patch: Partial<Pick<UserRow, "lastActiveAt" | "lastSignInAt">> = {}) {
  await ctx.db.update(s.users).set({ ...patch, updatedAt: Date.now() }).where(eq(s.users.id, userId));
}

/** Deletes a user (cascade removes sessions/identifications), emits `user.deleted`, notifies orgs service. */
export async function deleteUser(ctx: AppContext, userId: string): Promise<{ id: string }> {
  const user = await getUserById(ctx, userId);
  if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
  const json = await serializeUser(ctx, user, { backend: true });
  await ctx.db.delete(s.sessions).where(eq(s.sessions.userId, userId));
  await ctx.db.delete(s.users).where(eq(s.users.id, userId));
  void json;
  await emitEvent(ctx, "user.deleted", { object: "user", id: userId, deleted: true });
  await onUserDeleted(ctx, userId);
  return { id: userId };
}

/** All users with the given verified email (used by OAuth linking). */
export async function findUserByVerifiedEmail(ctx: AppContext, email: string): Promise<UserRow | undefined> {
  const row = first(await ctx.db.select().from(s.emailAddresses)
      .where(and(eq(s.emailAddresses.email, normalizeEmail(email)), eq(s.emailAddresses.verified, true))));
  return row?.userId ? await getUserById(ctx, row.userId) : undefined;
}

/**
 * A guest account becomes a regular one as soon as it gains a verified way to be found again: a verified email address,
 * a verified phone number or a connected external account. Every `/me` mutation that can do
 * that funnels through here, so the flag can never get out of sync.
 */
export async function hasVerifiedIdentifier(ctx: AppContext, userId: string): Promise<boolean> {
  return (await listEmails(ctx, userId)).some((e) => e.verified)
    || (await listPhones(ctx, userId)).some((p) => p.verified)
    || (await ctx.db.select({ id: s.externalAccounts.id }).from(s.externalAccounts).where(eq(s.externalAccounts.userId, userId))).length > 0;
}

export async function upgradeAnonymousUser(ctx: AppContext, userId: string): Promise<UserRow | undefined> {
  const user = await getUserById(ctx, userId);
  if (!user || !user.isAnonymous) return user;
  // A password alone never upgrades a guest: only a verified way to be found again does, and that identifier has
  // already passed the sign-up restrictions (see the /me routes that add one).
  if (!(await hasVerifiedIdentifier(ctx, userId))) return user;
  await ctx.db.update(s.users).set({ isAnonymous: false, updatedAt: Date.now() }).where(eq(s.users.id, userId));
  return getUserById(ctx, userId);
}
