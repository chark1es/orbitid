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
import {
  ACCESS_TOKEN_TTL_SECONDS, AUTHORIZATION_CODE_TTL_SECONDS, ID_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS,
  OAuthError, type ApplicationRow, type GrantRow,
} from "./shared";
import { getApplication, parseScopes, pkceChallengeFor } from "./applications";

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
            nonce: input.nonce ?? null,
            sessionId: input.sessionId ?? null,
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
            .where(and(inArray(s.oauthGrants.kind, ["access", "refresh"]), eq(s.oauthGrants.familyId, family)));
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
  if (!ctx.settings.get().organizations.enabled) return { active: null, memberships: [] };
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
            sessionId: sessionId ?? null,
            codeChallenge: null,
            codeChallengeMethod: null,
            familyId: input.family,
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
                  sessionId: sessionId ?? null,
                  codeChallenge: null,
                  codeChallengeMethod: null,
                  familyId: input.family,
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

  const meta = { nonce: row.nonce, sid: row.sessionId };
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
  const family = row.familyId ?? "";
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
    sessionId: row.sessionId,
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
  if (scopes.includes("organizations")) await appendOrgClaims(claims, ctx, user.id, row.sessionId);
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
  if (row.kind === "refresh" && row.familyId) await revokeGrantFamily(ctx, row.familyId);
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
