/**
 * In-flight de-duplication and a short-lived response cache for the list endpoints the
 * organization components read.
 *
 * Keys name the resource and the user (or organization) it belongs to, e.g.
 * `user:user_1:organization_memberships:100:0`. Two hooks that resolve the same key while a
 * request is in flight share one request; a mount within {@link FRESH_MS} reuses the response
 * instead of issuing the same GET again. `force` skips both, which is what `revalidate()` uses.
 */

/** A response younger than this is served from cache without a new request. */
export const FRESH_MS = 5_000;

interface Entry {
  value: unknown;
  at: number;
  promise: Promise<unknown> | null;
}

const entries = new Map<string, Entry>();

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/**
 * Stable numeric id for a resource instance. Cache keys include it so a new SDK resource
 * (a refreshed user, a different test fixture) never reads another instance's response.
 */
export function resourceIdentity(resource: object): number {
  const existing = identities.get(resource);
  if (existing !== undefined) return existing;
  nextIdentity += 1;
  identities.set(resource, nextIdentity);
  return nextIdentity;
}

export interface CachedRequestOptions {
  /** Ignore the cached value and any in-flight request; the new response replaces both. */
  force?: boolean;
}

/** Load `key` once: shares in-flight requests, then serves the response for {@link FRESH_MS}. */
export function cachedRequest<T>(
  key: string,
  load: () => Promise<T>,
  options: CachedRequestOptions = {},
): Promise<T> {
  const existing = entries.get(key);
  if (!options.force) {
    if (existing?.promise) return existing.promise as Promise<T>;
    if (existing && Date.now() - existing.at < FRESH_MS) return Promise.resolve(existing.value as T);
  }

  const promise = load().then(
    (value) => {
      if (entries.get(key)?.promise === promise) {
        entries.set(key, { value, at: Date.now(), promise: null });
      }
      return value;
    },
    (error: unknown) => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    },
  );
  entries.set(key, { value: existing?.value, at: existing?.at ?? 0, promise });
  return promise;
}

/** Drop every entry whose key starts with `prefix` (the resource, across pages and params). */
export function invalidateRequest(prefix: string): void {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}
