/** Schemas, filters, and lookups shared by the admin user routes. */
import { type Context } from "hono";
import { and, eq, exists, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as s from "../../../db/schema";
import { type AppContext } from "../../../context";
import { bool, metadataSchema, normalizeEmail, queryValues } from "../shared";
import { containsText } from "../../../lib/db";
import { endSessionsForUser } from "../../../services/sessions";

export const AUDIT_ACTOR = "secret_key";
export const MAX_PROFILE_IMAGE_BYTES = 512 * 1024;
export const emailList = z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(z.string()).max(20).optional());
export const phoneList = z.preprocess((value) => (typeof value === "string" ? [value] : value), z.array(z.string()).max(20).optional());

export const createUserSchema = z.object({
  email_address: emailList,
  phone_number: phoneList,
  username: z.string().min(1).max(64).optional(),
  password: z.string().optional(),
  password_digest: z.string().optional(),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]).optional(),
  skip_password_checks: bool.optional(),
  skip_password_requirement: bool.optional(),
  external_id: z.string().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
  totp_secret: z.string().optional(),
  backup_codes: z.array(z.string()).optional(),
  created_at: z.coerce.number().int().optional(),
  delete_self_enabled: bool.optional(),
  create_organization_enabled: bool.optional(),
  legal_accepted_at: z.coerce.number().int().nullable().optional(),
});

export const updateUserSchema = z.object({
  external_id: z.string().nullable().optional(),
  username: z.string().min(1).max(64).nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  primary_email_address_id: z.string().nullable().optional(),
  primary_phone_number_id: z.string().nullable().optional(),
  password: z.string().optional(),
  password_digest: z.string().optional(),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]).optional(),
  skip_password_checks: bool.optional(),
  sign_out_of_other_sessions: bool.optional(),
  totp_secret: z.string().nullable().optional(),
  backup_codes: z.array(z.string()).nullable().optional(),
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
  delete_self_enabled: bool.optional(),
  create_organization_enabled: bool.optional(),
  create_organizations_limit: z.coerce.number().int().nullable().optional(),
  legal_accepted_at: z.coerce.number().int().nullable().optional(),
});

export const metadataPatchSchema = z.object({
  public_metadata: metadataSchema.optional(),
  private_metadata: metadataSchema.optional(),
  unsafe_metadata: metadataSchema.optional(),
});

/** Applies `query`, array filters, `banned`, `locked`, `mfa`, `last_active_at_since` and date bounds. Array filters are intersected. */
export async function userWhere(ctx: AppContext, c: Context): Promise<SQL | undefined> {
  const conds: SQL[] = [];
  const search = c.req.query("query")?.trim();
  if (search) {
    conds.push(
      or(
        containsText(s.users.id, search),
        containsText(s.users.username, search),
        containsText(s.users.firstName, search),
        containsText(s.users.lastName, search),
        containsText(sql`(coalesce(${s.users.firstName}, '') || ' ' || coalesce(${s.users.lastName}, ''))`, search),
        exists(ctx.db.select({ one: sql`1` }).from(s.emailAddresses).where(and(eq(s.emailAddresses.userId, s.users.id), containsText(s.emailAddresses.email, search)))),
        exists(ctx.db.select({ one: sql`1` }).from(s.phoneNumbers).where(and(eq(s.phoneNumbers.userId, s.users.id), containsText(s.phoneNumbers.phone, search)))),
      )!,
    );
  }

  const allowed: { ids: string[] | null } = { ids: null };
  const restrictTo = (ids: string[]) => {
    if (allowed.ids === null) allowed.ids = ids;
    else {
      const keep = new Set(ids);
      allowed.ids = allowed.ids.filter((id) => keep.has(id));
    }
  };

  const emails = queryValues(c, "email_address").map(normalizeEmail);
  if (emails.length) {
    restrictTo((await ctx.db.select({ id: s.emailAddresses.userId }).from(s.emailAddresses).where(inArray(s.emailAddresses.email, emails))).flatMap((r) => (r.id ? [r.id] : [])));
  }
  const phones = queryValues(c, "phone_number");
  if (phones.length) {
    restrictTo((await ctx.db.select({ id: s.phoneNumbers.userId }).from(s.phoneNumbers).where(inArray(s.phoneNumbers.phone, phones))).flatMap((r) => (r.id ? [r.id] : [])));
  }
  const usernames = queryValues(c, "username").map((u) => u.toLowerCase());
  if (usernames.length) {
    restrictTo((await ctx.db.select({ id: s.users.id }).from(s.users).where(inArray(s.users.usernameLower, usernames))).map((r) => r.id));
  }
  const externalIds = queryValues(c, "external_id");
  if (externalIds.length) {
    restrictTo((await ctx.db.select({ id: s.users.id }).from(s.users).where(inArray(s.users.externalId, externalIds))).map((r) => r.id));
  }
  const userIds = queryValues(c, "user_id");
  if (userIds.length) restrictTo(userIds);
  const orgIds = queryValues(c, "organization_id");
  if (orgIds.length) {
    restrictTo(
      (await ctx.db.select({ id: s.organizationMemberships.userId }).from(s.organizationMemberships).where(inArray(s.organizationMemberships.organizationId, orgIds))).map((r) => r.id),
    );
  }
  if (allowed.ids !== null) conds.push(allowed.ids.length ? inArray(s.users.id, allowed.ids) : sql`1 = 0`);

  const banned = c.req.query("banned");
  if (banned === "true" || banned === "false") conds.push(eq(s.users.banned, banned === "true"));
  const locked = c.req.query("locked");
  if (locked === "true" || locked === "false") conds.push(eq(s.users.locked, locked === "true"));
  const anonymous = c.req.query("is_anonymous");
  if (anonymous === "true" || anonymous === "false") conds.push(eq(s.users.isAnonymous, anonymous === "true"));
  const mfa = c.req.query("mfa");
  if (mfa === "true" || mfa === "false") conds.push(eq(s.users.totpVerified, mfa === "true"));
  const activeSince = c.req.query("last_active_at_since");
  if (activeSince) conds.push(gte(s.users.lastActiveAt, Number(activeSince)));
  const createdAfter = c.req.query("created_at_after");
  if (createdAfter) conds.push(gte(s.users.createdAt, Number(createdAfter)));
  const createdBefore = c.req.query("created_at_before");
  if (createdBefore) conds.push(lt(s.users.createdAt, Number(createdBefore)));

  return conds.length ? and(...conds) : undefined;
}

/** Revokes every open session of a user (ban / password change) and the OIDC grants each authorized. */
export async function revokeSessions(ctx: AppContext, userId: string, exceptSessionId?: string): Promise<void> {
  await endSessionsForUser(ctx, userId, "revoked", exceptSessionId);
}

export const USER_ORDER_COLUMNS = {
  created_at: s.users.createdAt,
  updated_at: s.users.updatedAt,
  last_sign_in_at: s.users.lastSignInAt,
  last_active_at: s.users.lastActiveAt,
  id: s.users.id,
};
