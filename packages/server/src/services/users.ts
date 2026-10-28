// OWNER: worker "core" (W1). Reusable user/identifier helpers (also used by the Backend API).
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { serializeUser } from "../serializers";
import { emitEvent } from "./webhooks";
import { onUserDeleted, onUserEmailVerified } from "./orgs";

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

export const getUserById = (ctx: AppContext, id: string): UserRow | undefined =>
  ctx.db.select().from(s.users).where(eq(s.users.id, id)).get();

export function requireUser(ctx: AppContext, id: string): UserRow {
  const u = getUserById(ctx, id);
  if (!u) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
  return u;
}

export const findEmail = (ctx: AppContext, email: string): EmailRow | undefined =>
  ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, normalizeEmail(email))).get();

export const findPhone = (ctx: AppContext, phone: string): PhoneRow | undefined =>
  ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, normalizePhone(phone))).get();

export const listEmails = (ctx: AppContext, userId: string): EmailRow[] =>
  ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, userId)).all();

export const listPhones = (ctx: AppContext, userId: string): PhoneRow[] =>
  ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, userId)).all();

export function primaryEmail(ctx: AppContext, user: UserRow): EmailRow | undefined {
  if (user.primaryEmailAddressId) {
    const row = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId)).get();
    if (row) return row;
  }
  return listEmails(ctx, user.id)[0];
}

export function primaryPhone(ctx: AppContext, user: UserRow): PhoneRow | undefined {
  if (user.primaryPhoneNumberId) {
    const row = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.id, user.primaryPhoneNumberId)).get();
    if (row) return row;
  }
  return listPhones(ctx, user.id)[0];
}

/** Finds a user by email address, phone number or username. */
export function getUserByIdentifier(ctx: AppContext, identifier: string): { user: UserRow; type: IdentifierType } | null {
  const v = identifier.trim();
  if (!v) return null;
  const type = detectIdentifierType(v);
  if (type === "email_address") {
    const e = findEmail(ctx, v);
    if (!e?.userId) return null;
    const user = getUserById(ctx, e.userId);
    return user ? { user, type } : null;
  }
  if (type === "phone_number") {
    let phone: string | undefined;
    try { phone = normalizePhone(v); } catch { return null; }
    const p = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)).get();
    if (!p?.userId) return null;
    const user = getUserById(ctx, p.userId);
    return user ? { user, type } : null;
  }
  const u = ctx.db.select().from(s.users).where(eq(s.users.usernameLower, v.toLowerCase())).get();
  return u ? { user: u, type } : null;
}

export const findUserByUsername = (ctx: AppContext, username: string): UserRow | undefined =>
  ctx.db.select().from(s.users).where(eq(s.users.usernameLower, username.toLowerCase())).get();

/** Username syntax + length + uniqueness. Throws OrbitError. */
export function assertUsernameAvailable(ctx: AppContext, username: string, exceptUserId?: string) {
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
  const existing = findUserByUsername(ctx, username);
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
    !input.username
  ) {
    throw new OrbitError(422, ErrorCodes.form_param_missing, "At least one identifier is required");
  }
  if (email) {
    if (!isValidEmail(email)) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email_address is not valid", { param_name: "email_address" });
    const existing = findEmail(ctx, email);
    if (existing?.verified || (existing?.userId && !input.silent)) {
      throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That email address is already in use", { param_name: "email_address" });
    }
  }
  if (phone) {
    const existing = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.phone, phone)).get();
    if (existing?.userId) throw new OrbitError(422, ErrorCodes.form_identifier_exists, "That phone number is already in use", { param_name: "phone_number" });
  }
  if (input.username) assertUsernameAvailable(ctx, input.username);

  const id = newId("user");
  const verified = !!input.emailVerified;
  ctx.db.insert(s.users).values({
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
    lastSignInAt: null,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();

  if (email) {
    const emailId = newId("idn_e");
    ctx.db.insert(s.emailAddresses).values({
      id: emailId, userId: id, email, verified, verifiedAt: verified ? now : null,
      verifiedStrategy: verified ? input.emailVerifiedStrategy ?? "email_code" : null, createdAt: now, updatedAt: now,
    }).run();
    ctx.db.update(s.users).set({ primaryEmailAddressId: emailId }).where(eq(s.users.id, id)).run();
  }
  if (phone) {
    const phoneId = newId("idn_p");
    ctx.db.insert(s.phoneNumbers).values({
      id: phoneId, userId: id, phone, verified: !!input.phoneVerified, verifiedAt: input.phoneVerified ? now : null, createdAt: now, updatedAt: now,
    }).run();
    ctx.db.update(s.users).set({ primaryPhoneNumberId: phoneId }).where(eq(s.users.id, id)).run();
  }

  const user = getUserById(ctx, id)!;
  if (!input.silent) {
    const json = serializeUser(ctx, user, { backend: true });
    await emitEvent(ctx, "user.created", json);
  }
  if (email && verified) await onUserEmailVerified(ctx, id, email);
  return user;
}

export function setPrimaryEmail(ctx: AppContext, userId: string, emailId: string) {
  const row = ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, emailId), eq(s.emailAddresses.userId, userId))).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
  ctx.db.update(s.users).set({ primaryEmailAddressId: emailId, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
  return row;
}

export function setPrimaryPhone(ctx: AppContext, userId: string, phoneId: string) {
  const row = ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, phoneId), eq(s.phoneNumbers.userId, userId))).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
  ctx.db.update(s.users).set({ primaryPhoneNumberId: phoneId, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
  return row;
}

export function countIdentifications(ctx: AppContext, userId: string): number {
  const emails = ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, userId)).all().length;
  const phones = ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, userId)).all().length;
  const externals = ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, userId)).all().length;
  const passkeys = ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, userId)).all().filter((p) => !p.credentialId.startsWith("pending_")).length;
  const username = getUserById(ctx, userId)?.username ? 1 : 0;
  return emails + phones + externals + passkeys + username;
}

/** Rejects removing the only way a user can sign in. */
export function assertNotLastIdentification(ctx: AppContext, userId: string) {
  if (countIdentifications(ctx, userId) <= 1) {
    throw new OrbitError(422, ErrorCodes.last_identification_cannot_be_removed, "You cannot remove your last identification");
  }
}

export function deleteEmailAddress(ctx: AppContext, userId: string, emailId: string) {
  const row = ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.id, emailId), eq(s.emailAddresses.userId, userId))).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Email address not found");
  assertNotLastIdentification(ctx, userId);
  ctx.db.delete(s.emailAddresses).where(eq(s.emailAddresses.id, emailId)).run();
  const user = getUserById(ctx, userId)!;
  if (user.primaryEmailAddressId === emailId) {
    const next = listEmails(ctx, userId)[0];
    ctx.db.update(s.users).set({ primaryEmailAddressId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
  }
}

export function deletePhoneNumber(ctx: AppContext, userId: string, phoneId: string) {
  const row = ctx.db.select().from(s.phoneNumbers).where(and(eq(s.phoneNumbers.id, phoneId), eq(s.phoneNumbers.userId, userId))).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Phone number not found");
  assertNotLastIdentification(ctx, userId);
  ctx.db.delete(s.phoneNumbers).where(eq(s.phoneNumbers.id, phoneId)).run();
  const user = getUserById(ctx, userId)!;
  if (user.primaryPhoneNumberId === phoneId) {
    const next = listPhones(ctx, userId)[0];
    ctx.db.update(s.users).set({ primaryPhoneNumberId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
  }
}

/** Locks the account after too many failed attempts (per settings.mfa.maxAttempts / lockoutDurationSeconds). */
export function recordFailedAttempt(ctx: AppContext, userId: string) {
  const st = ctx.settings.get();
  const user = getUserById(ctx, userId);
  if (!user) return;
  const attempts = user.failedAttempts + 1;
  const shouldLock = attempts >= st.mfa.maxAttempts;
  ctx.db.update(s.users).set({
    failedAttempts: shouldLock ? 0 : attempts,
    locked: shouldLock ? true : user.locked,
    lockoutExpiresAt: shouldLock ? Date.now() + st.mfa.lockoutDurationSeconds * 1000 : user.lockoutExpiresAt,
    updatedAt: Date.now(),
  }).where(eq(s.users.id, userId)).run();
}

export function resetFailedAttempts(ctx: AppContext, userId: string) {
  ctx.db.update(s.users).set({ failedAttempts: 0, locked: false, lockoutExpiresAt: null, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
}

export function touchUser(ctx: AppContext, userId: string, patch: Partial<Pick<UserRow, "lastActiveAt" | "lastSignInAt">> = {}) {
  ctx.db.update(s.users).set({ ...patch, updatedAt: Date.now() }).where(eq(s.users.id, userId)).run();
}

/** Deletes a user (cascade removes sessions/identifications), emits `user.deleted`, notifies orgs service. */
export async function deleteUser(ctx: AppContext, userId: string): Promise<{ id: string }> {
  const user = getUserById(ctx, userId);
  if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
  const json = serializeUser(ctx, user, { backend: true });
  ctx.db.delete(s.sessions).where(eq(s.sessions.userId, userId)).run();
  ctx.db.delete(s.users).where(eq(s.users.id, userId)).run();
  void json;
  await emitEvent(ctx, "user.deleted", { object: "user", id: userId, deleted: true });
  await onUserDeleted(ctx, userId);
  return { id: userId };
}

/** All users with the given verified email (used by OAuth linking). */
export function findUserByVerifiedEmail(ctx: AppContext, email: string): UserRow | undefined {
  const row = ctx.db.select().from(s.emailAddresses)
    .where(and(eq(s.emailAddresses.email, normalizeEmail(email)), eq(s.emailAddresses.verified, true)))
    .get();
  return row?.userId ? getUserById(ctx, row.userId) : undefined;
}
