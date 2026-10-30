// OIDC/OAuth2 provider service: applications, authorization codes, tokens, consent, device grant.
//
// Storage notes:
//  - codes/access/refresh tokens are random opaque strings; only sha256 hashes are stored in `oauth_grants`.
//  - `family_id` ties the access and refresh tokens of one authorization together (refresh rotation and reuse
//    detection); `session_id` keeps `sid` and the org claims tied to the authorizing session; `nonce` is the
//    OIDC nonce of an authorization code.
import { createHash, randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ErrorCodes, ID_PREFIX, OrbitError, type OAuthApplicationJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { randomToken, safeEqual, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { getMembershipContext } from "../orgs";
import { getJwks, signJwt } from "../tokens";
import { first } from "../../lib/db";
import { type ApplicationRow, type DeviceCodeRow } from "./shared";
import { getApplication, parseScopes } from "./applications";
import { issueTokenSet, type TokenSet } from "./tokens";

// ───────────── device authorization grant (RFC 8628) ─────────────

/** Unambiguous alphabet: no 0/O, 1/I/L, so a code read off a TV can be typed back without guessing. */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
export const USER_CODE_LENGTH = 8;

export function generateUserCode(): string {
  let raw = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) raw += USER_CODE_ALPHABET[randomInt(0, USER_CODE_ALPHABET.length)];
  return raw;
}

/** `ABCD1234` → `ABCD-1234` (the form users see). */
export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Normalizes typed input: upper-case, separators and whitespace removed. Returns null when it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s\-_]/g, "");
  if (raw.length !== USER_CODE_LENGTH) return null;
  for (const ch of raw) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return raw;
}

/** Device codes are bearer secrets: only their hash is stored, and lookups compare in constant time. */
export const deviceCodeHash = (code: string) => sha256(`device:${code}`);

export interface DeviceAuthorizationInput {
  application: ApplicationRow;
  scopes: string[];
}

export interface DeviceAuthorization {
  deviceCode: string;
  row: DeviceCodeRow;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/** A user code collides when another row already holds it; both dialects report it as a unique violation. */
const isUserCodeCollision = (err: unknown) => {
  const code = String((err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "");
  return code === "23505" || code.includes("CONSTRAINT_UNIQUE");
};

/** `POST /oauth/device_authorization`: creates a pending device code and its short user code. */
export async function createDeviceAuthorization(ctx: AppContext, input: DeviceAuthorizationInput): Promise<DeviceAuthorization> {
  const settings = ctx.settings.get().oidcProvider;
  const deviceCode = `odc_${randomToken(32)}`;
  const now = Date.now();
  // A collision on an 8-char code is vanishingly unlikely; retry a few times rather than fail the request.
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      const row: DeviceCodeRow = {
        id: newId(ID_PREFIX.oauthGrant),
        applicationId: input.application.id,
        deviceCodeHash: deviceCodeHash(deviceCode),
        userCode,
        scopes: input.scopes.join(" "),
        status: "pending",
        userId: null,
        intervalSeconds: settings.deviceCodeIntervalSeconds,
        lastPolledAt: null,
        expiresAt: now + settings.deviceCodeLifetimeSeconds * 1000,
        createdAt: now,
      };
      await ctx.db.insert(s.deviceCodes).values(row);
      return { deviceCode, row, intervalSeconds: row.intervalSeconds, expiresInSeconds: settings.deviceCodeLifetimeSeconds };
    } catch (err) {
      if (attempt < 5 && isUserCodeCollision(err)) continue;
      throw err;
    }
  }
}

/** Looks up a pending/approved device code by its secret, comparing hashes in constant time. */
export async function findDeviceGrant(ctx: AppContext, deviceCode: string): Promise<DeviceCodeRow | null> {
  const hash = deviceCodeHash(deviceCode);
  const row = first(await ctx.db.select().from(s.deviceCodes).where(eq(s.deviceCodes.deviceCodeHash, hash)));
  return row && safeEqual(row.deviceCodeHash, hash) ? row : null;
}

/** Looks up a device row by the user code typed in the browser (stored without the dash). */
export async function findDeviceByUserCode(ctx: AppContext, userCode: string): Promise<DeviceCodeRow | null> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return null;
  return first(await ctx.db.select().from(s.deviceCodes).where(eq(s.deviceCodes.userCode, normalized))) ?? null;
}

/** The application behind a device code, for the consent view. */
export async function deviceApplication(ctx: AppContext, row: DeviceCodeRow): Promise<ApplicationRow | null> {
  return getApplication(ctx, row.applicationId);
}

export type DeviceTokenResult =
  | { ok: true; tokens: TokenSet }
  | { ok: false; error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token"; description: string; intervalSeconds?: number };

/**
 * One poll of `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
 * Enforces the RFC 8628 interval (`slow_down`, which permanently increases the row's interval) and
 * consumes an approved code exactly once.
 */
export async function pollDeviceCode(ctx: AppContext, application: ApplicationRow, deviceCode: string): Promise<DeviceTokenResult> {
  const row = await findDeviceGrant(ctx, deviceCode);
  if (!row || row.applicationId !== application.id) return { ok: false, error: "expired_token", description: "The device code is invalid or has expired" };
  const now = Date.now();
  if (row.expiresAt <= now || row.status === "consumed") {
    return { ok: false, error: "expired_token", description: "The device code is invalid or has expired" };
  }
  if (row.status === "denied") return { ok: false, error: "access_denied", description: "The user denied the request" };

  // RFC 8628 §3.5: polled faster than the interval → slow_down, and the client must back off further.
  const minIntervalMs = row.intervalSeconds * 1000;
  if (row.lastPolledAt && now - row.lastPolledAt < minIntervalMs) {
    const intervalSeconds = row.intervalSeconds + 5;
    await ctx.db.update(s.deviceCodes).set({ intervalSeconds, lastPolledAt: now }).where(eq(s.deviceCodes.id, row.id));
    return { ok: false, error: "slow_down", description: "Polling too quickly; increase the interval", intervalSeconds };
  }
  await ctx.db.update(s.deviceCodes).set({ lastPolledAt: now }).where(eq(s.deviceCodes.id, row.id));

  if (row.status === "pending" || !row.userId) {
    return { ok: false, error: "authorization_pending", description: "The user has not approved this request yet" };
  }

  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) return { ok: false, error: "access_denied", description: "The user is not allowed to sign in" };

  // Claiming the row is the gate: exactly one poll can turn an approval into tokens.
  const claimed = first(await ctx.db.update(s.deviceCodes).set({ status: "consumed", lastPolledAt: now })
    .where(and(eq(s.deviceCodes.id, row.id), eq(s.deviceCodes.status, "approved")))
    .returning({ id: s.deviceCodes.id }));
  if (!claimed) return { ok: false, error: "authorization_pending", description: "The user has not approved this request yet" };

  const tokens = await issueTokenSet(ctx, {
    application,
    user,
    scopes: parseScopes(row.scopes),
    family: randomToken(9),
    nonce: null,
    sessionId: null,
  });
  return { ok: true, tokens };
}

export interface DeviceDecisionInput {
  userCode: string;
  userId: string;
  approve: boolean;
}

export type DeviceDecision =
  | { ok: true; application: ApplicationRow; scopes: string[] }
  | { ok: false; reason: "not_found" | "expired" | "already_decided" };

/** Approves or denies a pending device code on behalf of a signed-in user. Single use. */
export async function decideDeviceCode(ctx: AppContext, input: DeviceDecisionInput): Promise<DeviceDecision> {
  const row = await findDeviceByUserCode(ctx, input.userCode);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (row.status !== "pending") return { ok: false, reason: "already_decided" };
  const application = await getApplication(ctx, row.applicationId);
  if (!application) return { ok: false, reason: "not_found" };

  const claimed = first(await ctx.db.update(s.deviceCodes)
    .set({ status: input.approve ? "approved" : "denied", userId: input.approve ? input.userId : null })
    .where(and(eq(s.deviceCodes.id, row.id), eq(s.deviceCodes.status, "pending"), gt(s.deviceCodes.expiresAt, Date.now())))
    .returning({ id: s.deviceCodes.id }));
  if (!claimed) return { ok: false, reason: "already_decided" };
  return { ok: true, application, scopes: parseScopes(row.scopes) };
}

/** Consumes a user code that was brute-forced too often: the attacker must start over with a new device code. */
export async function burnDeviceCode(ctx: AppContext, row: DeviceCodeRow): Promise<void> {
  await ctx.db.update(s.deviceCodes).set({ status: "denied" }).where(eq(s.deviceCodes.id, row.id));
}
