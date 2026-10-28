// OWNER: W4 machine — machine-to-machine identities: machine secrets, opaque/JWT tokens, revocation.
import { asc, desc, eq, sql } from "drizzle-orm";
import { jwtVerify, importJWK, type JWK } from "jose";
import { ErrorCodes, ID_PREFIX, OrbitError, type M2MMachineJSON, type M2MTokenJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { randomToken, sha256, safeEqual } from "../lib/crypto";
import { newId } from "../lib/ids";
import { getJwks, signJwt } from "./tokens";

type MachineRow = typeof s.machines.$inferSelect;
type TokenRow = typeof s.m2mTokens.$inferSelect;

export const MACHINE_SECRET_PREFIX = "mk_";
export const MACHINE_TOKEN_PREFIX = "mt_";
export const M2M_TOKEN_AUDIENCE = "orbitid-m2m";

export type TokenFormat = "opaque" | "jwt";

export function serializeMachine(row: MachineRow): M2MMachineJSON {
  return {
    object: "machine",
    id: row.id,
    name: row.name,
    scoped_machines: row.scopedMachines ?? [],
    default_token_ttl: row.defaultTokenTtl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeMachineToken(row: TokenRow, opts: { token?: string } = {}): M2MTokenJSON {
  const json: M2MTokenJSON = {
    object: "machine_token",
    id: row.id,
    machine_id: row.machineId,
    claims: row.claims ?? null,
    revoked: row.revoked,
    expired: row.expiresAt != null && row.expiresAt <= Date.now(),
    expiration: row.expiresAt ?? null,
    created_at: row.createdAt,
  };
  if (opts.token) json.token = opts.token;
  return json;
}

export function generateMachineSecret(): string {
  return `${MACHINE_SECRET_PREFIX}${randomToken(24)}`;
}

export function getMachine(ctx: AppContext, id: string): MachineRow | null {
  return ctx.db.select().from(s.machines).where(eq(s.machines.id, id)).get() ?? null;
}

export function listMachines(ctx: AppContext, opts: { limit?: number; offset?: number } = {}): { data: MachineRow[]; totalCount: number } {
  const data = ctx.db.select().from(s.machines).orderBy(desc(s.machines.createdAt)).limit(opts.limit ?? 10).offset(opts.offset ?? 0).all();
  const totalCount = ctx.db.select({ n: sql<number>`count(*)` }).from(s.machines).get()?.n ?? 0;
  return { data, totalCount };
}

export function requireMachine(ctx: AppContext, id: string): MachineRow {
  const row = getMachine(ctx, id);
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Machine not found");
  return row;
}

export function createMachine(ctx: AppContext, input: { name: string; scopedMachines?: string[]; defaultTokenTtl?: number }): { row: MachineRow; secret: string } {
  const secret = generateMachineSecret();
  const now = Date.now();
  const row: MachineRow = {
    id: newId(ID_PREFIX.machine),
    name: input.name,
    secretHash: sha256(secret),
    scopedMachines: input.scopedMachines ?? [],
    defaultTokenTtl: input.defaultTokenTtl ?? 3600,
    createdAt: now,
    updatedAt: now,
  };
  ctx.db.insert(s.machines).values(row).run();
  return { row, secret };
}

export function updateMachine(ctx: AppContext, row: MachineRow, patch: { name?: string; scopedMachines?: string[]; defaultTokenTtl?: number }): MachineRow {
  const set: Partial<MachineRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.scopedMachines !== undefined) set.scopedMachines = patch.scopedMachines;
  if (patch.defaultTokenTtl !== undefined) set.defaultTokenTtl = patch.defaultTokenTtl;
  ctx.db.update(s.machines).set(set).where(eq(s.machines.id, row.id)).run();
  return getMachine(ctx, row.id)!;
}

/** Deleting a machine revokes it everywhere; its tokens cascade. */
export function deleteMachine(ctx: AppContext, row: MachineRow): void {
  ctx.db.delete(s.machines).where(eq(s.machines.id, row.id)).run();
}

/** Adds `scopedMachineId` to the machine's scopes. Idempotent. */
export function addMachineScope(ctx: AppContext, row: MachineRow, scopedMachineId: string): MachineRow {
  if (scopedMachineId === row.id) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "A machine cannot scope itself", { param_name: "scoped_machine_id" });
  const target = requireMachine(ctx, scopedMachineId);
  const scopes = new Set(row.scopedMachines ?? []);
  scopes.add(target.id);
  return updateMachine(ctx, row, { scopedMachines: [...scopes] });
}

/** Rotates the machine secret; the previous secret stops working immediately. */
export function rotateMachineSecret(ctx: AppContext, row: MachineRow): { row: MachineRow; secret: string } {
  const secret = generateMachineSecret();
  ctx.db.update(s.machines).set({ secretHash: sha256(secret), updatedAt: Date.now() }).where(eq(s.machines.id, row.id)).run();
  return { row: getMachine(ctx, row.id)!, secret };
}

export function authenticateMachineSecret(ctx: AppContext, secret: string): MachineRow | null {
  if (typeof secret !== "string" || !secret.startsWith(MACHINE_SECRET_PREFIX)) return null;
  const hash = sha256(secret);
  const row = ctx.db.select().from(s.machines).where(eq(s.machines.secretHash, hash)).get();
  return row && safeEqual(row.secretHash, hash) ? row : null;
}

export interface IssueTokenInput {
  secondsUntilExpiration?: number | null;
  claims?: Record<string, unknown> | null;
  tokenFormat?: TokenFormat;
}

/** Issues an `mt_...` opaque token (hashed at rest) or an RS256 JWT bound to the machine. */
export async function issueMachineToken(ctx: AppContext, machine: MachineRow, input: IssueTokenInput = {}): Promise<{ row: TokenRow; token: string }> {
  const format: TokenFormat = input.tokenFormat ?? "opaque";
  const ttl = input.secondsUntilExpiration ?? machine.defaultTokenTtl;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "seconds_until_expiration must be positive", { param_name: "seconds_until_expiration" });
  const expiresAt = Date.now() + Math.floor(ttl) * 1000;
  const id = newId(ID_PREFIX.m2mToken);
  const claims: Record<string, unknown> = {
    ...(input.claims ?? {}),
    sub: machine.id,
    scopes: machine.scopedMachines ?? [],
    jti: id,
  };

  let token: string;
  if (format === "jwt") {
    token = await signJwt(ctx, claims, { expiresInSeconds: Math.floor(ttl), issuer: ctx.env.baseUrl, audience: M2M_TOKEN_AUDIENCE });
  } else if (format === "opaque") {
    token = `${MACHINE_TOKEN_PREFIX}${randomToken(24)}`;
  } else {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "token_format must be 'opaque' or 'jwt'", { param_name: "token_format" });
  }

  const row: TokenRow = {
    id,
    machineId: machine.id,
    tokenHash: sha256(token),
    claims,
    revoked: false,
    expiresAt,
    createdAt: Date.now(),
  };
  ctx.db.insert(s.m2mTokens).values(row).run();
  return { row, token };
}

/** Resolves the instance signing key (by kid when the JWT names one) for verification. */
async function instanceVerifyKey(ctx: AppContext, kid: string | undefined) {
  const { keys } = await getJwks(ctx);
  const jwk = keys.find((k) => (kid ? k.kid === kid : true));
  if (!jwk) throw new OrbitError(401, ErrorCodes.authorization_invalid, "Unknown signing key");
  return jwk;
}

/**
 * Verifies an opaque machine token or a JWT machine token. Honours signature, issuer, revocation,
 * expiry and the machine's current scoping (JWT scopes are re-read from the machine row).
 */
export async function verifyMachineToken(ctx: AppContext, token: string): Promise<{ row: TokenRow; machine: MachineRow }> {
  const invalid = (message = "Invalid machine token") => new OrbitError(401, ErrorCodes.authorization_invalid, message);
  if (typeof token !== "string" || token.length === 0) throw invalid();
  const row = ctx.db.select().from(s.m2mTokens).where(eq(s.m2mTokens.tokenHash, sha256(token))).get();
  if (!row) throw invalid();
  if (row.revoked) throw invalid("Machine token has been revoked");
  if (row.expiresAt != null && row.expiresAt <= Date.now()) throw invalid("Machine token has expired");
  const machine = getMachine(ctx, row.machineId);
  if (!machine) throw invalid("Machine no longer exists");

  if (!token.startsWith(MACHINE_TOKEN_PREFIX)) {
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, async (header) => {
        const jwk = await instanceVerifyKey(ctx, header.kid);
        return importJWK(jwk, header.alg ?? "RS256");
      }, { issuer: ctx.env.baseUrl, audience: M2M_TOKEN_AUDIENCE });
      sub = payload.sub;
    } catch (err) {
      throw err instanceof OrbitError ? err : invalid("Machine token signature is invalid");
    }
    if (sub !== machine.id) throw invalid("Machine token subject mismatch");
  }
  return { row, machine };
}

export function revokeMachineToken(ctx: AppContext, row: TokenRow): TokenRow {
  if (!row.revoked) ctx.db.update(s.m2mTokens).set({ revoked: true }).where(eq(s.m2mTokens.id, row.id)).run();
  return { ...row, revoked: true };
}

export function listMachineTokens(ctx: AppContext, opts: { machineId?: string; limit?: number; offset?: number; orderBy?: string } = {}): { data: TokenRow[]; totalCount: number } {
  const where = opts.machineId ? eq(s.m2mTokens.machineId, opts.machineId) : undefined;
  const raw = (opts.orderBy ?? "-created_at").trim();
  const desc_ = raw.startsWith("-");
  const col = raw.replace(/^-/, "") === "expires_at" ? s.m2mTokens.expiresAt : s.m2mTokens.createdAt;
  const data = ctx.db.select().from(s.m2mTokens).where(where).orderBy(desc_ ? desc(col) : asc(col))
    .limit(opts.limit ?? 10).offset(opts.offset ?? 0).all();
  const totalCount = ctx.db.select({ n: sql<number>`count(*)` }).from(s.m2mTokens).where(where).get()?.n ?? 0;
  return { data, totalCount };
}

export function requireMachineToken(ctx: AppContext, id: string): TokenRow {
  const row = ctx.db.select().from(s.m2mTokens).where(eq(s.m2mTokens.id, id)).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Machine token not found");
  return row;
}
