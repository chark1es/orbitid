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
import { BASE_OIDC_SCOPES, OAuthError, type ApplicationRow } from "./shared";

export function serializeApplication(row: ApplicationRow, opts: { clientSecret?: string } = {}): OAuthApplicationJSON {
  const json: OAuthApplicationJSON = {
    object: "oauth_application",
    id: row.id,
    name: row.name,
    client_id: row.clientId,
    public: row.isPublic,
    redirect_uris: row.redirectUris ?? [],
    scopes: row.scopes,
    consent_screen_enabled: row.consentScreenEnabled,
    pkce_required: row.pkceRequired,
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
  scopes?: string;
  isPublic?: boolean;
  consentScreenEnabled?: boolean;
  pkceRequired?: boolean;
}

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
    scopes: input.scopes ?? BASE_OIDC_SCOPES.join(" "),
    consentScreenEnabled: input.consentScreenEnabled ?? true,
    pkceRequired: input.pkceRequired ?? true,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.insert(s.oauthApplications).values(row);
  return { row, clientSecret };
}

export async function updateApplication(ctx: AppContext, row: ApplicationRow, patch: Partial<Pick<CreateApplicationInput, "name" | "redirectUris" | "scopes" | "consentScreenEnabled" | "pkceRequired">>): Promise<ApplicationRow> {
  const set: Partial<ApplicationRow> = { updatedAt: Date.now() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.redirectUris !== undefined) set.redirectUris = patch.redirectUris;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (patch.consentScreenEnabled !== undefined) set.consentScreenEnabled = patch.consentScreenEnabled;
  if (patch.pkceRequired !== undefined) set.pkceRequired = patch.pkceRequired;
  await ctx.db.update(s.oauthApplications).set(set).where(eq(s.oauthApplications.id, row.id));
  return (await getApplication(ctx, row.id))!;
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

/** Scopes this application may request: base scopes + its configured custom scopes. */
export function applicationScopes(app: ApplicationRow): string[] {
  return [...new Set([...BASE_OIDC_SCOPES, ...parseScopes(app.scopes)])];
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

export function parseBasicAuthorization(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  const decode = (v: string) => {
    try { return decodeURIComponent(v); } catch { return v; }
  };
  return { clientId: decode(decoded.slice(0, idx)), clientSecret: decode(decoded.slice(idx + 1)) };
}

/**
 * Client authentication for the token/revocation/introspection endpoints:
 * `client_secret_basic`, `client_secret_post`, or `none` for public clients.
 */
export async function authenticateClient(ctx: AppContext, input: { authorization?: string; clientId?: string; clientSecret?: string }): Promise<ApplicationRow> {
  const basic = parseBasicAuthorization(input.authorization);
  const clientId = basic?.clientId ?? input.clientId;
  const clientSecret = basic?.clientSecret ?? input.clientSecret;
  if (!clientId) throw new OAuthError(401, "invalid_client", "client_id is required");
  const app = await getApplicationByClientId(ctx, clientId);
  if (!app) throw new OAuthError(401, "invalid_client", "Unknown client");
  if (app.isPublic) {
    if (clientSecret) throw new OAuthError(401, "invalid_client", "Public clients must not send a client secret");
    return app;
  }
  if (!clientSecret || !app.clientSecretHash) throw new OAuthError(401, "invalid_client", "Client authentication failed");
  if (!safeEqual(sha256(clientSecret), app.clientSecretHash)) throw new OAuthError(401, "invalid_client", "Client authentication failed");
  return app;
}

/** Rejects redirect URIs that are not registered verbatim (open-redirect protection). */
export function assertRedirectUri(app: ApplicationRow, redirectUri: string | undefined): string {
  if (!redirectUri) throw new OAuthError(400, "invalid_request", "redirect_uri is required");
  if (!(app.redirectUris ?? []).includes(redirectUri)) throw new OAuthError(400, "invalid_request", "redirect_uri is not registered for this client");
  return redirectUri;
}
