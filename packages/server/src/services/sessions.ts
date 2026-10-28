// OWNER: worker "core" (W1).
import { and, eq, ne } from "drizzle-orm";
import { ErrorCodes, OrbitError, type SessionStatus } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { newId } from "../lib/ids";
import { serializeSession } from "../serializers";
import { sendEmail } from "./mail";
import { primaryEmail, touchUser, type UserRow } from "./users";
import { emitEvent } from "./webhooks";

export interface CreateSessionInput {
  clientId: string;
  userId: string;
  actor?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  maxLifetimeSeconds?: number;
  firstFactor?: boolean;
  secondFactor?: boolean;
}

const emitSessionEvent = async (ctx: AppContext, type: "session.created" | "session.ended" | "session.removed" | "session.revoked" | "session.pending", row: typeof s.sessions.$inferSelect) => {
  await emitEvent(ctx, type === "session.pending" ? "session.created" : type, serializeSession(ctx, row, { withUser: true }));
};

/** Creates an active session (single-session mode ends the client's other sessions), updates user timestamps, emits `session.created`. */
export async function createSession(ctx: AppContext, input: CreateSessionInput): Promise<string> {
  const st = ctx.settings.get();
  const now = Date.now();
  if (!st.session.multiSession) {
    const others = ctx.db.select().from(s.sessions)
      .where(and(eq(s.sessions.clientId, input.clientId), eq(s.sessions.status, "active")))
      .all();
    for (const other of others) {
      ctx.db.update(s.sessions).set({ status: "ended", updatedAt: now }).where(eq(s.sessions.id, other.id)).run();
      await emitSessionEvent(ctx, "session.ended", { ...other, status: "ended", updatedAt: now });
    }
  }
  const lifetimeMs = Math.min(st.session.lifetimeSeconds, input.maxLifetimeSeconds ?? Number.POSITIVE_INFINITY) * 1000;
  const id = newId("sess");
  ctx.db.insert(s.sessions).values({
    id,
    clientId: input.clientId,
    userId: input.userId,
    status: "active",
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
  }).run();
  ctx.db.update(s.clients).set({ lastActiveSessionId: id, updatedAt: now }).where(eq(s.clients.id, input.clientId)).run();
  touchUser(ctx, input.userId, { lastSignInAt: now, lastActiveAt: now });
  const row = ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)).get()!;
  await emitSessionEvent(ctx, "session.created", row);
  return id;
}

/** Email notification for a new device/sign-in. Optional (called by sign-in flows when notifications are desired). */
export async function sendNewSignInEmail(ctx: AppContext, user: UserRow, session: typeof s.sessions.$inferSelect, when = Date.now()) {
  const email = primaryEmail(ctx, user);
  if (!email) return;
  // Only notify for genuinely new devices (Clerk's "new sign-in" notification).
  const knownDevice = ctx.db.select().from(s.sessions)
    .where(eq(s.sessions.userId, user.id))
    .all()
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
  const rows = ctx.db.select().from(s.sessions).where(and(eq(s.sessions.userId, userId), eq(s.sessions.status, "active"))).all();
  const now = Date.now();
  for (const row of rows) {
    if (exceptSessionId && row.id === exceptSessionId) continue;
    ctx.db.update(s.sessions).set({ status, updatedAt: now }).where(eq(s.sessions.id, row.id)).run();
    const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
    await emitSessionEvent(ctx, type, { ...row, status, updatedAt: now });
  }
}

export const getSession = (ctx: AppContext, id: string) => ctx.db.select().from(s.sessions).where(eq(s.sessions.id, id)).get();

export function isSessionExpired(ctx: AppContext, row: typeof s.sessions.$inferSelect): boolean {
  if (row.status !== "active" && row.status !== "pending") return false;
  const now = Date.now();
  if (row.expireAt <= now) return true;
  const inactivityMs = ctx.settings.get().session.inactivityTimeoutSeconds * 1000;
  return inactivityMs > 0 && now - row.lastActiveAt > inactivityMs;
}

/** Applies expiry/inactivity to the DB row and returns the effective status. */
export function evaluateSessionStatus(ctx: AppContext, row: typeof s.sessions.$inferSelect): SessionStatus {
  if (isSessionExpired(ctx, row)) {
    if (row.status !== "expired") {
      ctx.db.update(s.sessions).set({ status: "expired", updatedAt: Date.now() }).where(eq(s.sessions.id, row.id)).run();
    }
    return "expired";
  }
  return row.status as SessionStatus;
}

/** Loads a session that belongs to `clientId` and is usable; throws otherwise. */
export function requireSession(ctx: AppContext, clientId: string, sessionId: string) {
  const row = getSession(ctx, sessionId);
  if (!row || row.clientId !== clientId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Session not found");
  const status = evaluateSessionStatus(ctx, row);
  if (status !== "active" && status !== "pending") {
    throw new OrbitError(401, ErrorCodes.authentication_invalid, `This session is ${status}`, { session_id: row.id });
  }
  return { ...row, status };
}

export async function endSession(ctx: AppContext, row: typeof s.sessions.$inferSelect, status: "ended" | "removed" | "revoked" = "ended") {
  ctx.db.update(s.sessions).set({ status, updatedAt: Date.now() }).where(eq(s.sessions.id, row.id)).run();
  const client = ctx.db.select().from(s.clients).where(eq(s.clients.id, row.clientId)).get();
  if (client?.lastActiveSessionId === row.id) {
    const next = ctx.db.select().from(s.sessions)
      .where(and(eq(s.sessions.clientId, row.clientId), eq(s.sessions.status, "active"), ne(s.sessions.id, row.id)))
      .get();
    ctx.db.update(s.clients).set({ lastActiveSessionId: next?.id ?? null, updatedAt: Date.now() }).where(eq(s.clients.id, row.clientId)).run();
  }
  const type = status === "revoked" ? "session.revoked" : status === "removed" ? "session.removed" : "session.ended";
  await emitSessionEvent(ctx, type, { ...row, status });
  return getSession(ctx, row.id)!;
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
      const membership = ctx.db.select().from(s.organizationMemberships)
        .where(and(eq(s.organizationMemberships.organizationId, opts.organizationId), eq(s.organizationMemberships.userId, row.userId)))
        .get();
      if (!membership) throw new OrbitError(403, ErrorCodes.not_a_member_in_organization, "You are not a member of this organization");
      patch.lastActiveOrganizationId = opts.organizationId;
    }
  }
  ctx.db.update(s.sessions).set(patch).where(eq(s.sessions.id, row.id)).run();
  touchUser(ctx, row.userId, { lastActiveAt: now });
  return getSession(ctx, row.id)!;
}

/** Marks a reverification as done on the session. Level `first_factor` also refreshes the second factor age (Clerk semantics). */
export function markSessionReverified(ctx: AppContext, sessionId: string, level: "first_factor" | "second_factor" | "multi_factor") {
  const now = Date.now();
  const patch: Partial<typeof s.sessions.$inferInsert> = { updatedAt: now };
  if (level === "first_factor" || level === "multi_factor") patch.firstFactorVerifiedAt = now;
  if (level === "second_factor" || level === "multi_factor") patch.secondFactorVerifiedAt = now;
  ctx.db.update(s.sessions).set(patch).where(eq(s.sessions.id, sessionId)).run();
  return getSession(ctx, sessionId)!;
}
