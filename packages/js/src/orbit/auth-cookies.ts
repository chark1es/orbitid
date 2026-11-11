import { COOKIES } from "@orbitid/shared";
import type { Client } from "../resources/client";
import type { Session } from "../resources/session";
import type { TokenCache } from "../token-cache";
import { CrossTabSync, type SyncMessage } from "../cross-tab-sync";
import { getCookie, clearAuthCookies, setClientUatCookie, setSessionCookie, type CookieOptions } from "../util/cookies";
import { decodeJwtPayload } from "../util/jwt";
import { isAuthoritativeSessionEnd } from "./refresh";

/**
 * Owns the browser-visible auth cookies (`__session`, `__client_uat`) and the cross-tab channel.
 *
 * Both cookies are long-lived and rewritten on every token, so a hard navigation never arrives without the
 * proof the middleware needs. Token broadcasts are the only cross-tab credential transfer; the storage
 * fallback carries signals only.
 */
export interface AuthCookieHost {
  isDisposed(): boolean;
  isInBrowser(): boolean;
  session(): Session | null;
  /** True when `session` is still this tab's current session and is usable (active *or* pending MFA). */
  isCurrentLiveSession(session: Session): boolean;
  tokenCache(): TokenCache;
  cookieOptions(): CookieOptions;
  crossTab(): CrossTabSync | null;
  setCrossTab(sync: CrossTabSync): void;
  refreshClient(): Promise<Client | null>;
  reconcileRejected(session: Session): Promise<boolean>;
  scheduleRefresh(): void;
  emit(): void;
}

export class AuthCookies {
  constructor(private readonly host: AuthCookieHost) {}

  /** Called whenever the token cache stores a freshly minted token. */
  handleToken(info: { sessionId: string; template: string | null; token: string; expiresAt: number }): void {
    // A token fetch can resolve after `dispose()`; it must not write cookies or broadcast from a dead instance.
    if (this.host.isDisposed()) return;
    const session = this.host.session();
    if (session?.id !== info.sessionId) return;
    if (!info.template) setSessionCookie(info.token, this.host.cookieOptions());
    this.writeClientUat();
    // Template tokens are least-privilege credentials for another service; a tab that wants one can mint
    // its own. Only the default session token — the one every tab of this app already holds — is shared.
    if (!info.template) {
      this.host.crossTab()?.broadcast({ type: "token", sessionId: info.sessionId, template: null, token: info.token });
    }
  }

  writeClientUat(): void {
    const session = this.host.session();
    const seconds = session?.lastActiveAt ? Math.floor(session.lastActiveAt / 1000) : Math.floor(Date.now() / 1000);
    setClientUatCookie(session ? seconds : 0, this.host.cookieOptions());
  }

  /**
   * Takes a fresher `__session` token written by another tab into this tab's cache. Tabs share the
   * cookie, so this is the fallback path that keeps the refresh loop at one mint per cycle when
   * `BroadcastChannel` is unavailable. A stale or foreign token is ignored.
   */
  adoptSharedToken(sessionId: string): boolean {
    if (this.host.isDisposed()) return false;
    const token = getCookie(COOKIES.session);
    if (!token) return false;
    const payload = decodeJwtPayload(token);
    if (!payload || payload.sid !== sessionId || typeof payload.exp !== "number") return false;
    // The cookie is same-origin writable, so `sid` alone is not enough: a token minted by another
    // instance must not be adopted, even when it names the same session id.
    if (!this.host.tokenCache().trustsIssuer(payload.iss)) return false;
    const cached = this.host.tokenCache().get(sessionId);
    if (cached && cached.expiresAt >= payload.exp * 1000) return false;
    return this.host.tokenCache().setFromSync(sessionId, null, token);
  }

  async sync(): Promise<void> {
    if (this.host.isDisposed()) return;
    const session = this.host.session();
    // A pending session (required MFA not enrolled yet) is live: its handshake/token cookies must survive exactly
    // like an active session's. Clearing them here undid the server and Next.js pending-handshake fix and dropped
    // the visitor out of the enrolment flow.
    const live = !!session && (session.status === "active" || session.status === "pending");
    if (!session || !live) {
      clearAuthCookies(this.host.cookieOptions());
      return;
    }
    // `__client_uat` first: middleware uses it to decide whether a handshake can refresh a missing
    // `__session`, so a token request that fails must not leave the browser looking signed out.
    this.writeClientUat();
    try {
      const token = await session.getToken();
      // The user may have signed out, switched session, or torn the instance down while the request was in flight.
      if (!this.host.isDisposed() && this.host.isCurrentLiveSession(session)) setSessionCookie(token, this.host.cookieOptions());
    } catch (error) {
      // A failed token fetch leaves the existing `__session` untouched (the next refresh retries); only an
      // explicit 401/403 is checked against the authoritative client state.
      if (this.host.isCurrentLiveSession(session) && isAuthoritativeSessionEnd(error)) {
        await this.host.reconcileRejected(session);
      }
    }
  }

  startCrossTab(): void {
    if (this.host.crossTab() || this.host.isDisposed() || !this.host.isInBrowser()) return;
    const sync = new CrossTabSync((message) => {
      if (this.host.isDisposed()) return;
      this.handleMessage(message);
    });
    this.host.setCrossTab(sync);
  }

  private handleMessage(message: SyncMessage): void {
    const session = this.host.session();
    switch (message.type) {
      case "token":
        if (!this.host.tokenCache().setFromSync(message.sessionId, message.template, message.token)) return;
        if (!message.template && session?.id === message.sessionId) setSessionCookie(message.token, this.host.cookieOptions());
        // Align this tab's deadline with the token another tab just minted instead of letting the old timer
        // fire a redundant refresh.
        this.host.scheduleRefresh();
        return;
      case "signout":
        this.host.tokenCache().clear();
        clearAuthCookies(this.host.cookieOptions());
        void this.host.refreshClient().catch(() => undefined);
        return;
      case "refresh-client":
        void this.host.refreshClient().catch(() => undefined);
        return;
    }
  }
}
