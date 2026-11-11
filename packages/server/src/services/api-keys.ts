// API keys (`ak_live_...`), one-time secret display, hash-at-rest, scopes/claims/expiry/revocation.
import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError, type ApiKeyJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { permissionsForRole } from "../serializers";
import { emitEvent } from "./webhooks";
import { first } from "../lib/db";

type ApiKeyRow = typeof s.apiKeys.$inferSelect;

const SECRET_PREFIX = "ak_live_";
/** Visible prefix length (kept in the DB so UIs can show which key it is). */
const PREFIX_LENGTH = 12;
/** Custom org permission that grants API-key management, alongside `org:sys_profile:manage`. */
export const ORG_API_KEYS_PERMISSION = "org:sys_api_keys:manage";
const ORG_PROFILE_MANAGE = "org:sys_profile:manage";
const ADMIN_ROLE = "org:admin";

/** New one-time API key secret: `ak_live_` + 32 url-safe random characters. */
export function generateApiKeySecret(): string {
  return `${SECRET_PREFIX}${randomToken(24)}`;
}

export function serializeApiKey(row: ApiKeyRow, opts: { secret?: string } = {}): ApiKeyJSON {
  const json: ApiKeyJSON = {
    object: "api_key",
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    subject: row.subject,
    prefix: row.prefix,
    scopes: row.scopes ?? [],
    claims: row.claims ?? null,
    revoked: row.revoked,
    expiration: row.expiresAt ?? null,
    last_used_at: row.lastUsedAt ?? null,
    created_by: row.createdBy ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (opts.secret) json.secret = opts.secret;
  return json;
}

/** Keys are only valid while they are not revoked and not expired. */
export function isApiKeyValid(row: ApiKeyRow, at = Date.now()): boolean {
  return !row.revoked && (row.expiresAt == null || row.expiresAt > at);
}

async function assertSubjectExists(ctx: AppContext, subject: string): Promise<void> {
  if (subject.startsWith("user_")) {
    if (!first(await ctx.db.select().from(s.users).where(eq(s.users.id, subject)))) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "subject does not match an existing user", { param_name: "subject" });
    }
    return;
  }
  if (subject.startsWith("org_")) {
    if (!first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, subject)))) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "subject does not match an existing organization", { param_name: "subject" });
    }
    return;
  }
  throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "subject must be a user_... or org_... id", { param_name: "subject" });
}

export interface CreateApiKeyInput {
  name: string;
  subject: string;
  scopes?: string[];
  claims?: Record<string, unknown> | null;
  secondsUntilExpiration?: number | null;
  description?: string | null;
  createdBy?: string | null;
}

/** Creates a key and returns the row plus the plaintext secret (shown exactly once). */
export async function createApiKey(ctx: AppContext, input: CreateApiKeyInput): Promise<{ row: ApiKeyRow; secret: string }> {
  await assertSubjectExists(ctx, input.subject);
  const secret = generateApiKeySecret();
  const now = Date.now();
  const row: ApiKeyRow = {
    id: newId(ID_PREFIX.apiKey),
    name: input.name,
    description: input.description ?? null,
    subject: input.subject,
    prefix: secret.slice(0, PREFIX_LENGTH),
    secretHash: sha256(secret),
    scopes: input.scopes ?? [],
    claims: input.claims ?? null,
    revoked: false,
    revocationReason: null,
    expiresAt: input.secondsUntilExpiration ? now + input.secondsUntilExpiration * 1000 : null,
    lastUsedAt: null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.insert(s.apiKeys).values(row);
  void emitEvent(ctx, "apiKey.created", serializeApiKey(row));
  return { row, secret };
}

export async function getApiKey(ctx: AppContext, id: string): Promise<ApiKeyRow | null> {
  return first(await ctx.db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id))) ?? null;
}

export async function requireApiKey(ctx: AppContext, id: string): Promise<ApiKeyRow> {
  const row = await getApiKey(ctx, id);
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "API key not found");
  return row;
}

export interface ListApiKeysOptions {
  subject?: string;
  includeInvalid?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: string;
}

const ORDER_COLUMNS = { created_at: s.apiKeys.createdAt, updated_at: s.apiKeys.updatedAt, name: s.apiKeys.name, last_used_at: s.apiKeys.lastUsedAt } as const;

function orderFor(orderBy: string | undefined) {
  const raw = (orderBy ?? "-created_at").trim();
  const desc_ = raw.startsWith("-");
  const key = (desc_ ? raw.slice(1) : raw) as keyof typeof ORDER_COLUMNS;
  const col = ORDER_COLUMNS[key] ?? s.apiKeys.createdAt;
  return desc_ ? desc(col) : asc(col);
}

export async function listApiKeys(ctx: AppContext, opts: ListApiKeysOptions = {}): Promise<{ data: ApiKeyRow[]; totalCount: number }> {
  const now = Date.now();
  const filters = [];
  if (opts.subject) filters.push(eq(s.apiKeys.subject, opts.subject));
  if (!opts.includeInvalid) {
    filters.push(eq(s.apiKeys.revoked, false));
    filters.push(or(isNull(s.apiKeys.expiresAt), gt(s.apiKeys.expiresAt, now))!);
  }
  const where = filters.length ? and(...filters) : undefined;
  const data = (await ctx.db.select().from(s.apiKeys)
      .where(where)
      .orderBy(orderFor(opts.orderBy))
      .limit(opts.limit ?? 10)
      .offset(opts.offset ?? 0));
  const totalCount = first(await ctx.db.select({ n: count() }).from(s.apiKeys).where(where))?.n ?? 0;
  return { data, totalCount };
}

export interface UpdateApiKeyInput {
  name?: string;
  description?: string | null;
  scopes?: string[];
  claims?: Record<string, unknown> | null;
}

export async function updateApiKey(ctx: AppContext, row: ApiKeyRow, patch: UpdateApiKeyInput): Promise<ApiKeyRow> {
  const set: Partial<ApiKeyRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (patch.claims !== undefined) set.claims = patch.claims;
  await ctx.db.update(s.apiKeys).set(set).where(eq(s.apiKeys.id, row.id));
  return (await getApiKey(ctx, row.id))!;
}

export async function revokeApiKey(ctx: AppContext, row: ApiKeyRow, reason?: string | null): Promise<ApiKeyRow> {
  const revoked = first(await ctx.db.update(s.apiKeys).set({ revoked: true, revocationReason: reason ?? null, updatedAt: Date.now() })
    .where(and(eq(s.apiKeys.id, row.id), eq(s.apiKeys.revoked, false)))
    .returning());
  if (!revoked) return row;
  void emitEvent(ctx, "apiKey.revoked", serializeApiKey(revoked));
  return revoked;
}

/** Deletes the key (returns the deleted object's id). Emits `apiKey.revoked` — deletion revokes the credential. */
export async function deleteApiKey(ctx: AppContext, row: ApiKeyRow): Promise<void> {
  await ctx.db.delete(s.apiKeys).where(eq(s.apiKeys.id, row.id));
  void emitEvent(ctx, "apiKey.revoked", serializeApiKey({ ...row, revoked: true }));
}

/**
 * Validates a plaintext secret, updates `last_used_at` and returns the key row.
 * Throws `401 api_key_invalid` for unknown, revoked, expired or orphaned keys.
 */
export async function verifyApiKey(ctx: AppContext, secret: string, opts: { touch?: boolean } = {}): Promise<ApiKeyRow> {
  const invalid = () => new OrbitError(401, ErrorCodes.api_key_invalid, "Invalid API key");
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) throw invalid();
  const row = first(await ctx.db.select().from(s.apiKeys).where(eq(s.apiKeys.secretHash, sha256(secret))));
  if (!row) throw invalid();
  if (!isApiKeyValid(row)) throw invalid();
  if (!await subjectUsable(ctx, row.subject)) throw invalid();
  if (opts.touch !== false) {
    await ctx.db.update(s.apiKeys).set({ lastUsedAt: Date.now() }).where(eq(s.apiKeys.id, row.id));
    return { ...row, lastUsedAt: Date.now() };
  }
  return row;
}

/** A key is only as usable as the account it acts for. Banned or currently-locked users cannot use one. */
async function subjectUsable(ctx: AppContext, subject: string): Promise<boolean> {
  const now = Date.now();
  if (subject.startsWith("user_")) {
    const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, subject)));
    if (!user) return false;
    if (user.banned) return false;
    if (user.locked && (!user.lockoutExpiresAt || user.lockoutExpiresAt > now)) return false;
    return true;
  }
  if (subject.startsWith("org_")) return !!first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, subject)));
  return false;
}

/** Banning a subject is a credential revocation, not a flag the verifier merely reads later. */
export async function revokeApiKeysForSubject(ctx: AppContext, subject: string, reason = "subject revoked"): Promise<number> {
  const rows = (await ctx.db.select().from(s.apiKeys)
      .where(and(eq(s.apiKeys.subject, subject), eq(s.apiKeys.revoked, false))));
  for (const row of rows) await revokeApiKey(ctx, row, reason);
  return rows.length;
}

/**
 * Org-level authorization for `/organizations/:orgId/api_keys`: admin role, `org:sys_profile:manage`
 * or the custom `org:sys_api_keys:manage` permission.
 */
export async function assertOrgApiKeysPermission(ctx: AppContext, userId: string, organizationId: string): Promise<typeof s.organizationMemberships.$inferSelect> {
  const membership = first(await ctx.db.select().from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, organizationId), eq(s.organizationMemberships.userId, userId))));
  if (!membership) throw new OrbitError(403, ErrorCodes.not_a_member_in_organization, "You are not a member of this organization");
  if (membership.roleKey === ADMIN_ROLE) return membership;
  const granted = await permissionsForRole(ctx, membership.roleKey);
  if (granted.includes(ORG_PROFILE_MANAGE) || granted.includes(ORG_API_KEYS_PERMISSION)) return membership;
  throw new OrbitError(403, ErrorCodes.org_permission_required, `Missing permission ${ORG_API_KEYS_PERMISSION}`);
}

/** A key belongs to the caller's subject only (Frontend API). */
export function assertApiKeyOwnership(row: ApiKeyRow, subject: string): void {
  if (row.subject !== subject) throw new OrbitError(404, ErrorCodes.resource_not_found, "API key not found");
}
