import { tokenExpiresAt } from "./util/jwt";

export interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface TokenCacheOptions {
  /** Refresh this long before expiry (default 10 s). */
  refreshLeewayMs?: number;
  now?: () => number;
  /** Fired whenever a freshly fetched token is cached (used for cookies + cross-tab sync). */
  onToken?: (info: { sessionId: string; template: string | null; token: string; expiresAt: number }) => void;
}

const cacheKey = (sessionId: string, template: string | null) => `${sessionId}::${template ?? ""}`;

/**
 * In-memory session-token cache keyed by `sessionId + template`.
 * Concurrent callers share one in-flight request; tokens are refreshed before expiry.
 */
export class TokenCache {
  private readonly entries = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly leewayMs: number;
  private readonly now: () => number;
  private onToken?: TokenCacheOptions["onToken"];

  constructor(options: TokenCacheOptions = {}) {
    this.leewayMs = options.refreshLeewayMs ?? 10_000;
    this.now = options.now ?? (() => Date.now());
    this.onToken = options.onToken;
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

  set(sessionId: string, template: string | null, token: string): CachedToken {
    const expiresAt = tokenExpiresAt(token, this.now()) ?? this.now();
    const entry = { token, expiresAt };
    this.entries.set(cacheKey(sessionId, template), entry);
    this.onToken?.({ sessionId, template, token, expiresAt });
    return entry;
  }

  /** Stores a token received from another tab (no re-broadcast). */
  setFromSync(sessionId: string, template: string | null, token: string): void {
    const expiresAt = tokenExpiresAt(token, this.now()) ?? this.now();
    this.entries.set(cacheKey(sessionId, template), { token, expiresAt });
  }

  removeSession(sessionId: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${sessionId}::`)) this.entries.delete(key);
    for (const key of [...this.inflight.keys()]) if (key.startsWith(`${sessionId}::`)) this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
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
    const request = fetcher()
      .then((token) => {
        this.set(sessionId, template, token);
        return token;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }
}
