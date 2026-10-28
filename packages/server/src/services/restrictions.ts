// OWNER: worker "admin" (W3). Sign-up gating (mode/allowlist/blocklist/waitlist/invitations) + tickets.
import type { AppContext } from "../context";

export interface IdentifiersToCheck { emails?: string[]; phones?: string[]; invitationTicket?: string | null }
/** Throws OrbitError (sign_up_restricted / identifier_not_allowed_access / sign_up_restricted_waitlist) when sign-up of these identifiers is not permitted. Also enforces blocklist at sign-IN (pass `signIn: true`). Returns { invitationId? }. */
export async function assertIdentifiersAllowed(_ctx: AppContext, _ids: IdentifiersToCheck, _opts: { signIn?: boolean } = {}): Promise<{ invitationId?: string }> {
  throw new Error("not implemented (W3)");
}
/** Validates + consumes sign_in_token / actor_token / app-invitation tickets (strategy "ticket"). Returns what the ticket grants. */
export async function redeemTicket(_ctx: AppContext, _ticket: string):
  Promise<{ kind: "sign_in_token" | "actor_token"; userId: string; actor?: Record<string, unknown>; sessionMaxDurationSeconds?: number } | { kind: "invitation"; invitationId: string; email: string; publicMetadata: Record<string, unknown> }> {
  throw new Error("not implemented (W3)");
}
/** Mark an invitation accepted & waitlist entry completed after a successful sign-up. */
export async function markInvitationAccepted(_ctx: AppContext, _invitationId: string, _userId: string): Promise<void> {}
