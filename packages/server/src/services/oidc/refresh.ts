// `grant_type=refresh_token`: rotating refresh tokens, reuse detection, and the short idempotent retry window.
//
// Consuming the presented token, checking the family is still live and inserting its successor + access token
// happen in one transaction (see `inWriteTransaction`). That closes the gap where a concurrent request could see
// a consumed token with no successor, revoke the family as theft, and then let the winner insert live tokens into
// the revoked family.
import { and, eq, gt, isNull } from "drizzle-orm";
import { ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../../context";
import type { Db } from "../../db";
import * as s from "../../db/schema";
import { decrypt, encrypt, randomToken, safeEqual, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { first, inWriteTransaction, lockGrantFamily } from "../../lib/db";
import { REFRESH_REUSE_GRACE_SECONDS, OAuthError, type ApplicationRow, type GrantRow } from "./shared";
import { parseScopes } from "./applications";
import { authorizingSessionActive, findGrantByToken } from "./grants";
import { insertTokenSet, planTokenSet, type TokenSet, type TokenSetInput } from "./token-set";
import { revokeGrantFamily } from "./revocation";

interface RefreshRetry {
  /** The refresh token that replaced the presented one. */
  successor: GrantRow;
  /** That successor's value, recoverable only inside the grace window. */
  token: string;
}

/**
 * A presented token that was already rotated out may be a client retrying a lost response. The window is measured
 * from when *that* token was consumed (`consumedAt`), never from the successor's creation: replaying the same old
 * token cannot keep extending it. Inside the window the retry is idempotent — the same successor token is
 * returned and nothing rotates. Outside it the token is treated as stolen and the family is revoked.
 */
async function retryRotatedRefresh(ctx: AppContext, consumed: GrantRow): Promise<RefreshRetry | null> {
  if (!consumed.consumedAt || !consumed.successorId || !consumed.successorTokenEnc) return null;
  const graceSeconds = ctx.settings.get().oidcProvider.refreshTokenReuseGraceSeconds ?? REFRESH_REUSE_GRACE_SECONDS;
  if (graceSeconds <= 0 || Date.now() - consumed.consumedAt > graceSeconds * 1000) return null;
  const successor = first(await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.id, consumed.successorId)));
  if (!successor || successor.kind !== "refresh" || successor.revoked || successor.expiresAt <= Date.now()) return null;
  let token: string;
  try {
    token = decrypt(ctx.env.encryptionKey, consumed.successorTokenEnc);
  } catch {
    return null;
  }
  if (!safeEqual(sha256(token), successor.tokenHash)) return null;
  return { successor, token };
}

export interface RefreshExchangeOptions {
  issuer?: string;
  /** Scopes requested with this refresh; must be a subset of the original grant. */
  scopes?: string[];
  /** Test seam: runs around the rotation transaction (see {@link RefreshExchangeHooks}). */
  hooks?: RefreshExchangeHooks;
}

export interface RefreshExchangeHooks {
  /**
   * Awaited after the token set was planned but before the rotation transaction starts. A test can revoke the whole
   * family here (for example because its browser session ended) and prove no successor is inserted.
   */
  beforeConsume?: () => void | Promise<void>;
  /**
   * Awaited after the conditional consumption update but before the successor/access rows are inserted. A test can
   * pause here to run a competing exchange against another connection and prove the loser blocks and reuses the
   * winner's successor instead of revoking the family.
   */
  afterConsume?: () => void | Promise<void>;
}

/** A token was consumed into a family that another operation revoked. The transaction must roll back. */
class RevokedFamilyError extends Error {}

/**
 * Whether a rotation family has been revoked as a whole. A consumed rotation predecessor is `revoked` too, but it
 * carries `consumed_at`; a live refresh token that has been revoked has not been consumed. Access tokens are not
 * considered: revoking one access token (RFC 7009) must not turn its still-valid refresh token into "family theft".
 * Session/family revocation locks the family (see `revocation.ts`), so this check observes a serialized state.
 */
async function familyIsRevoked(db: Db, family: string): Promise<boolean> {
  if (!family) return false;
  const rows = await db.select({ id: s.oauthGrants.id }).from(s.oauthGrants)
    .where(and(
      eq(s.oauthGrants.familyId, family),
      eq(s.oauthGrants.kind, "refresh"),
      eq(s.oauthGrants.revoked, true),
      isNull(s.oauthGrants.consumedAt),
    ))
    .limit(1);
  return rows.length > 0;
}

/** Mints a token set into an existing family, serialized against family revocation. */
async function issueTokenSetInLiveFamily(ctx: AppContext, input: TokenSetInput, family: string): Promise<TokenSet> {
  const plan = await planTokenSet(ctx, input);
  await inWriteTransaction(ctx, async (tx) => {
    await lockGrantFamily(ctx, tx, family);
    if (await familyIsRevoked(tx, family)) {
      throw new OAuthError(400, "invalid_grant", "Refresh token family has been revoked");
    }
    await insertTokenSet(tx, plan);
  });
  return plan.set;
}

/** `grant_type=refresh_token`: rotating refresh tokens with reuse detection and a short retry grace window. */
export async function exchangeRefreshToken(
  ctx: AppContext,
  application: ApplicationRow,
  refreshToken: string,
  options: RefreshExchangeOptions = {},
): Promise<TokenSet> {
  const row = await findGrantByToken(ctx, refreshToken);
  if (!row || row.kind !== "refresh" || row.applicationId !== application.id) {
    throw new OAuthError(400, "invalid_grant", "Refresh token is invalid");
  }
  const family = row.familyId ?? "";
  let active: GrantRow = row;
  let replay: RefreshRetry | null = null;
  if (row.revoked) {
    replay = await retryRotatedRefresh(ctx, row);
    if (!replay) {
      // A rotated-out token outside the grace window, or one whose family is already dead: assume theft.
      await revokeGrantFamily(ctx, family);
      throw new OAuthError(400, "invalid_grant", "Refresh token has already been used");
    }
    active = replay.successor;
  }
  if (active.expiresAt <= Date.now()) throw new OAuthError(400, "invalid_grant", "Refresh token has expired");
  // A refresh token outlives its grant only if the browser session it came from is still live. Ending the session
  // (sign-out, operator revoke, ban policy, sign-out-all) must end the RP's access with it.
  if (!(await authorizingSessionActive(ctx, active.sessionId))) {
    await revokeGrantFamily(ctx, family);
    throw new OAuthError(400, "invalid_grant", "The session that authorized this refresh token has ended");
  }
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, active.userId)));
  if (!user || user.banned) {
    await revokeGrantFamily(ctx, family);
    throw new OAuthError(400, "invalid_grant", "User is not allowed to sign in");
  }

  const originalScopes = parseScopes(active.scopes);
  let scopes = originalScopes;
  if (options.scopes && options.scopes.length) {
    const requested = [...new Set(options.scopes)];
    const escalated = requested.filter((scope) => !originalScopes.includes(scope));
    if (escalated.length) throw new OAuthError(400, "invalid_scope", `Scope was not granted: ${escalated.join(", ")}`);
    scopes = requested;
  }

  if (replay) {
    // Idempotent retry: hand back the same successor refresh token; no rotation, no extension of the window.
    return issueTokenSetInLiveFamily(ctx, {
      application, user, scopes, family, nonce: null,
      sessionId: active.sessionId,
      issuer: options.issuer,
      reuseRefreshToken: replay.token,
    }, family);
  }

  // Everything that needs a read (org/groups claims, the id_token signature) is prepared first. The conditional
  // consumption, the revoked-family check and both new rows then happen in one transaction: a competing request
  // either blocks on the family lock and finds the committed successor, or fails cleanly. It can never observe a
  // consumed token with no successor and revoke a live family, and a successor can never land in a revoked family.
  const now = Date.now();
  const successorId = newId(ID_PREFIX.oauthGrant);
  const successorToken = `ort_${randomToken(32)}`;
  const plan = await planTokenSet(ctx, {
    application, user, scopes, family, nonce: null,
    sessionId: active.sessionId,
    issuer: options.issuer,
    refresh: { id: successorId, token: successorToken },
  });
  await options.hooks?.beforeConsume?.();
  let claimed: boolean;
  try {
    claimed = await inWriteTransaction(ctx, async (tx) => {
      await lockGrantFamily(ctx, tx, family);
      const updated = first(await tx.update(s.oauthGrants).set({
        revoked: true,
        consumedAt: now,
        successorId,
        successorTokenEnc: encrypt(ctx.env.encryptionKey, successorToken),
      })
        .where(and(
          eq(s.oauthGrants.id, active.id),
          eq(s.oauthGrants.revoked, false),
          isNull(s.oauthGrants.consumedAt),
          gt(s.oauthGrants.expiresAt, now),
        ))
        .returning({ id: s.oauthGrants.id }));
      if (!updated) return false;
      await options.hooks?.afterConsume?.();
      if (await familyIsRevoked(tx, family)) throw new RevokedFamilyError();
      await insertTokenSet(tx, plan);
      return true;
    });
  } catch (error) {
    if (error instanceof RevokedFamilyError) {
      throw new OAuthError(400, "invalid_grant", "Refresh token family has been revoked");
    }
    throw error;
  }
  if (!claimed) {
    // Another request consumed this token first. That is a concurrent refresh, not necessarily theft: use the
    // grace path, and never kill the family solely because we lost the race. The winner's transaction has
    // committed (we were serialized by the family lock), so its successor is visible here.
    const fresh = first(await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.id, active.id)));
    const retry = fresh ? await retryRotatedRefresh(ctx, fresh) : null;
    if (!retry) {
      await revokeGrantFamily(ctx, family);
      throw new OAuthError(400, "invalid_grant", "Refresh token has already been used");
    }
    return issueTokenSetInLiveFamily(ctx, {
      application, user, scopes, family, nonce: null,
      sessionId: retry.successor.sessionId,
      issuer: options.issuer,
      reuseRefreshToken: retry.token,
    }, family);
  }
  return plan.set;
}
