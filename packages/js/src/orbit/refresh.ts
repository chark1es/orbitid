import { isOrbitAPIResponseError } from "../util/errors";
import type { Session } from "../resources/session";

/**
 * Token refresh loop, deliberately separated from the `OrbitID` class.
 *
 * Rule: a session is never signed out by a failure. The schedule comes from the token's own `exp`, the loop
 * re-arms on resume/online, one tab mints at a time, and only a 401/403 that the authoritative client state
 * confirms clears anything. Everything in this file exists to keep a signed-in browser signed in.
 */
export interface TokenRefreshHost {
  /** `load()` finished and the instance is not disposed: safe to hold a timer. */
  isReady(): boolean;
  isDisposed(): boolean;
  /** Explicit refresh cadence (`OrbitIDOptions.tokenRefreshIntervalMs`), or undefined to use the JWT `exp`. */
  intervalMs(): number | undefined;
  /** Local-clock expiry of the cached default token, or null when there is none. */
  tokenExpiry(sessionId: string): number | null;
  /** Lifetime of the last token for this session (exp - iat), used as a ceiling for a schedule. */
  tokenLifetimeMs(sessionId: string): number | null;
  /** True when this tab already holds a fresh token for the session (its own mint, a broadcast, or the cookie). */
  cacheIsFresh(sessionId: string): boolean;
  session(): Session | null;
  /** True when `session` is still this tab's current, usable session (active or pending MFA). */
  isCurrentLiveSession(session: Session): boolean;
  /** Cross-tab lock; true when this tab may mint (or when there is no storage to coordinate). */
  acquireLock(): boolean;
  releaseLock(): void;
  fetchToken(session: Session): Promise<string>;
  acceptToken(session: Session, token: string): void;
  /** Confirm an authoritative rejection. Resolves true once the session is gone and state was cleared. */
  reconcileRejected(session: Session): Promise<boolean>;
}

/** A 401/403 is the server saying the session is gone; everything else is transient. */
export function isAuthoritativeSessionEnd(error: unknown): boolean {
  return isOrbitAPIResponseError(error) && (error.status === 401 || error.status === 403);
}

/** Transient failure back-off: 5 s, 10 s, 20 s, 40 s, then a minute. Never a sign-out. */
function retryDelayMs(failures: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, failures - 1), 60_000);
}

/**
 * A configured cadence below this is never worth following: the browser would mint a token continuously
 * and the network would be the bottleneck. The dashboard also refuses to save such a value.
 */
const MIN_REFRESH_INTERVAL_MS = 5_000;
/** Ceiling for a schedule when the token carries no usable lifetime. */
const FALLBACK_MAX_DELAY_MS = 60_000;
/** How far the wall clock may drift from the monotonic reference before a schedule is recomputed. */
const CLOCK_DRIFT_TOLERANCE_MS = 5_000;

/** `Retry-After` from a 429/503, when the transport captured it. */
function retryAfterMs(error: unknown): number {
  if (!isOrbitAPIResponseError(error)) return 0;
  if (error.status !== 429 && error.status !== 503) return 0;
  return error.retryAfterMs ?? 0;
}

export class TokenRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lifecycleBound = false;
  private onVisibility: (() => void) | null = null;
  private onOnline: (() => void) | null = null;
  /** Wall-clock instant of the last schedule, and the same instant on a monotonic clock. */
  private scheduledWallAt: number | null = null;
  private scheduledMonoAt: number | null = null;
  /** Set after a detected backward clock jump, so the freshness check cannot keep a stale-looking token. */
  private forceNextRefresh = false;

  constructor(private readonly host: TokenRefreshHost) {}

  start(): void {
    this.bindLifecycle();
    if (!this.timer) this.schedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduledWallAt = null;
    this.scheduledMonoAt = null;
    this.unbindLifecycle();
  }

  /** Reset the backoff (after a sign-in, a session switch or a successful sync). */
  reset(): void {
    this.failures = 0;
  }

  /**
   * Schedule the next refresh from the token's own expiry (or the explicit cadence). A fixed interval drifts
   * when a background tab is throttled or a laptop sleeps; a deadline recomputed after every token does not.
   */
  schedule(delayMs = this.nextDelayMs()): void {
    if (!this.host.isReady() || this.host.isDisposed()) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(1_000, Math.min(delayMs, this.maxDelayMs()));
    this.scheduledWallAt = Date.now();
    this.scheduledMonoAt = this.mono();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refreshNow();
    }, delay);
  }

  async refreshNow(): Promise<void> {
    const session = this.host.session();
    // A pending-MFA session is live: minting its (still `sts: "pending"`) token keeps the browser proof fresh
    // during a long enrolment instead of letting it expire into a handshake.
    if (!session || (session.status !== "active" && session.status !== "pending")) {
      this.stop();
      return;
    }
    // Another tab already put a fresh token where this tab can see it (a broadcast, or the shared
    // `__session` cookie adopted into the cache). Minting again would be one redundant request per tab
    // per cycle; re-arm from that token's own exp instead. A detected clock jump skips this check: the
    // wall clock no longer tells us whether the token is really fresh.
    if (!this.forceNextRefresh && this.host.cacheIsFresh(session.id)) {
      this.failures = 0;
      this.schedule();
      return;
    }
    this.forceNextRefresh = false;
    // Several tabs share one `__client` cookie. One tab mints; the rest wait briefly for the result.
    if (!this.host.acquireLock()) {
      this.schedule(Math.min(this.nextDelayMs(), 5_000));
      return;
    }
    try {
      const token = await this.host.fetchToken(session);
      // A response that lands after sign-out or a session switch must not bring the old session back.
      // The loop still has to keep running for whatever session is current now, so re-arm before leaving.
      if (!this.host.isCurrentLiveSession(session)) {
        this.schedule();
        return;
      }
      this.failures = 0;
      this.host.acceptToken(session, token);
      this.schedule();
    } catch (error) {
      if (isAuthoritativeSessionEnd(error) && this.host.isCurrentLiveSession(session)) {
        if (await this.host.reconcileRejected(session)) return;
      }
      this.failures += 1;
      // A 429 is the server asking for a specific pause: honour it, and never treat it as a sign-out.
      const retryAfter = retryAfterMs(error);
      this.schedule(Math.max(retryAfter, retryDelayMs(this.failures)));
    } finally {
      this.host.releaseLock();
    }
  }

  /** Wake-ups that a suspended or offline tab cannot get from a timer alone. */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof document === "undefined" || typeof window === "undefined") return;
    this.lifecycleBound = true;
    this.onVisibility = () => {
      if (document.visibilityState === "visible") this.onResume();
    };
    this.onOnline = () => this.onResume();
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("focus", this.onOnline);
  }

  private unbindLifecycle(): void {
    if (!this.lifecycleBound) return;
    this.lifecycleBound = false;
    if (this.onVisibility) document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.onOnline) {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("focus", this.onOnline);
    }
    this.onVisibility = null;
    this.onOnline = null;
  }

  private onResume(): void {
    if (this.host.isDisposed()) return;
    const session = this.host.session();
    if (!session || (session.status !== "active" && session.status !== "pending")) return;
    // A backward wall-clock jump (NTP, DST) makes an expired token look fresh for hours. Mint once now
    // and re-arm from the new token instead of trusting the local deadline.
    if (this.clockJumpedBackwards()) {
      this.forceNextRefresh = true;
      this.reset();
      void this.refreshNow();
      return;
    }
    if (!this.host.cacheIsFresh(session.id)) {
      this.reset();
      void this.refreshNow();
      return;
    }
    // Recompute on every wake-up: a laptop that slept must not wait for a throttled timer.
    this.schedule(this.nextDelayMs());
  }

  /** Compares the wall clock with the monotonic reference taken when the timer was planned. */
  private clockJumpedBackwards(): boolean {
    if (this.scheduledWallAt === null || this.scheduledMonoAt === null) return false;
    const expectedWall = this.scheduledWallAt + (this.mono() - this.scheduledMonoAt);
    return expectedWall - Date.now() > CLOCK_DRIFT_TOLERANCE_MS;
  }

  private nextDelayMs(): number {
    const explicit = this.host.intervalMs();
    if (explicit !== undefined) return Math.max(MIN_REFRESH_INTERVAL_MS, explicit);
    const session = this.host.session();
    const expiresAt = session ? this.host.tokenExpiry(session.id) : null;
    if (!expiresAt) return 50_000;
    // TokenCache stores the expiry on the local clock (server skew cancelled) and applies the same 10 s leeway.
    // A short-lived token stays on the same 5 s floor as a configured cadence: two refreshes in one second
    // would hammer the instance and defeat the one-mint-per-cycle rule.
    return Math.max(MIN_REFRESH_INTERVAL_MS, expiresAt - Date.now() - 10_000);
  }

  /** Never hold a timer past one token's lifetime, even if the wall clock moved backwards. */
  private maxDelayMs(): number {
    const session = this.host.session();
    const lifetime = session ? this.host.tokenLifetimeMs(session.id) : null;
    return lifetime && lifetime > 0 ? Math.max(1_000, lifetime) : FALLBACK_MAX_DELAY_MS;
  }

  /** Monotonic time where available; `Date.now` is the fallback for old runtimes and SSR. */
  private mono(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }
}
