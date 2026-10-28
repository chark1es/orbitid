// OIDC/OAuth2 provider service: applications, authorization codes, tokens, consent, device grant.
//
// Storage notes (no schema changes; the schema is lead-owned):
//  - codes/access/refresh tokens are random opaque strings; only sha256 hashes are stored in `oauth_grants`.
//  - for access/refresh rows the unused `nonce` column stores the *family id* of the token chain, which is what
//    makes refresh-token rotation and reuse detection possible. Their unused `redirectUri` column stores the
//    authorizing session id (`sid:<id>`), which is what keeps `sid` and the org claims tied to that session.
//  - code rows keep the OIDC `nonce` in `nonce`, together with the authorizing session id, as a small JSON
//    object; their `redirectUri` keeps holding the redirect URI.
import { createHash, randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ErrorCodes, ID_PREFIX, OrbitError, type OAuthApplicationJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { randomToken, safeEqual, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { getMembershipContext } from "./orgs";
import { getJwks, signJwt } from "./tokens";
import { first } from "../lib/db";

type ApplicationRow = typeof s.oauthApplications.$inferSelect;
type GrantRow = typeof s.oauthGrants.$inferSelect;
type DeviceCodeRow = typeof s.deviceCodes.$inferSelect;

/** Scopes every application supports; per-app custom scopes are added on top. */
export const BASE_OIDC_SCOPES = ["openid", "profile", "email", "organizations", "offline_access"] as const;
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Authenticate you and read your OrbitID user id",
  profile: "Read your name, username and profile picture",
  email: "Read your email address and whether it is verified",
  organizations: "Read the organizations you belong to and your role in them",
  offline_access: "Stay signed in after you leave (refresh token)",
};

/** RFC 8628 grant type. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
export const ID_TOKEN_TTL_SECONDS = 60 * 60;

/** RFC 6749 error surfaced on OAuth endpoints (`{ error, error_description }`, not the OrbitID error envelope). */
export class OAuthError extends Error {
  constructor(public status: number, public error: string, description: string) {
    super(description);
    this.name = "OAuthError";
  }
}

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

export interface IssueCodeInput {
  application: ApplicationRow;
  userId: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  nonce?: string | null;
  /** The browser session that authorized the request (org claims, `sid`). */
  sessionId?: string | null;
}

export async function issueAuthorizationCode(ctx: AppContext, input: IssueCodeInput): Promise<string> {
  const code = `oac_${randomToken(32)}`;
  await ctx.db.insert(s.oauthGrants).values({
            id: newId(ID_PREFIX.oauthGrant),
            kind: "code",
            applicationId: input.application.id,
            userId: input.userId,
            tokenHash: sha256(code),
            scopes: input.scopes.join(" "),
            redirectUri: input.redirectUri,
            codeChallenge: input.codeChallenge ?? null,
            codeChallengeMethod: input.codeChallenge ? (input.codeChallengeMethod ?? "S256") : null,
            nonce: encodeCodeMeta({ nonce: input.nonce ?? null, sid: input.sessionId ?? null }),
            revoked: false,
            expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
            createdAt: Date.now(),
          });
  return code;
}

export async function findGrantByToken(ctx: AppContext, token: string): Promise<GrantRow | null> {
  return first(await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.tokenHash, sha256(token)))) ?? null;
}

export const isGrantLive = (row: GrantRow, at = Date.now()) => !row.revoked && row.expiresAt > at;

/** Revokes every token in a rotation family (refresh reuse detection / RFC 7009 on a refresh token). */
export async function revokeGrantFamily(ctx: AppContext, family: string): Promise<void> {
  if (!family) return;
  await ctx.db.update(s.oauthGrants).set({ revoked: true })
            .where(and(inArray(s.oauthGrants.kind, ["access", "refresh"]), eq(s.oauthGrants.nonce, family)));
}

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

type UserRow = typeof s.users.$inferSelect;

/** Codes carry the OIDC `nonce`; access/refresh rows have no nonce to spare (it holds the family id). */
interface CodeMeta { nonce: string | null; sid: string | null }
const encodeCodeMeta = (meta: CodeMeta): string => JSON.stringify({ nonce: meta.nonce, sid: meta.sid });
function decodeCodeMeta(raw: string | null): CodeMeta {
  if (!raw) return { nonce: null, sid: null };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return { nonce: typeof parsed.nonce === "string" ? parsed.nonce : null, sid: typeof parsed.sid === "string" ? parsed.sid : null };
    }
  } catch {
    // Rows written before the session binding existed hold the bare nonce.
  }
  return { nonce: raw, sid: null };
}

/** Access/refresh rows carry the authorizing session id in the otherwise unused `redirectUri` column. */
const SESSION_MARKER = "sid:";
const encodeSession = (sessionId: string | null | undefined): string | null => (sessionId ? `${SESSION_MARKER}${sessionId}` : null);
const decodeSession = (raw: string | null): string | null => (raw?.startsWith(SESSION_MARKER) ? raw.slice(SESSION_MARKER.length) || null : null);

export async function primaryEmail(ctx: AppContext, user: UserRow) {
  if (!user.primaryEmailAddressId) return null;
  return first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, user.primaryEmailAddressId))) ?? null;
}

export interface OrganizationClaims {
  active: { id: string; slug: string | null; role: string; permissions: string[] } | null;
  memberships: { id: string; slug: string | null; name: string; role: string }[];
}

/** Active organization (from the authorizing session) + every membership, for the `organizations` scope. */
export async function organizationClaims(ctx: AppContext, userId: string, sessionId: string | null): Promise<OrganizationClaims> {
  let activeOrgId: string | null = null;
  if (sessionId) {
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)));
    if (session && session.userId === userId) activeOrgId = session.lastActiveOrganizationId;
  }
  let active: OrganizationClaims["active"] = null;
  if (activeOrgId) {
    const membership = await getMembershipContext(ctx, userId, activeOrgId);
    if (membership) active = { id: membership.orgId, slug: membership.slug, role: membership.role, permissions: membership.permissions };
  }
  const rows = await ctx.db
    .select({ id: s.organizations.id, slug: s.organizations.slug, name: s.organizations.name, role: s.organizationMemberships.roleKey })
    .from(s.organizationMemberships)
    .innerJoin(s.organizations, eq(s.organizations.id, s.organizationMemberships.organizationId))
    .where(eq(s.organizationMemberships.userId, userId))
    .orderBy(asc(s.organizations.name), asc(s.organizations.id));
  return { active, memberships: rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role })) };
}

/** Adds `org_*` and `organizations` claims when the `organizations` scope was granted. */
export async function appendOrgClaims(claims: Record<string, unknown>, ctx: AppContext, userId: string, sessionId: string | null): Promise<void> {
  const orgs = await organizationClaims(ctx, userId, sessionId);
  if (orgs.active) {
    claims.org_id = orgs.active.id;
    claims.org_slug = orgs.active.slug;
    claims.org_role = orgs.active.role;
    claims.org_permissions = orgs.active.permissions;
  }
  claims.organizations = orgs.memberships;
}

interface IdTokenInput {
  user: UserRow;
  scopes: string[];
  nonce: string | null;
  sessionId?: string | null;
}

async function buildIdTokenClaims(ctx: AppContext, input: IdTokenInput): Promise<Record<string, unknown>> {
  const { user, scopes } = input;
  const email = await primaryEmail(ctx, user);
  const claims: Record<string, unknown> = { sub: user.id };
  if (input.nonce) claims.nonce = input.nonce;
  if (scopes.includes("profile")) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email?.email || user.id;
    claims.name = name;
    if (user.firstName) claims.given_name = user.firstName;
    if (user.lastName) claims.family_name = user.lastName;
    if (user.imageUrl) claims.picture = user.imageUrl;
    claims.preferred_username = user.username ?? email?.email?.split("@")[0] ?? user.id;
    claims.updated_at = Math.floor(user.updatedAt / 1000);
  }
  if (scopes.includes("email")) {
    claims.email = email?.email ?? null;
    claims.email_verified = !!email?.verified;
  }
  if (scopes.includes("organizations")) await appendOrgClaims(claims, ctx, user.id, input.sessionId ?? null);
  return claims;
}

interface TokenSetInput {
  application: ApplicationRow;
  user: UserRow;
  scopes: string[];
  family: string;
  nonce?: string | null;
  /** The browser session that authorized the grant; enables `sid` on JWTs and org claims. */
  sessionId?: string | null;
}

/**
 * Mints an access token (+ refresh token when `offline_access`) and the id_token when `openid` is granted.
 * With `settings.oidcProvider.accessTokenFormat === "jwt"` the access token is an RS256 JWT signed with the
 * instance key (same JWKS as session tokens); it is still recorded in `oauth_grants` so it can be revoked.
 */
export async function issueTokenSet(ctx: AppContext, input: TokenSetInput): Promise<TokenSet> {
  const now = Date.now();
  const scope = input.scopes.join(" ");
  const sessionId = input.sessionId ?? null;
  const grantId = newId(ID_PREFIX.oauthGrant);
  const jwtFormat = ctx.settings.get().oidcProvider.accessTokenFormat === "jwt";
  let accessToken: string;
  if (jwtFormat) {
    const claims: Record<string, unknown> = {
      sub: input.user.id,
      azp: input.application.clientId,
      scope,
      jti: grantId,
    };
    if (sessionId) claims.sid = sessionId;
    if (input.scopes.includes("organizations")) await appendOrgClaims(claims, ctx, input.user.id, sessionId);
    accessToken = await signJwt(ctx, claims, {
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      issuer: ctx.env.baseUrl,
      audience: input.application.clientId,
    });
  } else {
    accessToken = `oat_${randomToken(32)}`;
  }
  await ctx.db.insert(s.oauthGrants).values({
            id: grantId,
            kind: "access",
            applicationId: input.application.id,
            userId: input.user.id,
            tokenHash: sha256(accessToken),
            scopes: scope,
            // the authorizing session (org claims, `sid`); see the storage note at the top of this file
            redirectUri: encodeSession(sessionId),
            codeChallenge: null,
            codeChallengeMethod: null,
            // family id (see the storage note at the top of this file)
            nonce: input.family,
            revoked: false,
            expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
            createdAt: now,
          });

  const set: TokenSet = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope,
  };

  if (input.scopes.includes("offline_access")) {
    const refreshToken = `ort_${randomToken(32)}`;
    await ctx.db.insert(s.oauthGrants).values({
                  id: newId(ID_PREFIX.oauthGrant),
                  kind: "refresh",
                  applicationId: input.application.id,
                  userId: input.user.id,
                  tokenHash: sha256(refreshToken),
                  scopes: scope,
                  redirectUri: encodeSession(sessionId),
                  codeChallenge: null,
                  codeChallengeMethod: null,
                  nonce: input.family,
                  revoked: false,
                  expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
                  createdAt: now,
                });
    set.refresh_token = refreshToken;
  }

  if (input.scopes.includes("openid")) {
    const claims = await buildIdTokenClaims(ctx, { user: input.user, scopes: input.scopes, nonce: input.nonce ?? null, sessionId });
    set.id_token = await signJwt(ctx, claims, {
      expiresInSeconds: ID_TOKEN_TTL_SECONDS,
      issuer: ctx.env.baseUrl,
      audience: input.application.clientId,
    });
  }
  return set;
}

export interface CodeExchangeInput {
  application: ApplicationRow;
  code: string;
  redirectUri?: string;
  codeVerifier?: string;
}

/** `grant_type=authorization_code`: single use, PKCE enforced for public / pkceRequired clients. */
export async function exchangeAuthorizationCode(ctx: AppContext, input: CodeExchangeInput): Promise<TokenSet> {
  const row = await findGrantByToken(ctx, input.code);
  if (!row || row.kind !== "code" || row.applicationId !== input.application.id || row.revoked || row.expiresAt <= Date.now()) {
    throw new OAuthError(400, "invalid_grant", "Authorization code is invalid or expired");
  }
  if (input.redirectUri !== undefined && input.redirectUri !== row.redirectUri) {
    throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
  }
  if (row.codeChallenge) {
    const method = row.codeChallengeMethod ?? "S256";
    if (method !== "S256") throw new OAuthError(400, "invalid_grant", "Unsupported code_challenge_method");
    if (!input.codeVerifier || !safeEqual(pkceChallengeFor(input.codeVerifier), row.codeChallenge)) {
      throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
    }
  } else if (input.application.isPublic || input.application.pkceRequired) {
    throw new OAuthError(400, "invalid_grant", "PKCE code_challenge is required for this client");
  }

  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) throw new OAuthError(400, "invalid_grant", "User is not allowed to sign in");
  // Revoking the code is the gate: exactly one exchange of a code succeeds, even under parallel requests.
  const claimed = first(await ctx.db.update(s.oauthGrants).set({ revoked: true })
    .where(and(eq(s.oauthGrants.id, row.id), eq(s.oauthGrants.revoked, false), gt(s.oauthGrants.expiresAt, Date.now())))
    .returning({ id: s.oauthGrants.id }));
  if (!claimed) throw new OAuthError(400, "invalid_grant", "Authorization code is invalid or expired");

  const meta = decodeCodeMeta(row.nonce);
  return issueTokenSet(ctx, {
    application: input.application,
    user,
    scopes: parseScopes(row.scopes),
    family: randomToken(9),
    nonce: meta.nonce,
    sessionId: meta.sid,
  });
}

/** `grant_type=refresh_token`: rotating refresh tokens with reuse detection (reuse kills the family). */
export async function exchangeRefreshToken(ctx: AppContext, application: ApplicationRow, refreshToken: string): Promise<TokenSet> {
  const row = await findGrantByToken(ctx, refreshToken);
  if (!row || row.kind !== "refresh" || row.applicationId !== application.id) {
    throw new OAuthError(400, "invalid_grant", "Refresh token is invalid");
  }
  const family = row.nonce ?? "";
  if (row.revoked) {
    // A rotated-out token was presented again: assume theft and invalidate the whole chain.
    await revokeGrantFamily(ctx, family);
    throw new OAuthError(400, "invalid_grant", "Refresh token has already been used");
  }
  if (row.expiresAt <= Date.now()) throw new OAuthError(400, "invalid_grant", "Refresh token has expired");
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) {
    await revokeGrantFamily(ctx, family);
    throw new OAuthError(400, "invalid_grant", "User is not allowed to sign in");
  }

  // Revoking the presented token is the gate. A loser presents an already rotated token, which is reuse.
  const claimed = first(await ctx.db.update(s.oauthGrants).set({ revoked: true })
    .where(and(eq(s.oauthGrants.id, row.id), eq(s.oauthGrants.revoked, false), gt(s.oauthGrants.expiresAt, Date.now())))
    .returning({ id: s.oauthGrants.id }));
  if (!claimed) {
    await revokeGrantFamily(ctx, family);
    throw new OAuthError(400, "invalid_grant", "Refresh token has already been used");
  }
  return issueTokenSet(ctx, {
    application, user, scopes: parseScopes(row.scopes), family, nonce: null,
    sessionId: decodeSession(row.redirectUri),
  });
}

/** Resolves an access token to its grant + user (userinfo / introspection). Opaque and JWT tokens both work. */
export async function accessGrantFromToken(ctx: AppContext, token: string): Promise<{ row: GrantRow; user: UserRow }> {
  const row = await findGrantByToken(ctx, token);
  if (!row || row.kind !== "access" || !isGrantLive(row)) throw new OAuthError(401, "invalid_token", "Access token is invalid or expired");
  if (!token.startsWith("oat_")) {
    // JWT access tokens are recorded above, so revocation still wins over an offline-valid signature.
    try {
      const app = await getApplication(ctx, row.applicationId);
      const { payload } = await jwtVerify(token, createLocalJWKSet(await getJwks(ctx)), {
        issuer: ctx.env.baseUrl,
        audience: app?.clientId,
      });
      if (payload.sub !== row.userId || payload.jti !== row.id) throw new Error("claim mismatch");
    } catch {
      throw new OAuthError(401, "invalid_token", "Access token is invalid or expired");
    }
  }
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) throw new OAuthError(401, "invalid_token", "User is not allowed to sign in");
  return { row, user };
}

/** OIDC userinfo payload, filtered by the granted scopes. */
export async function userInfoClaims(ctx: AppContext, row: GrantRow, user: UserRow): Promise<Record<string, unknown>> {
  const scopes = parseScopes(row.scopes);
  const email = await primaryEmail(ctx, user);
  const claims: Record<string, unknown> = { sub: user.id };
  if (scopes.includes("profile")) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email?.email || user.id;
    claims.name = name;
    claims.given_name = user.firstName;
    claims.family_name = user.lastName;
    claims.preferred_username = user.username ?? email?.email?.split("@")[0] ?? user.id;
    claims.picture = user.imageUrl;
    claims.updated_at = Math.floor(user.updatedAt / 1000);
  }
  if (scopes.includes("email")) {
    claims.email = email?.email ?? null;
    claims.email_verified = !!email?.verified;
  }
  if (scopes.includes("organizations")) await appendOrgClaims(claims, ctx, user.id, decodeSession(row.redirectUri));
  return claims;
}

export async function storedConsent(ctx: AppContext, applicationId: string, userId: string): Promise<string[] | null> {
  const row = first(await ctx.db.select().from(s.oauthConsents)
      .where(and(eq(s.oauthConsents.applicationId, applicationId), eq(s.oauthConsents.userId, userId))));
  return row ? parseScopes(row.scopes) : null;
}

export async function hasConsent(ctx: AppContext, applicationId: string, userId: string, scopes: string[]): Promise<boolean> {
  const granted = await storedConsent(ctx, applicationId, userId);
  return !!granted && scopes.every((scope) => granted.includes(scope));
}

export async function recordConsent(ctx: AppContext, applicationId: string, userId: string, scopes: string[]): Promise<void> {
  const existing = await storedConsent(ctx, applicationId, userId) ?? [];
  const merged = [...new Set([...existing, ...scopes])].join(" ");
  await ctx.db.insert(s.oauthConsents).values({ applicationId, userId, scopes: merged, createdAt: Date.now() })
            .onConflictDoUpdate({ target: [s.oauthConsents.applicationId, s.oauthConsents.userId], set: { scopes: merged } });
}

/** `POST /oauth/revoke` (RFC 7009): revoking a refresh token revokes its family. */
export async function revokeToken(ctx: AppContext, application: ApplicationRow, token: string): Promise<void> {
  const row = await findGrantByToken(ctx, token);
  if (!row || row.applicationId !== application.id) return;
  if (row.kind === "refresh" && row.nonce) await revokeGrantFamily(ctx, row.nonce);
  else await ctx.db.update(s.oauthGrants).set({ revoked: true }).where(eq(s.oauthGrants.id, row.id));
}

/** `POST /oauth/introspect` (RFC 7662). Returns `{ active: false }` for unknown/foreign/expired tokens. */
export async function introspectToken(ctx: AppContext, application: ApplicationRow, token: string): Promise<Record<string, unknown>> {
  const row = await findGrantByToken(ctx, token);
  if (!row || row.applicationId !== application.id || !isGrantLive(row) || row.kind === "code") return { active: false };
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) return { active: false };
  return {
    active: true,
    scope: row.scopes,
    client_id: application.clientId,
    sub: row.userId,
    iss: ctx.env.baseUrl,
    aud: application.clientId,
    exp: Math.floor(row.expiresAt / 1000),
    iat: Math.floor(row.createdAt / 1000),
    token_type: row.kind === "refresh" ? "refresh_token" : "Bearer",
  };
}

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

export function discoveryDocument(ctx: AppContext) {
  const base = ctx.env.baseUrl;
  const settings = ctx.settings.get().oidcProvider;
  const jwtFormat = settings.accessTokenFormat === "jwt";
  const doc: Record<string, unknown> = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/oauth/jwks`,
    revocation_endpoint: `${base}/oauth/revoke`,
    introspection_endpoint: `${base}/oauth/introspect`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: settings.deviceAuthorizationEnabled
      ? ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]
      : ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: [...BASE_OIDC_SCOPES],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce", "name", "given_name", "family_name", "preferred_username", "picture",
      "email", "email_verified", "org_id", "org_slug", "org_role", "org_permissions", "organizations",
    ],
    prompt_values_supported: ["consent", "none"],
  };
  if (jwtFormat) {
    doc.access_token_format = "jwt";
    doc.access_token_signing_alg_values_supported = ["RS256"];
    doc.access_token_claims_supported = ["iss", "sub", "aud", "azp", "scope", "iat", "exp", "jti", "sid", "org_id", "org_slug", "org_role", "org_permissions"];
  }
  if (settings.deviceAuthorizationEnabled) {
    doc.device_authorization_endpoint = `${base}/oauth/device_authorization`;
  }
  return doc;
}
