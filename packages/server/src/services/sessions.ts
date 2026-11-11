import { and, eq, inArray, lt, ne } from "drizzle-orm";
import { ErrorCodes, OrbitError, SESSION_NEVER_EXPIRES_AT, type AuthMethod, type SessionStatus } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { serializeSession } from "../serializers";
import { sendEmail } from "./mail";
import { mfaEnrollmentRequired } from "./mfa";
import { primaryEmail, touchUser, type UserRow } from "./users";
import { emitEvent } from "./webhooks";
import { first } from "../lib/db";
import { revokeGrantsForSession } from "./oidc/revocation";

export interface CreateSessionInput {
  clientId: string;
  userId: string;
  ip?: string;
  userAgent?: string;
  maxLifetimeSeconds?: number;
  firstFactor?: boolean;
  secondFactor?: boolean;
  method?: AuthMethod | null;
  /** Rotates the browser's opaque client token as the session is created (session-fixation defence). */
  rotateClientToken?: () => Promise<void>;
}

const emitSessionEvent = async (ctx: AppContext, type: "session.created" | "session.ended" | "session.removed" | "session.revoked" | "session.pending", row: typeof s.sessions.$inferSelect) => {
  await emitEvent(ctx, type === "session.pending" ? "session.created" : type, await serializeSession(ctx, row, { withUser: true }));
};

/**
 * Absolute `expire_at` for a session created at `now`. `lifetimeSeconds: 0` (the default) and an absent
 * `maxLifetimeSeconds` mean there is no maximum: the row stores the far-future sentinel, so every comparison
 * (stats, sorting, the dashboard) keeps working without a nullable column. A positive cap is absolute and
 * never extended by activity; operators who want idle expiry use `inactivityTimeoutSeconds`.
 */
export function sessionExpireAt(now: number, lifetimeSeconds: number, maxLifetimeSeconds?: number): number {
  const caps = [lifetimeSeconds, maxLifetimeSeconds ?? 0].filter((value) => value > 0);
  return caps.length ? now + Math.min(...caps) * 1000 : SESSION_NEVER_EXPIRES_AT;
}

/**
 * The stored `expire_at` read through the policy in force now.
 *
 * - The unlimited sentinel means "no maximum" unless the operator opted into a positive instance-wide lifetime,
 *   which then caps it from `created_at`.
 * - Any other stored value is an explicit per-session cap (for example `sessionExpireAt(now, 0, 3600)`) and is
 *   enforced even while the instance policy is unlimited. The settings migration converts legacy
 *   old-default deadlines to the sentinel, so a concrete value no longer means "the old 7-day default".
 */
export function sessionExpiresAt(ctx: AppContext, row: typeof s.sessions.$inferSelect): number {
  const lifetime = ctx.settings.get().session.lifetimeSeconds;
  const policyDeadline = lifetime > 0 ? row.createdAt + lifetime * 1000 : Number.POSITIVE_INFINITY;
  if (row.expireAt === SESSION_NEVER_EXPIRES_AT) return policyDeadline;
  return Math.min(row.expireAt, policyDeadline);
}

/** Creates an active session (single-session mode ends the client's other sessions), updates user timestamps, emits `session.created`. */
export async function createSession(ctx: AppContext, input: CreateSessionInput): Promise<string> {
  const st = ctx.settings.get();
  const now = Date.now();
  if (!st.session.multiSession) {
    const others = (await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.clientId, input.clientId), eq(s.sessions.status, "active"))));
    for (const other of others) {
      // Only a still-open row may transition. A stale read must never overwrite a revocation or an expiry.
      const ended = first(await ctx.db.update(s.sessions).set({ status: "ended", updatedAt: now })
        .where(and(eq(s.sessions.id, other.id), inArray(s.sessions.status, ["active", "pending"])))
        .returning({ id: s.sessions.id }));
      if (!ended) continue;
      await revokeGrantsForSession(ctx, other.id);
      await emitSessionEvent(ctx, "session.ended", { ...other, status: "ended", updatedAt: now });
    }
  }
  const expireAt = sessionExpireAt(now, st.session.lifetimeSeconds, input.maxLifetimeSeconds);
  const id = newId("sess");
  // Required MFA without an enrolled factor yields a "pending" session: it can enrol a factor, nothing else.
  // There is no bypass: impersonation was removed, so no session is created outside this policy.
  const owner = first(await ctx.db.select().from(s.users).where(eq(s.users.id, input.userId)));
  const pending = !!owner && await mfaEnrollmentRequired(ctx, owner);
  await ctx.db.insert(s.sessions).values({
            id,
            clientId: input.clientId,
            userId: input.userId,
            status: pending ? "pending" : "active",
    authMethod: input.method ?? null,
            lastActiveAt: now,
            expireAt,
            abandonAt: expireAt,
            // `actor` stays null for every new session; the column is kept so historical rows still serialize.
            actor: null,
            firstFactorVerifiedAt: input.firstFactor === false ? null : now,
            secondFactorVerifiedAt: input.secondFactor ? now : null,
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
            createdAt: now,
            updatedAt: now,
          });
  await ctx.db.update(s.clients).set({ lastActiveSessionId: id, updatedAt: now }).where(eq(s.clients.id, input.clientId));
  // Fixation defence: the token that authenticated this client stops being valid the moment it becomes signed in.
  if (input.rotateClientToken) await input.rotateClientToken();
  await touchUser(ctx, input.userId, { lastSignInAt: now, lastActiveAt: now });
  const row = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)))!;
  await emitSessionEvent(ctx, "session.created", row);
  return id;
}

/**
 * The session that just enrolled a second factor becomes active. Other pending sessions of the user
 * never presented that factor, so they are revoked instead of inheriting it.
 */
export async function completeMfaEnrollment(ctx: AppContext, userId: string, sessionId: string) {
  const now = Date.now();
  await ctx.db.update(s.sessions)
            .set({ status: "active", secondFactorVerifiedAt: now, updatedAt: now })
            .where(and(eq(s.sessions.id, sessionId), eq(s.sessions.userId, userId), eq(s.sessions.status, "pending")));
  const others = (await ctx.db.select().from(s.sessions).where(and(eq(s.sessions.userId, userId), eq(s.sessions.status, "pending"))));
  for (const row of others) {
    const revoked = first(await ctx.db.update(s.sessions).set({ status: "revoked", updatedAt: now })
      .where(and(eq(s.sessions.id, row.id), eq(s.sessions.status, "pending")))
      .returning({ id: s.sessions.id }));
    if (!revoked) continue;
    await revokeGrantsForSession(ctx, row.id);
    await emitSessionEvent(ctx, "session.revoked", { ...row, status: "revoked", updatedAt: now });
  }
}

/** Email notification for a new device/sign-in. Optional (called by sign-in flows when notifications are desired). */
export async function sendNewSignInEmail(ctx: AppContext, user: UserRow, session: typeof s.sessions.$inferSelect, when = Date.now()) {
  const email = await primaryEmail(ctx, user);
  if (!email) return;
  // Only notify for genuinely new devices (the new sign-in notification).
  const knownDevice = (await ctx.db.select().from(s.sessions)
      .where(eq(s.sessions.userId, user.id)))
    .some((row) => row.id !== session.id && row.ip === session.ip && row.userAgent === session.userAgent);
  if (knownDevice) return;
  await sendEmail(ctx, {
    to: email.email,
    template: "new_sign_in",
    vars: {
      user_name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email.email,
      ip_address: session.ip ?? "unknown",
      user_agent: session.userAgent ?? "unknown",
      date: new Date(when).toUTCString(),
    },
  });
}

/** Ends every open session for a user and revokes the OIDC grants minted from each. */
export async function endSessionsForUser(ctx: AppContext, userId: string, status: "revoked" | "removed" | "ended", exceptSessionId?: string): Promise<void> {
  const rows = (await ctx.db.select().from(s.sessions).where(and(eq(s.sessions.userId, userId), inArray(s.sessions.status, ["active", "pending"]))));
  const now = Date.now();
  for (const row of rows) {
    if (exceptSessionId && row.id === exceptSessionId) continue;
    const ended = first(await ctx.db.update(s.sessions).set({ status, updatedAt: now })
      .where(and(eq(s.sessions.id, row.id), inArray(s.sessions.status, ["active", "pending"])))
      .returning({ id: s.sessions.id }));
    if (!ended) continue;
    await revokeGrantsForSession(ctx, row.id);
    const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
    await emitSessionEvent(ctx, type, { ...row, status, updatedAt: now });
  }
}

export const getSession = async (ctx: AppContext, id: string) => first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)));

export function isSessionExpired(ctx: AppContext, row: typeof s.sessions.$inferSelect): boolean {
  if (row.status !== "active" && row.status !== "pending") return false;
  const now = Date.now();
  if (sessionExpiresAt(ctx, row) <= now) return true;
  const inactivityMs = ctx.settings.get().session.inactivityTimeoutSeconds * 1000;
  return inactivityMs > 0 && now - row.lastActiveAt > inactivityMs;
}

/** Applies expiry/inactivity to the DB row and returns the effective status. */
export async function evaluateSessionStatus(ctx: AppContext, row: typeof s.sessions.$inferSelect): Promise<SessionStatus> {
  if (isSessionExpired(ctx, row)) {
    if (row.status !== "expired") {
      // The row read may be stale: another request can have revoked it in the meantime. Never let an expiry
      // heuristic overwrite an operator revocation, a ban, a sign-out or a pending-MFA state.
      const expired = first(await ctx.db.update(s.sessions).set({ status: "expired", updatedAt: Date.now() })
        .where(and(eq(s.sessions.id, row.id), inArray(s.sessions.status, ["active", "pending"])))
        .returning({ id: s.sessions.id }));
      if (expired) await revokeGrantsForSession(ctx, row.id);
    }
    return "expired";
  }
  return row.status as SessionStatus;
}

/** Loads a session that belongs to `clientId` and is usable; throws otherwise. */
export async function requireSession(ctx: AppContext, clientId: string, sessionId: string) {
  const row = await getSession(ctx, sessionId);
  if (!row || row.clientId !== clientId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
  const status = await evaluateSessionStatus(ctx, row);
  if (status !== "active" && status !== "pending") {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, `This session is ${status}`, { session_id: row.id });
  }
  return { ...row, status };
}

export async function endSession(ctx: AppContext, row: typeof s.sessions.$inferSelect, status: "ended" | "removed" | "revoked" = "ended") {
  const now = Date.now();
  const ended = first(await ctx.db.update(s.sessions).set({ status, updatedAt: now })
    .where(and(eq(s.sessions.id, row.id), inArray(s.sessions.status, ["active", "pending"])))
    .returning({ id: s.sessions.id }));
  // A stale read must not rewrite a terminal status (revoked/expired/ended/removed/replaced). If the row was
  // already ended, its grants were already revoked by whichever transition won.
  if (!ended) return (await getSession(ctx, row.id))!;
  // Any way a session ends ends the OIDC grants it authorized. Only RP-initiated logout used to do this, so an
  // operator revoke / self sign-out / ban left refresh tokens alive.
  await revokeGrantsForSession(ctx, row.id);
  const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, row.clientId)));
  if (client?.lastActiveSessionId === row.id) {
    const next = first(await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.clientId, row.clientId), eq(s.sessions.status, "active"), ne(s.sessions.id, row.id))));
    await ctx.db.update(s.clients).set({ lastActiveSessionId: next?.id ?? null, updatedAt: now }).where(eq(s.clients.id, row.clientId));
  }
  const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
  await emitSessionEvent(ctx, type, { ...row, status });
  return (await getSession(ctx, row.id))!;
}

/** Minimum gap between activity writes caused by token refreshes (one write per refresh would be needless). */
const ACTIVITY_SLIDE_INTERVAL_MS = 30_000;
/** User-level activity is cheaper-grained: a conditional write at most once per five minutes. */
const USER_ACTIVITY_SLIDE_INTERVAL_MS = 5 * 60_000;

/**
 * Per-database, per-user timestamp of the last throttled `users.last_active_at` write.
 *
 * The conditional UPDATE keeps the stored value correct even across processes, but issuing it on every token
 * refresh (several tabs, several times a minute) is a needless write on SQLite's single write lock. Remembering the
 * last write here keeps exactly the same five-minute freshness (the first refresh after a restart still writes) and
 * removes the write from the hot path when it cannot change anything.
 */
const userActivityWrites = new WeakMap<object, Map<string, number>>();

function userActivityWriteDue(db: object, userId: string, now: number): boolean {
  let writes = userActivityWrites.get(db);
  if (!writes) {
    writes = new Map();
    userActivityWrites.set(db, writes);
  }
  const last = writes.get(userId) ?? 0;
  if (now - last < USER_ACTIVITY_SLIDE_INTERVAL_MS) return false;
  writes.set(userId, now);
  // Bound memory in a long-lived process: only users whose window elapsed can be forgotten safely.
  if (writes.size > 10_000) {
    for (const [key, at] of writes) if (now - at >= USER_ACTIVITY_SLIDE_INTERVAL_MS) writes.delete(key);
  }
  return true;
}

/**
 * Activity bookkeeping for a token mint or handshake.
 *
 * - An operator's opt-in **inactivity timeout** slides: minting a token is activity, so the timeout measures
 *   *idle* time rather than "time since the app last called touch". With the default timeout of 0 no session
 *   write happens.
 * - `users.last_active_at` is refreshed at most once per five minutes. Guest retention
 *   (`anonymous.retentionSeconds`) and activity stats read that column; without this an active guest would
 *   look idle and be deleted after the retention window, ending a session the user never ended.
 */
export async function slideSessionActivity(ctx: AppContext, row: typeof s.sessions.$inferSelect, now = Date.now()) {
  let next = row;
  const inactivityMs = ctx.settings.get().session.inactivityTimeoutSeconds * 1000;
  if (inactivityMs > 0 && now - row.lastActiveAt >= ACTIVITY_SLIDE_INTERVAL_MS) {
    await ctx.db.update(s.sessions).set({ lastActiveAt: now, updatedAt: now }).where(eq(s.sessions.id, row.id));
    next = { ...row, lastActiveAt: now, updatedAt: now };
  }
  if (userActivityWriteDue(ctx.db as object, row.userId, now)) {
    await ctx.db.update(s.users)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(and(eq(s.users.id, row.userId), lt(s.users.lastActiveAt, now - USER_ACTIVITY_SLIDE_INTERVAL_MS)));
  }
  return next;
}

/** Updates activity, and the active organization when the user is a member of it. */
export async function touchSession(ctx: AppContext, row: typeof s.sessions.$inferSelect, opts: { organizationId?: string | null; ip?: string; userAgent?: string } = {}) {
  const now = Date.now();
  const patch: Partial<typeof s.sessions.$inferInsert> = { lastActiveAt: now, updatedAt: now };
  if (opts.ip) patch.ip = opts.ip;
  if (opts.userAgent) patch.userAgent = opts.userAgent;
  if (opts.organizationId !== undefined) {
    if (opts.organizationId === null) patch.lastActiveOrganizationId = null;
    else {
      const membership = first(await ctx.db.select().from(s.organizationMemberships)
              .where(and(eq(s.organizationMemberships.organizationId, opts.organizationId), eq(s.organizationMemberships.userId, row.userId))));
      if (!membership) throw new OrbitError(403, ErrorCodes.not_a_member_in_organization, "You are not a member of this organization");
      patch.lastActiveOrganizationId = opts.organizationId;
    }
  }
  await ctx.db.update(s.sessions).set(patch).where(eq(s.sessions.id, row.id));
  await touchUser(ctx, row.userId, { lastActiveAt: now });
  return (await getSession(ctx, row.id))!;
}

/** Marks a reverification as done on the session. Level `first_factor` also refreshes the second factor age. */
export async function markSessionReverified(ctx: AppContext, sessionId: string, level: "first_factor" | "second_factor" | "multi_factor") {
  const now = Date.now();
  const patch: Partial<typeof s.sessions.$inferInsert> = { updatedAt: now };
  if (level === "first_factor" || level === "multi_factor") patch.firstFactorVerifiedAt = now;
  if (level === "second_factor" || level === "multi_factor") patch.secondFactorVerifiedAt = now;
  await ctx.db.update(s.sessions).set(patch).where(eq(s.sessions.id, sessionId));
  return (await getSession(ctx, sessionId))!;
}
