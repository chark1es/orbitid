/** Opportunistic eviction keeps inactive SDK instances and old pages from being retained indefinitely. */
export function trimCache<K, V extends { at: number }>(cache: Map<K, V>, ttl: number, max = 200): void {
  const cutoff = Date.now() - ttl;
  for (const [key, entry] of cache) {
    if (entry.at < cutoff) cache.delete(key);
  }
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
