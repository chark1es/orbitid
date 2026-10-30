// Signing keys (RS256, generated on first boot), JWKS, session JWTs.
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, createLocalJWKSet, type JWK, type KeyLike } from "jose";
import { desc, eq } from "drizzle-orm";
import type { SessionClaims, UserJSON } from "@orbitid/shared";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { decrypt, encrypt, randomToken } from "../lib/crypto";
import { serializeUser } from "../serializers";
import { getMembershipContext } from "./orgs";
import { renderTemplateClaims } from "./jwt-templates";
import { roleClaimsForUser } from "./user-roles";
import { RESERVED_SESSION_CLAIMS } from "../lib/reserved-claims";

export { RESERVED_SESSION_CLAIMS };
import { first } from "../lib/db";

const ALG = "RS256";

interface KeyPairCache { privateKey: KeyLike | Uint8Array; publicJwk: JWK }
const keyCache = new WeakMap<AppContext, Map<string, KeyPairCache>>();

const cacheFor = (ctx: AppContext) => {
  let m = keyCache.get(ctx);
  if (!m) { m = new Map(); keyCache.set(ctx, m); }
  return m;
};

/** Generates + persists a new RS256 signing key. The private JWK is encrypted with ORBITID_ENCRYPTION_KEY. */
export async function generateSigningKey(ctx: AppContext, opts: { active?: boolean } = {}) {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const kid = randomToken(9);
  const publicJwk = { ...(await exportJWK(publicKey)), alg: ALG, use: "sig", kid } as JWK;
  const privateJwk = { ...(await exportJWK(privateKey)), alg: ALG, use: "sig", kid } as JWK;
  await ctx.db.insert(s.signingKeys).values({
            kid,
            alg: ALG,
            publicJwk: publicJwk as unknown as Record<string, unknown>,
            privateJwkEnc: encrypt(ctx.env.encryptionKey, JSON.stringify(privateJwk)),
            active: opts.active ?? true,
            createdAt: Date.now(),
          });
  cacheFor(ctx).set(kid, { privateKey, publicJwk });
  return { kid, publicJwk };
}

async function loadKey(ctx: AppContext, row: typeof s.signingKeys.$inferSelect): Promise<KeyPairCache> {
  const cached = cacheFor(ctx).get(row.kid);
  if (cached) return cached;
  const privateJwk = JSON.parse(decrypt(ctx.env.encryptionKey, row.privateJwkEnc)) as JWK;
  const privateKey = await importJWK(privateJwk, row.alg);
  const entry = { privateKey, publicJwk: row.publicJwk as unknown as JWK };
  cacheFor(ctx).set(row.kid, entry);
  return entry;
}

/** Returns the active signing key, creating one on first boot. */
export async function getActiveSigningKey(ctx: AppContext) {
  let row = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.active, true)).orderBy(desc(s.signingKeys.createdAt)));
  if (!row) {
    // Rotate restores an old key only if explicitly requested; otherwise mint the instance's first key.
    const latest = first(await ctx.db.select().from(s.signingKeys).orderBy(desc(s.signingKeys.createdAt)));
    if (latest) {
      await ctx.db.update(s.signingKeys).set({ active: true }).where(eq(s.signingKeys.kid, latest.kid));
      row = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.kid, latest.kid)))!;
    } else {
      await generateSigningKey(ctx);
      row = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.active, true)).orderBy(desc(s.signingKeys.createdAt)))!;
    }
  }
  return { row, ...(await loadKey(ctx, row)) };
}

/** Marks the current key rotated and creates a new active one. Old public keys stay in the JWKS. */
export async function rotateSigningKey(ctx: AppContext): Promise<{ kid: string }> {
  const now = Date.now();
  await ctx.db.update(s.signingKeys).set({ active: false, rotatedAt: now }).where(eq(s.signingKeys.active, true));
  cacheFor(ctx).clear();
  const { kid } = await generateSigningKey(ctx);
  return { kid };
}

export async function getJwks(ctx: AppContext): Promise<{ keys: JWK[] }> {
  const rows = (await ctx.db.select().from(s.signingKeys));
  if (!rows.length) {
    await getActiveSigningKey(ctx);
    return getJwks(ctx);
  }
  return { keys: rows.map((r) => r.publicJwk as unknown as JWK) };
}

// ───────────── claim helpers ─────────────

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function lookupPath(source: Record<string, unknown>, path: string): unknown {
  let cur: unknown = source;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
      continue;
    }
    if (PROTOTYPE_KEYS.has(part)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = asRecord(cur)[part];
  }
  return cur;
}

/**
 * Resolves JWT-template-style shortcodes (`{{user.first_name}}`, `{{org.slug}}`) including `||` fallbacks.
 * A value that is exactly one shortcode keeps its JSON type; otherwise the string is interpolated.
 */
export function resolveShortcodeValue(value: unknown, source: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const whole = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(value);
  if (whole) {
    for (const candidate of (whole[1] ?? "").split("||")) {
      const resolved = lookupPath(source, candidate.trim());
      if (resolved !== undefined && resolved !== null && resolved !== "") return resolved;
    }
    return undefined;
  }
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expr: string) => {
    for (const candidate of expr.split("||")) {
      const resolved = lookupPath(source, candidate.trim());
      if (resolved !== undefined && resolved !== null && resolved !== "") {
        return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
      }
    }
    return "";
  });
}

function resolveClaimMap(map: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    const resolved = resolveShortcodeValue(value, source);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

interface OrgMembershipContext { orgId: string; slug: string | null; role: string; permissions: string[] }

async function membershipFor(ctx: AppContext, userId: string, orgId: string | null) {
  if (!orgId || !ctx.settings.get().organizations.enabled) return null;
  const membership: OrgMembershipContext | null = await getMembershipContext(ctx, userId, orgId);
  if (!membership) return null;
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orgId)));
  return {
    id: membership.orgId,
    slug: membership.slug,
    name: org?.name ?? membership.slug ?? "",
    role: membership.role,
    permissions: membership.permissions,
  };
}

interface TokenContext {
  userJson: UserJSON;
  org: { id: string; slug: string | null; name: string; role: string; permissions: string[] } | null;
  sessionId: string;
  actor: Record<string, unknown> | null;
}

/** Claims owned by the session machinery; only the server decides them. */
const PROTECTED_CLAIMS = new Set(RESERVED_SESSION_CLAIMS);

function shortcodeSource(tc: TokenContext): Record<string, unknown> {
  const emails = tc.userJson.email_addresses;
  const primaryEmail = emails.find((e) => e.id === tc.userJson.primary_email_address_id) ?? emails[0];
  const primaryPhone = tc.userJson.phone_numbers.find((p) => p.id === tc.userJson.primary_phone_number_id) ?? tc.userJson.phone_numbers[0];
  const user: Record<string, unknown> = {
    ...tc.userJson,
    full_name: [tc.userJson.first_name, tc.userJson.last_name].filter(Boolean).join(" ") || null,
    primary_email_address: primaryEmail?.email_address ?? null,
    primary_phone_number: primaryPhone?.phone_number ?? null,
    email_verified: !!primaryEmail?.verification && primaryEmail.verification.status === "verified",
    phone_number_verified: !!primaryPhone?.verification && primaryPhone.verification.status === "verified",
  };
  const org = tc.org ? {
    id: tc.org.id,
    slug: tc.org.slug,
    name: tc.org.name,
    role: tc.org.role,
    permissions: tc.org.permissions,
  } : null;
  return {
    user,
    org,
    session: { id: tc.sessionId, actor: tc.actor },
    org_membership: tc.org ? { permissions: tc.org.permissions, role: tc.org.role } : null,
  };
}

// ───────────── tokens ─────────────

const minutesSince = (t: number | null) => (t ? Math.floor((Date.now() - t) / 60_000) : -1);

/** Mint a session JWT for an active session. Includes org_* claims for the session's active organization. */
export async function signSessionToken(ctx: AppContext, sessionId: string, opts: { template?: string; azp?: string; skipCache?: boolean } = {}): Promise<string> {
  const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
  if (!session) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
  if (session.status !== "active" && session.status !== "pending") {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, "This session is no longer active");
  }
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, session.userId)));
  if (!user) throw new OrbitError(404, ErrorCodes.resource_not_found, "User not found");
  if (user.banned) throw new OrbitError(403, ErrorCodes.user_banned, "This user has been banned");
  const nowMs = Date.now();
  const inactivityMs = ctx.settings.get().session.inactivityTimeoutSeconds * 1000;
  if (session.expireAt <= nowMs || (inactivityMs > 0 && nowMs - session.lastActiveAt > inactivityMs)) {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, "This session has expired");
  }

  const st = ctx.settings.get();
  const org = await membershipFor(ctx, user.id, session.lastActiveOrganizationId);
  const actor = (session.actor as Record<string, unknown> | null) ?? null;
  const tokenContext: TokenContext = { userJson: await serializeUser(ctx, user), org, sessionId, actor };

  const nowSeconds = Math.floor(Date.now() / 1000);
  let lifetime = st.session.tokenLifetimeSeconds;
  let extraClaims: Record<string, unknown> = {};
  let template: Awaited<ReturnType<typeof renderTemplateClaims>> = null;

  if (opts.template) {
    template = await renderTemplateClaims(ctx, opts.template, { userId: user.id, sessionId, orgId: session.lastActiveOrganizationId });
    if (!template) throw new OrbitError(404, ErrorCodes.resource_not_found, `JWT template "${opts.template}" not found`);
    lifetime = template.lifetimeSeconds;
    extraClaims = template.claims;
  } else if (Object.keys(st.session.customClaims).length) {
    extraClaims = resolveClaimMap(st.session.customClaims, shortcodeSource(tokenContext));
  }

  const base: Record<string, unknown> = {
    iss: ctx.env.baseUrl,
    sub: user.id,
    sid: session.id,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + lifetime,
    sts: session.status === "pending" ? "pending" : "active",
    fva: [minutesSince(session.firstFactorVerifiedAt), minutesSince(session.secondFactorVerifiedAt)],
  };
  if (user.isAnonymous) base.anonymous = true;
  if (opts.azp) base.azp = opts.azp;
  if (org) {
    base.org_id = org.id;
    base.org_slug = org.slug;
    base.org_role = org.role;
    base.org_permissions = org.permissions;
  }
  // Instance-wide roles are read from `user_roles` on every mint, so a role change applies to the next token
  // without a session round trip. They are independent of the active organization (`org_role`).
  const instanceRoles = await roleClaimsForUser(ctx, user.id);
  base.roles = instanceRoles.roles;
  base.role_permissions = instanceRoles.permissions;
  if (actor) base.act = actor;

  // Configured or templated claims may add to the token, never redefine who or what the session is.
  const extra = { ...extraClaims };
  for (const key of Object.keys(extra)) if (PROTECTED_CLAIMS.has(key)) delete extra[key];
  const claims = { ...extra, ...base };

  if (template?.signingKeyEnc) {
    const key = await importTemplateKey(ctx, template.signingKeyEnc, template.algorithm);
    return new SignJWT(asRecord(claims)).setProtectedHeader({ alg: template.algorithm, typ: "JWT" }).sign(key);
  }
  const { row, privateKey } = await getActiveSigningKey(ctx);
  return new SignJWT(asRecord(claims))
    .setProtectedHeader({ alg: row.alg, kid: row.kid, typ: "JWT" })
    .sign(privateKey);
}

/** Template keys are stored encrypted: an HMAC secret (HS256) or a private JWK (RS256/ES256). */
async function importTemplateKey(ctx: AppContext, encrypted: string, algorithm: string): Promise<KeyLike | Uint8Array> {
  const plain = decrypt(ctx.env.encryptionKey, encrypted);
  if (algorithm === "HS256") return new TextEncoder().encode(plain);
  return (await importJWK(JSON.parse(plain), algorithm)) as KeyLike;
}

export async function verifySessionToken(ctx: AppContext, jwt: string): Promise<SessionClaims> {
  const jwks = await getJwks(ctx);
  try {
    const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), {
      issuer: ctx.env.baseUrl,
      // Instance keys are asymmetric only. Pinning the algorithms rejects `none` and HS256 confusion,
      // where a public key would otherwise be tried as an HMAC secret.
      algorithms: ["RS256"],
    });
    // Session tokens never carry an audience; machine and OIDC tokens signed by the same key do.
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string" || payload.aud !== undefined) {
      throw new OrbitError(401, ErrorCodes.authentication_invalid, "Not a session token");
    }
    return payload as SessionClaims;
  } catch {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, "Invalid session token");
  }
}

/** Sign arbitrary claims with the instance key (used by the OIDC provider id_token and JWT templates). */
export async function signJwt(ctx: AppContext, claims: Record<string, unknown>, opts: { expiresInSeconds: number; audience?: string; issuer?: string; kid?: string }): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const active = await getActiveSigningKey(ctx);
  let key = active;
  if (opts.kid && opts.kid !== active.row.kid) {
    const row = first(await ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.kid, opts.kid)));
    if (row) key = { row, ...(await loadKey(ctx, row)) };
  }
  const payload: Record<string, unknown> = {
    ...claims,
    iss: opts.issuer ?? str(claims.iss) ?? ctx.env.baseUrl,
    iat: nowSeconds,
    exp: nowSeconds + opts.expiresInSeconds,
  };
  if (opts.audience) payload.aud = opts.audience;
  return new SignJWT(payload).setProtectedHeader({ alg: key.row.alg, kid: key.row.kid, typ: "JWT" }).sign(key.privateKey);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
