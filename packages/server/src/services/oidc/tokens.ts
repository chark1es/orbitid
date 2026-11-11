// OIDC/OAuth2 provider service: authorization codes, access/refresh tokens, rotation, revocation.
//
// Storage notes:
//  - codes/access/refresh tokens are random opaque strings; only sha256 hashes are stored in `oauth_grants`. The one
//    exception is the successor refresh token sealed (AES-GCM with ORBITID_ENCRYPTION_KEY) on a consumed row for the
//    retry grace window, so an idempotent retry can return the same token without rotating again.
//  - `family_id` ties the access and refresh tokens of one authorization together (refresh rotation and reuse
//    detection); `session_id` keeps `sid` and the org claims tied to the authorizing session; `nonce` is the
//    OIDC nonce of an authorization code.
//
// Token-set planning lives in `token-set.ts`, refresh rotation in `refresh.ts` and shared lookups in `grants.ts`. The
// public surface is re-exported here so `services/oidc.ts` (and callers) keep one import point.
import { and, eq, gt } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { randomToken, safeEqual, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { getJwks } from "../tokens";
import { first } from "../../lib/db";
import { AUTHORIZATION_CODE_TTL_SECONDS, OAuthError, type ApplicationRow, type GrantRow } from "./shared";
import { getApplication, parseScopes, pkceChallengeFor } from "./applications";
import { appendOrgClaims, organizationClaims, primaryEmail, userInfoClaims } from "./claims";
import { authorizingSessionActive, findGrantByToken, isGrantLive } from "./grants";
import { issueTokenSet, type TokenSet } from "./token-set";
import { revokeGrantFamily } from "./revocation";

// Re-exported for callers that imported these from this module before they moved to cohesive modules.
export { revokeGrantFamily, revokeGrantsForSession, revokeGrantsForUser } from "./revocation";
export { appendOrgClaims, organizationClaims, primaryEmail, userInfoClaims };
export type { OrganizationClaims } from "./claims";
export { authorizingSessionActive, findGrantByToken, isGrantLive } from "./grants";
export { issueTokenSet } from "./token-set";
export type { TokenSet, TokenSetInput } from "./token-set";
export { exchangeRefreshToken } from "./refresh";
export type { RefreshExchangeHooks, RefreshExchangeOptions } from "./refresh";

type UserRow = typeof s.users.$inferSelect;

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

export interface CodeExchangeInput {
  application: ApplicationRow;
  code: string;
  redirectUri?: string;
  codeVerifier?: string;
  issuer?: string;
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
  if (!(await authorizingSessionActive(ctx, row.sessionId))) {
    throw new OAuthError(400, "invalid_grant", "The session that authorized this code has ended");
  }
  // Revoking the code is the gate: exactly one exchange of a code succeeds, even under parallel requests.
  const claimed = first(await ctx.db.update(s.oauthGrants).set({ revoked: true })
    .where(and(eq(s.oauthGrants.id, row.id), eq(s.oauthGrants.revoked, false), gt(s.oauthGrants.expiresAt, Date.now())))
    .returning({ id: s.oauthGrants.id }));
  if (!claimed) throw new OAuthError(400, "invalid_grant", "Authorization code is invalid or expired");

  return issueTokenSet(ctx, {
    application: input.application,
    user,
    scopes: parseScopes(row.scopes),
    family: randomToken(9),
    nonce: row.nonce,
    sessionId: row.sessionId,
    issuer: input.issuer,
  });
}

/** Resolves an access token to its grant + user (userinfo / introspection). Opaque and JWT tokens both work. */
export async function accessGrantFromToken(ctx: AppContext, token: string, issuer?: string): Promise<{ row: GrantRow; user: UserRow }> {
  const row = await findGrantByToken(ctx, token);
  if (!row || row.kind !== "access" || !isGrantLive(row)) throw new OAuthError(401, "invalid_token", "Access token is invalid or expired");
  if (!token.startsWith("oat_")) {
    // JWT access tokens are recorded above, so revocation still wins over an offline-valid signature.
    try {
      const app = await getApplication(ctx, row.applicationId);
      const { payload } = await jwtVerify(token, createLocalJWKSet(await getJwks(ctx)), {
        issuer: issuer ?? ctx.env.baseUrl,
        audience: app?.clientId,
        algorithms: ["RS256"],
      });
      if (payload.sub !== row.userId || payload.jti !== row.id) throw new Error("claim mismatch");
    } catch {
      throw new OAuthError(401, "invalid_token", "Access token is invalid or expired");
    }
  }
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) throw new OAuthError(401, "invalid_token", "User is not allowed to sign in");
  // Access tokens are bearer credentials for an application, not a second, session-independent login.
  if (!(await authorizingSessionActive(ctx, row.sessionId))) {
    throw new OAuthError(401, "invalid_token", "The session that authorized this access token has ended");
  }
  return { row, user };
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
export async function introspectToken(ctx: AppContext, application: ApplicationRow, token: string, issuer?: string): Promise<Record<string, unknown>> {
  const row = await findGrantByToken(ctx, token);
  if (!row || row.applicationId !== application.id || !isGrantLive(row) || row.kind === "code") return { active: false };
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, row.userId)));
  if (!user || user.banned) return { active: false };
  if (!(await authorizingSessionActive(ctx, row.sessionId))) return { active: false };
  const email = await primaryEmail(ctx, user);
  return {
    active: true,
    scope: row.scopes,
    client_id: application.clientId,
    username: user.username ?? email?.email ?? undefined,
    sub: row.userId,
    iss: issuer ?? ctx.env.baseUrl,
    aud: application.clientId,
    exp: Math.floor(row.expiresAt / 1000),
    iat: Math.floor(row.createdAt / 1000),
    jti: row.id,
    token_type: row.kind === "refresh" ? "refresh_token" : "Bearer",
  };
}
