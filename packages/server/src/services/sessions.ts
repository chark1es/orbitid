import { and, eq, inArray, ne } from "drizzle-orm";
import { ErrorCodes, OrbitError, type AuthMethod, type SessionStatus } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { serializeSession } from "../serializers";
import { sendEmail } from "./mail";
import { mfaEnrollmentRequired } from "./mfa";
import { primaryEmail, touchUser, type UserRow } from "./users";
import { emitEvent } from "./webhooks";
import { first } from "../lib/db";

export interface CreateSessionInput {
  clientId: string;
  userId: string;
  actor?: Record<string, unknown>;
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

/** Creates an active session (single-session mode ends the client's other sessions), updates user timestamps, emits `session.created`. */
export async function createSession(ctx: AppContext, input: CreateSessionInput): Promise<string> {
  const st = ctx.settings.get();
  const now = Date.now();
  if (!st.session.multiSession) {
    const others = (await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.clientId, input.clientId), eq(s.sessions.status, "active"))));
    for (const other of others) {
      await ctx.db.update(s.sessions).set({ status: "ended", updatedAt: now }).where(eq(s.sessions.id, other.id));
      await emitSessionEvent(ctx, "session.ended", { ...other, status: "ended", updatedAt: now });
    }
  }
  const lifetimeMs = Math.min(st.session.lifetimeSeconds, input.maxLifetimeSeconds ?? Number.POSITIVE_INFINITY) * 1000;
  const id = newId("sess");
  // Required MFA without an enrolled factor yields a "pending" session: it can enrol a factor, nothing else.
  const owner = first(await ctx.db.select().from(s.users).where(eq(s.users.id, input.userId)));
  const pending = !input.actor && !!owner && await mfaEnrollmentRequired(ctx, owner);
  await ctx.db.insert(s.sessions).values({
            id,
            clientId: input.clientId,
            userId: input.userId,
            status: pending ? "pending" : "active",
    authMethod: input.method ?? null,
            lastActiveAt: now,
            expireAt: now + lifetimeMs,
            abandonAt: now + lifetimeMs,
            actor: input.actor ?? null,
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
    await ctx.db.update(s.sessions).set({ status: "revoked", updatedAt: now }).where(eq(s.sessions.id, row.id));
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

export async function endSessionsForUser(ctx: AppContext, userId: string, status: "revoked" | "removed" | "ended", exceptSessionId?: string): Promise<void> {
  const rows = (await ctx.db.select().from(s.sessions).where(and(eq(s.sessions.userId, userId), inArray(s.sessions.status, ["active", "pending"]))));
  const now = Date.now();
  for (const row of rows) {
    if (exceptSessionId && row.id === exceptSessionId) continue;
    await ctx.db.update(s.sessions).set({ status, updatedAt: now }).where(eq(s.sessions.id, row.id));
    const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
    await emitSessionEvent(ctx, type, { ...row, status, updatedAt: now });
  }
}

export const getSession = async (ctx: AppContext, id: string) => first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)));

export function isSessionExpired(ctx: AppContext, row: typeof s.sessions.$inferSelect): boolean {
  if (row.status !== "active" && row.status !== "pending") return false;
  const now = Date.now();
  if (row.expireAt <= now) return true;
  const inactivityMs = ctx.settings.get().session.inactivityTimeoutSeconds * 1000;
  return inactivityMs > 0 && now - row.lastActiveAt > inactivityMs;
}

/** Applies expiry/inactivity to the DB row and returns the effective status. */
export async function evaluateSessionStatus(ctx: AppContext, row: typeof s.sessions.$inferSelect): Promise<SessionStatus> {
  if (isSessionExpired(ctx, row)) {
    if (row.status !== "expired") {
      await ctx.db.update(s.sessions).set({ status: "expired", updatedAt: Date.now() }).where(eq(s.sessions.id, row.id));
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
  await ctx.db.update(s.sessions).set({ status, updatedAt: Date.now() }).where(eq(s.sessions.id, row.id));
  const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, row.clientId)));
  if (client?.lastActiveSessionId === row.id) {
    const next = first(await ctx.db.select().from(s.sessions)
          .where(and(eq(s.sessions.clientId, row.clientId), eq(s.sessions.status, "active"), ne(s.sessions.id, row.id))));
    await ctx.db.update(s.clients).set({ lastActiveSessionId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.clients.id, row.clientId));
  }
  const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
  await emitSessionEvent(ctx, type, { ...row, status });
  return (await getSession(ctx, row.id))!;
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
