// Revocation primitives for the OIDC provider, kept free of imports from the session service so both the session
// lifecycle and the token service can call them without a cycle.
import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { inWriteTransaction, lockGrantFamily } from "../../lib/db";

/** Scopes whose issued claims carry organization or group authority. */
const ORGANIZATION_AUTHORITY_SCOPES = new Set(["groups", "organizations"]);

/**
 * Revokes every token in a rotation family (refresh reuse detection / RFC 7009 on a refresh token).
 *
 * The lock (advisory on Postgres, the `BEGIN IMMEDIATE` write lock on SQLite) makes this race-free against a
 * concurrent rotation: issuance and revocation of one family are serialized, so a token can never be inserted
 * into a family after its revocation has been decided.
 */
export async function revokeGrantFamily(ctx: AppContext, family: string): Promise<void> {
  if (!family) return;
  await inWriteTransaction(ctx, async (tx) => {
    await lockGrantFamily(ctx, tx, family);
    await tx.update(s.oauthGrants).set({ revoked: true })
      .where(and(inArray(s.oauthGrants.kind, ["access", "refresh"]), eq(s.oauthGrants.familyId, family)));
  });
}

/**
 * Revokes rows matching `scope`, taking every affected family lock first. Locking is what makes a session end race
 * with a refresh rotation safely: a rotation either commits before the revocation's UPDATE (whose fresh snapshot
 * then includes the new rows) or waits until the revocation is done and finds its token revoked. Families are
 * locked in sorted order so two revocations cannot deadlock.
 */
async function revokeScopedGrants(ctx: AppContext, scope: SQL): Promise<void> {
  await inWriteTransaction(ctx, async (tx) => {
    const rows = await tx.select({ familyId: s.oauthGrants.familyId }).from(s.oauthGrants)
      .where(and(scope, inArray(s.oauthGrants.kind, ["access", "refresh"])));
    const families = [...new Set(rows.map((row) => row.familyId).filter((family): family is string => !!family))].sort();
    for (const family of families) await lockGrantFamily(ctx, tx, family);
    await tx.update(s.oauthGrants).set({ revoked: true }).where(scope);
  });
}

/**
 * Revokes every grant minted from a browser session. Called by every way a session can end: self sign-out,
 * operator revoke, ban, sign-out-all, removal and expiry. Without this, an RP's refresh token outlives the
 * OrbitID session that authorized it.
 */
export async function revokeGrantsForSession(ctx: AppContext, sessionId: string): Promise<void> {
  if (!sessionId) return;
  await revokeScopedGrants(ctx, and(
    inArray(s.oauthGrants.kind, ["access", "refresh", "code"]),
    eq(s.oauthGrants.sessionId, sessionId),
  )!);
}

/** Revokes every grant a user holds, including device-flow grants with no browser session. */
export async function revokeGrantsForUser(ctx: AppContext, userId: string): Promise<void> {
  if (!userId) return;
  await revokeScopedGrants(ctx, and(
    inArray(s.oauthGrants.kind, ["access", "refresh", "code"]),
    eq(s.oauthGrants.userId, userId),
  )!);
}

/**
 * Revokes the grants of applications whose tokens assert organization or group authority: an application with
 * `groups`/`organizations` in its configured scopes and a `groups_claim` other than `none`. Called when a
 * membership is removed, a role is demoted, or the organization is deleted.
 *
 * This deliberately does not touch the browser session: the user stays signed in to OrbitID. Access JWTs that
 * were already issued remain valid until their (short, application-configured) `exp`; refresh tokens are dead
 * immediately, so the RP cannot mint another and must re-authorize to see the new membership state.
 */
export async function revokeOrganizationAuthorityGrants(ctx: AppContext, userId: string): Promise<void> {
  if (!userId) return;
  const applications = await ctx.db.select().from(s.oauthApplications);
  const applicationIds = applications
    .filter((application) => (application.groupsClaim ?? "all") !== "none")
    .filter((application) => (application.scopes ?? "").split(/[\s,]+/).some((scope) => ORGANIZATION_AUTHORITY_SCOPES.has(scope)))
    .map((application) => application.id);
  if (!applicationIds.length) return;
  const scope = and(
    eq(s.oauthGrants.userId, userId),
    inArray(s.oauthGrants.applicationId, applicationIds),
    inArray(s.oauthGrants.kind, ["access", "refresh", "code"]),
  )!;
  // Lock the affected families too: an organization change must not race a refresh rotation into creating a live
  // token after this revocation's snapshot.
  await inWriteTransaction(ctx, async (tx) => {
    const rows = await tx.select({ familyId: s.oauthGrants.familyId }).from(s.oauthGrants)
      .where(and(scope, inArray(s.oauthGrants.kind, ["access", "refresh"])));
    const families = [...new Set(rows.map((row) => row.familyId).filter((family): family is string => !!family))].sort();
    for (const family of families) await lockGrantFamily(ctx, tx, family);
    await tx.update(s.oauthGrants).set({ revoked: true }).where(scope);
  });
}
