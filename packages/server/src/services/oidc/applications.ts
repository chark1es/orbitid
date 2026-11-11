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
import { GROUPS_CLAIM_MODES, LIFETIME_BOUNDS, OAuthError, type ApplicationRow, type GroupsClaimMode } from "./shared";
import { DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS, DEFAULT_OAUTH_APPLICATION_SCOPES, DEFAULT_OAUTH_GROUPS_CLAIM } from "@orbitid/shared";
import { loopbackRedirectMatch } from "./issuer";

export function serializeApplication(row: ApplicationRow, opts: { clientSecret?: string } = {}): OAuthApplicationJSON {
  const json: OAuthApplicationJSON = {
    object: "oauth_application",
    id: row.id,
    name: row.name,
    client_id: row.clientId,
    public: row.isPublic,
    redirect_uris: row.redirectUris ?? [],
    post_logout_redirect_uris: row.postLogoutRedirectUris ?? [],
    scopes: row.scopes,
    consent_screen_enabled: row.consentScreenEnabled,
    pkce_required: row.pkceRequired,
    access_token_lifetime_seconds: row.accessTokenLifetimeSeconds,
    refresh_token_lifetime_seconds: row.refreshTokenLifetimeSeconds,
    id_token_lifetime_seconds: row.idTokenLifetimeSeconds,
    groups_claim: row.groupsClaim as GroupsClaimMode,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (opts.clientSecret) json.client_secret = opts.clientSecret;
  return json;
}

export function generateClientSecret(): string {
  return `oas_${randomToken(24)}`;
}

export async function getApplication(ctx: AppContext, id: string): Promise<ApplicationRow | null> {
  return first(await ctx.db.select().from(s.oauthApplications).where(eq(s.oauthApplications.id, id))) ?? null;
}

export async function requireApplication(ctx: AppContext, id: string): Promise<ApplicationRow> {
  const row = await getApplication(ctx, id);
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "OAuth application not found");
  return row;
}

export async function getApplicationByClientId(ctx: AppContext, clientId: string): Promise<ApplicationRow | null> {
  return first(await ctx.db.select().from(s.oauthApplications).where(eq(s.oauthApplications.clientId, clientId))) ?? null;
}

export interface CreateApplicationInput {
  name: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  scopes?: string;
  isPublic?: boolean;
  consentScreenEnabled?: boolean;
  pkceRequired?: boolean;
  accessTokenLifetimeSeconds?: number;
  refreshTokenLifetimeSeconds?: number;
  idTokenLifetimeSeconds?: number;
  groupsClaim?: GroupsClaimMode;
}

const clampLifetime = (value: number, bounds: { min: number; max: number }) => Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));

export async function createApplication(ctx: AppContext, input: CreateApplicationInput): Promise<{ row: ApplicationRow; clientSecret?: string }> {
  const now = Date.now();
  const clientSecret = input.isPublic ? undefined : generateClientSecret();
  const row: ApplicationRow = {
    id: newId(ID_PREFIX.oauthApp),
    name: input.name,
    clientId: newId(ID_PREFIX.oauthApp),
    clientSecretHash: clientSecret ? sha256(clientSecret) : null,
    isPublic: !!input.isPublic,
    redirectUris: input.redirectUris ?? [],
    postLogoutRedirectUris: input.postLogoutRedirectUris ?? [],
    scopes: input.scopes ?? DEFAULT_OAUTH_APPLICATION_SCOPES,
    consentScreenEnabled: input.consentScreenEnabled ?? true,
    // Public clients are always PKCE-bound below; confidential clients stay interop-friendly unless opted in.
    pkceRequired: input.isPublic ? true : input.pkceRequired ?? false,
    accessTokenLifetimeSeconds: clampLifetime(input.accessTokenLifetimeSeconds ?? DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS, LIFETIME_BOUNDS.access),
    refreshTokenLifetimeSeconds: clampLifetime(input.refreshTokenLifetimeSeconds ?? 2_592_000, LIFETIME_BOUNDS.refresh),
    idTokenLifetimeSeconds: clampLifetime(input.idTokenLifetimeSeconds ?? 3600, LIFETIME_BOUNDS.id),
    groupsClaim: input.groupsClaim && GROUPS_CLAIM_MODES.includes(input.groupsClaim) ? input.groupsClaim : DEFAULT_OAUTH_GROUPS_CLAIM,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.insert(s.oauthApplications).values(row);
  return { row, clientSecret };
}

export type UpdateApplicationInput = Partial<Pick<CreateApplicationInput,
  "name" | "redirectUris" | "postLogoutRedirectUris" | "scopes" | "consentScreenEnabled" | "pkceRequired"
  | "accessTokenLifetimeSeconds" | "refreshTokenLifetimeSeconds" | "idTokenLifetimeSeconds" | "groupsClaim">>;

export async function updateApplication(ctx: AppContext, row: ApplicationRow, patch: UpdateApplicationInput): Promise<ApplicationRow> {
  const set: Partial<ApplicationRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.redirectUris !== undefined) set.redirectUris = patch.redirectUris;
  if (patch.postLogoutRedirectUris !== undefined) set.postLogoutRedirectUris = patch.postLogoutRedirectUris;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (patch.consentScreenEnabled !== undefined) set.consentScreenEnabled = patch.consentScreenEnabled;
  if (patch.pkceRequired !== undefined) set.pkceRequired = row.isPublic ? true : patch.pkceRequired;
  if (patch.accessTokenLifetimeSeconds !== undefined) set.accessTokenLifetimeSeconds = clampLifetime(patch.accessTokenLifetimeSeconds, LIFETIME_BOUNDS.access);
  if (patch.refreshTokenLifetimeSeconds !== undefined) set.refreshTokenLifetimeSeconds = clampLifetime(patch.refreshTokenLifetimeSeconds, LIFETIME_BOUNDS.refresh);
  if (patch.idTokenLifetimeSeconds !== undefined) set.idTokenLifetimeSeconds = clampLifetime(patch.idTokenLifetimeSeconds, LIFETIME_BOUNDS.id);
  if (patch.groupsClaim !== undefined && GROUPS_CLAIM_MODES.includes(patch.groupsClaim)) set.groupsClaim = patch.groupsClaim;
  await ctx.db.update(s.oauthApplications).set(set).where(eq(s.oauthApplications.id, row.id));
  return (await getApplication(ctx, row.id))!;
}

/** Lifetimes this application issues, with the instance defaults as a floor/ceiling guard. */
export function applicationLifetimes(app: ApplicationRow) {
  return {
    access: clampLifetime(app.accessTokenLifetimeSeconds ?? DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS, LIFETIME_BOUNDS.access),
    refresh: clampLifetime(app.refreshTokenLifetimeSeconds ?? 2_592_000, LIFETIME_BOUNDS.refresh),
    id: clampLifetime(app.idTokenLifetimeSeconds ?? 3600, LIFETIME_BOUNDS.id),
  };
}

export async function deleteApplication(ctx: AppContext, row: ApplicationRow): Promise<void> {
  await ctx.db.delete(s.oauthApplications).where(eq(s.oauthApplications.id, row.id));
}

export async function rotateClientSecret(ctx: AppContext, row: ApplicationRow): Promise<{ row: ApplicationRow; clientSecret: string }> {
  if (row.isPublic) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "Public applications do not have a client secret");
  const clientSecret = generateClientSecret();
  await ctx.db.update(s.oauthApplications).set({ clientSecretHash: sha256(clientSecret), updatedAt: Date.now() }).where(eq(s.oauthApplications.id, row.id));
  return { row: (await getApplication(ctx, row.id))!, clientSecret };
}

export async function listApplications(ctx: AppContext, opts: { limit?: number; offset?: number } = {}): Promise<{ data: ApplicationRow[]; totalCount: number }> {
  const data = (await ctx.db.select().from(s.oauthApplications).orderBy(desc(s.oauthApplications.createdAt)).limit(opts.limit ?? 10).offset(opts.offset ?? 0));
  const totalCount = first(await ctx.db.select({ n: count() }).from(s.oauthApplications))?.n ?? 0;
  return { data, totalCount };
}

export function parseScopes(raw: string | null | undefined): string[] {
  return (raw ?? "").split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
}

/**
 * Scopes this application may request. Its configured `scopes` are the allowlist; `openid` is always allowed
 * because a client cannot be an OIDC client without it. Base scopes are no longer granted implicitly: an
 * application that never asked for `groups`, `organizations` or `offline_access` must not receive them, which
 * would be silent disclosure (especially with the consent screen off).
 */
export function applicationScopes(app: ApplicationRow): string[] {
  return [...new Set(["openid", ...parseScopes(app.scopes)])];
}

export function assertScopesAllowed(app: ApplicationRow, requested: string[]): string[] {
  const allowed = applicationScopes(app);
  const invalid = requested.filter((scope) => !allowed.includes(scope));
  if (invalid.length) throw new OAuthError(400, "invalid_scope", `Unsupported scope(s): ${invalid.join(", ")}`);
  return [...new Set(requested)];
}

/** base64url(sha256(verifier)) — the only supported PKCE challenge derivation (S256; `plain` is refused). */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const formDecode = (value: string) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

/**
 * RFC 6749 §2.3.1 says both Basic credentials are form-urlencoded, but many clients send them raw. `clientSecret`
 * is the decoded reading and `rawClientSecret` the verbatim one, so `authenticateClient` can accept either.
 */
export function parseBasicAuthorization(header: string | undefined): { clientId: string; clientSecret: string; rawClientSecret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    clientId: formDecode(decoded.slice(0, idx)),
    clientSecret: formDecode(decoded.slice(idx + 1)),
    rawClientSecret: decoded.slice(idx + 1),
  };
}

/** Every reading of a presented secret that a client could have meant (raw, percent-decoded, `+` as space). */
function secretCandidates(presented: string): string[] {
  return [...new Set([presented, formDecode(presented), formDecode(presented.replace(/\+/g, " "))])];
}

/**
 * Client authentication for the token/revocation/introspection endpoints:
 * `client_secret_basic`, `client_secret_post`, or `none` for public clients.
 */
export async function authenticateClient(ctx: AppContext, input: { authorization?: string; clientId?: string; clientSecret?: string }): Promise<ApplicationRow> {
  const basic = parseBasicAuthorization(input.authorization);
  const clientId = basic?.clientId ?? input.clientId;
  if (!clientId) throw new OAuthError(401, "invalid_client", "client_id is required");
  const app = await getApplicationByClientId(ctx, clientId);
  if (!app) throw new OAuthError(401, "invalid_client", "Unknown client");
  const presented = basic ? [basic.clientSecret, basic.rawClientSecret] : input.clientSecret ? [input.clientSecret] : [];
  if (app.isPublic) {
    if (presented.some(Boolean)) throw new OAuthError(401, "invalid_client", "Public clients must not send a client secret");
    return app;
  }
  if (!presented.length || !app.clientSecretHash) throw new OAuthError(401, "invalid_client", "Client authentication failed");
  for (const candidate of presented.flatMap(secretCandidates)) {
    if (safeEqual(sha256(candidate), app.clientSecretHash)) return app;
  }
  throw new OAuthError(401, "invalid_client", "Client authentication failed");
}

/**
 * Rejects redirect URIs that are not registered verbatim (open-redirect protection). RFC 8252 §7.3 lets a
 * native application choose any loopback port at runtime, so a registered `http://127.0.0.1/callback` accepts
 * `http://127.0.0.1:53121/callback`; scheme, host and path still have to match.
 */
export function assertRedirectUri(app: ApplicationRow, redirectUri: string | undefined): string {
  if (!redirectUri) throw new OAuthError(400, "invalid_request", "redirect_uri is required");
  const registered = app.redirectUris ?? [];
  if (registered.includes(redirectUri)) return redirectUri;
  if (registered.some((uri) => loopbackRedirectMatch(uri, redirectUri))) return redirectUri;
  throw new OAuthError(400, "invalid_request", "redirect_uri is not registered for this client");
}

/** Validates an RP-initiated logout return URI against `post_logout_redirect_uris` (exact, loopback-port aware). */
export function assertPostLogoutRedirectUri(app: ApplicationRow, redirectUri: string): string {
  const registered = app.postLogoutRedirectUris ?? [];
  if (registered.includes(redirectUri)) return redirectUri;
  if (registered.some((uri) => loopbackRedirectMatch(uri, redirectUri))) return redirectUri;
  throw new OAuthError(400, "invalid_request", "post_logout_redirect_uri is not registered for this client");
}
