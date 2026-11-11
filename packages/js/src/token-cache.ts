import { decodeJwtPayload, tokenExpiresAt } from "./util/jwt";

export interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface TokenCacheOptions {
  /** Refresh this long before expiry (default 10 s). */
  refreshLeewayMs?: number;
  now?: () => number;
  /**
   * The Frontend API origin that issues this client's tokens. When known, a token synced from another tab
   * or adopted from the shared cookie must carry a matching `iss`, so a same-origin script cannot plant a
   * token minted by a different instance behind the same `sid`.
   */
  issuer?: string;
  /** Fired whenever a freshly fetched token is cached (used for cookies + cross-tab sync). */
  onToken?: (info: { sessionId: string; template: string | null; token: string; expiresAt: number }) => void;
}

const normalizeIssuer = (issuer: string) => issuer.trim().replace(/\/+$/, "").toLowerCase();

const cacheKey = (sessionId: string, template: string | null) => `${sessionId}::${template ?? ""}`;

/**
 * In-memory session-token cache keyed by `sessionId + template`.
 * Concurrent callers share one in-flight request; tokens are refreshed before expiry.
 */
export class TokenCache {
  private readonly entries = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  /** Incremented whenever a key is purged, so a request that resolves late cannot repopulate the cache. */
  private readonly generations = new Map<string, number>();
  private readonly leewayMs: number;
  private readonly issuer: string | null;
  private readonly now: () => number;
  private onToken?: TokenCacheOptions["onToken"];

  constructor(options: TokenCacheOptions = {}) {
    this.leewayMs = options.refreshLeewayMs ?? 10_000;
    this.issuer = options.issuer ? normalizeIssuer(options.issuer) : null;
    this.now = options.now ?? (() => Date.now());
    this.onToken = options.onToken;
  }

  /**
   * True when a token's `iss` may be adopted here. With no known issuer every issuer is accepted, which
   * preserves the previous behaviour for caches constructed without an OrbitID instance.
   */
  trustsIssuer(issuer: unknown): boolean {
    if (this.issuer === null) return true;
    return typeof issuer === "string" && normalizeIssuer(issuer) === this.issuer;
  }

  setOnToken(handler: TokenCacheOptions["onToken"]): void {
    this.onToken = handler;
  }

  get(sessionId: string, template: string | null = null): CachedToken | undefined {
    return this.entries.get(cacheKey(sessionId, template));
  }

  isFresh(sessionId: string, template: string | null = null): boolean {
    const entry = this.get(sessionId, template);
    return !!entry && entry.expiresAt - this.leewayMs > this.now();
  }

  /**
   * The lifetime the cached token was minted with (`exp - iat`), or null when it cannot be read. The
   * refresh loop uses it as a ceiling: a backward clock jump must not push the next schedule past one
   * token's lifetime.
   */
  lifetimeMs(sessionId: string, template: string | null = null): number | null {
    const entry = this.get(sessionId, template);
    if (!entry) return null;
    const payload = decodeJwtPayload(entry.token);
    if (!payload || typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    const lifetime = (payload.exp - payload.iat) * 1000;
    return lifetime > 0 ? lifetime : null;
  }

  set(sessionId: string, template: string | null, token: string): CachedToken {
    const expiresAt = tokenExpiresAt(token, this.now()) ?? this.now();
    const entry = { token, expiresAt };
    this.entries.set(cacheKey(sessionId, template), entry);
    this.onToken?.({ sessionId, template, token, expiresAt });
    return entry;
  }

  /** Stores a token received from another tab (no re-broadcast). */
  setFromSync(sessionId: string, template: string | null, token: string): boolean {
    if (!token) return false;
    const payload = decodeJwtPayload(token);
    // Another tab is same-origin but not necessarily trusted: a token for a different session, one
    // minted by another instance, or one that is already expired must not overwrite this tab's
    // cookie/authorization state.
    if (!payload || payload.sid !== sessionId || typeof payload.exp !== "number") return false;
    if (!this.trustsIssuer(payload.iss)) return false;
    // Tabs on one machine share a clock, so `exp` is compared directly here; the per-fetch skew estimate
    // `tokenExpiresAt` applies is only valid at the moment a token is minted for *this* client.
    if (payload.exp * 1000 <= this.now()) return false;
    this.entries.set(cacheKey(sessionId, template), { token, expiresAt: payload.exp * 1000 });
    return true;
  }

  removeSession(sessionId: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${sessionId}::`)) this.entries.delete(key);
    for (const key of [...this.inflight.keys()]) if (key.startsWith(`${sessionId}::`)) {
      this.inflight.delete(key);
      this.bumpGeneration(key);
    }
  }

  clear(): void {
    this.entries.clear();
    for (const key of this.inflight.keys()) this.bumpGeneration(key);
    this.inflight.clear();
  }

  /**
   * Invalidates a request that is still in flight. Without this, a token fetch that resolves after
   * `signOut()` would write the old session's token back into the cache (and could be handed to a later
   * caller), so a purge has to be able to cancel it logically.
   */
  private bumpGeneration(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  /**
   * Returns a cached token when still fresh, otherwise fetches (deduping concurrent calls).
   */
  async getToken(
    sessionId: string,
    template: string | null,
    fetcher: () => Promise<string>,
    options: { skipCache?: boolean } = {},
  ): Promise<string> {
    const key = cacheKey(sessionId, template);
    if (!options.skipCache && this.isFresh(sessionId, template)) return this.get(sessionId, template)!.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const generation = this.generations.get(key) ?? 0;
    const request = fetcher()
      .then((token) => {
        // The session was removed or the cache cleared while this request was in flight: do not resurrect it.
        if ((this.generations.get(key) ?? 0) !== generation) return token;
        this.set(sessionId, template, token);
        return token;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
        // The guarded write above (or its skip) has already happened, so a counter with no request left for
        // this key has done its job. Dropping it keeps the map from growing one entry per session ever purged.
        if (!this.inflight.has(key)) this.generations.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }
}
