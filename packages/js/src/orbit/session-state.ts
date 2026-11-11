import type { Session } from "../resources/session";

/**
 * True when `candidate` is still this tab's current session.
 *
 * Objects are rebuilt from every client envelope (`applyClient`), so identity is the wrong test: a refresh-client
 * broadcast or a fapi response would otherwise make a live refresh look stale. `allowPending` distinguishes the
 * cookie-sync path (a pending-MFA session is live and keeps its cookies) from the token-refresh loop (only an
 * active session mints tokens).
 */
export function isCurrentSession(current: Session | null, candidate: Session, allowPending: boolean): boolean {
  if (!current || current.id !== candidate.id) return false;
  return current.status === "active" || (allowPending && current.status === "pending");
}
