// Planning and persistence of OIDC token sets. Reads and signing happen in `planTokenSet`; the rows are written by
// `insertTokenSet`, so callers can persist them inside one transaction (refresh rotation) or immediately.
import { ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../../context";
import type { Db } from "../../db";
import * as s from "../../db/schema";
import { randomToken, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { signJwt } from "../tokens";
import type { ApplicationRow } from "./shared";
import { applicationLifetimes } from "./applications";
import { appendOrgClaims, buildIdTokenClaims, groupsForUser } from "./claims";

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

type UserRow = typeof s.users.$inferSelect;

export interface TokenSetInput {
  application: ApplicationRow;
  user: UserRow;
  scopes: string[];
  family: string;
  nonce?: string | null;
  /** The browser session that authorized the grant; enables `sid` on JWTs and org claims. */
  sessionId?: string | null;
  /** Public issuer; defaults to the configured base URL when a caller does not pass it. */
  issuer?: string;
  /**
   * A pre-generated refresh-token id/value. The refresh exchange claims the old token (storing this successor)
   * before inserting the new row, so a concurrent retry can already find it.
   */
  refresh?: { id: string; token: string };
  /**
   * Return this existing refresh token instead of rotating: a retry inside the grace window answers with the same
   * successor token and no new rotation (see `retryRotatedRefresh` in `refresh.ts`).
   */
  reuseRefreshToken?: string;
}

type GrantInsert = typeof s.oauthGrants.$inferInsert;

export interface PlannedTokenSet {
  set: TokenSet;
  access: GrantInsert;
  refresh: GrantInsert | null;
}

/**
 * Computes a token set and every row it needs, without writing anything. Reads (org claims, groups, the id_token
 * signing key) happen here so the caller can persist the rows in one short transaction. Splitting planning from
 * insertion is what lets refresh rotation consume the old token, refuse a revoked family and insert its successor
 * atomically.
 */
export async function planTokenSet(ctx: AppContext, input: TokenSetInput): Promise<PlannedTokenSet> {
  const now = Date.now();
  const scope = input.scopes.join(" ");
  const sessionId = input.sessionId ?? null;
  const issuer = input.issuer ?? ctx.env.baseUrl;
  const lifetimes = applicationLifetimes(input.application);
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
    if (input.scopes.includes("groups")) {
      const groups = await groupsForUser(ctx, input.application, input.user.id);
      if (groups) claims.groups = groups;
    }
    if (input.scopes.includes("organizations")) await appendOrgClaims(claims, ctx, input.user.id, sessionId);
    accessToken = await signJwt(ctx, claims, {
      expiresInSeconds: lifetimes.access,
      issuer,
      audience: input.application.clientId,
    });
  } else {
    accessToken = `oat_${randomToken(32)}`;
  }

  const set: TokenSet = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: lifetimes.access,
    scope,
  };

  let refresh: GrantInsert | null = null;
  if (input.scopes.includes("offline_access")) {
    if (input.reuseRefreshToken) {
      set.refresh_token = input.reuseRefreshToken;
    } else {
      const refreshId = input.refresh?.id ?? newId(ID_PREFIX.oauthGrant);
      const refreshToken = input.refresh?.token ?? `ort_${randomToken(32)}`;
      refresh = {
        id: refreshId,
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
        expiresAt: now + lifetimes.refresh * 1000,
        createdAt: now,
      };
      set.refresh_token = refreshToken;
    }
  }

  if (input.scopes.includes("openid")) {
    const claims = await buildIdTokenClaims(ctx, {
      user: input.user,
      application: input.application,
      scopes: input.scopes,
      nonce: input.nonce ?? null,
      sessionId,
      accessToken,
    });
    set.id_token = await signJwt(ctx, claims, {
      expiresInSeconds: lifetimes.id,
      issuer,
      audience: input.application.clientId,
    });
  }

  return {
    set,
    access: {
      id: grantId,
      kind: "access",
      applicationId: input.application.id,
      userId: input.user.id,
      tokenHash: sha256(accessToken),
      scopes: scope,
      // the authorizing session (org claims, `sid`); see the storage note in `tokens.ts`
      sessionId,
      codeChallenge: null,
      codeChallengeMethod: null,
      familyId: input.family,
      revoked: false,
      expiresAt: now + lifetimes.access * 1000,
      createdAt: now,
    },
    refresh,
  };
}

/** Persists a planned token set on the current connection (inside the caller's transaction when there is one). */
export async function insertTokenSet(db: Db, plan: PlannedTokenSet): Promise<void> {
  await db.insert(s.oauthGrants).values(plan.access);
  if (plan.refresh) await db.insert(s.oauthGrants).values(plan.refresh);
}

/**
 * Mints an access token (+ refresh token when `offline_access`) and the id_token when `openid` is granted.
 * With `settings.oidcProvider.accessTokenFormat === "jwt"` the access token is an RS256 JWT signed with the
 * instance key (same JWKS as session tokens); it is still recorded in `oauth_grants` so it can be revoked.
 */
export async function issueTokenSet(ctx: AppContext, input: TokenSetInput): Promise<TokenSet> {
  const plan = await planTokenSet(ctx, input);
  await insertTokenSet(ctx.db, plan);
  return plan.set;
}
