// OWNER: worker "core" (W1).
import type { AppContext } from "../context";

export interface CreateSessionInput { clientId: string; userId: string; actor?: Record<string, unknown>; ip?: string; userAgent?: string; maxLifetimeSeconds?: number; firstFactor?: boolean; secondFactor?: boolean }
/** Creates an active session (respects settings.session.multiSession: single-session mode ends other sessions of the client), updates user.lastSignInAt, emits session.created. Returns the sessions row id. */
export async function createSession(_ctx: AppContext, _input: CreateSessionInput): Promise<string> {
  throw new Error("not implemented (W1)");
}
export async function endSessionsForUser(_ctx: AppContext, _userId: string, _status: "revoked" | "removed" | "ended", _exceptSessionId?: string): Promise<void> {
  throw new Error("not implemented (W1)");
}
