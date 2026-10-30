import { trimCache } from "./trimCache";
import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncValue<T> {
  data: T | null;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  revalidate(): Promise<void>;
}

export interface AsyncFetchOptions {
  /** `revalidate()` bypasses the shared request cache. */
  force?: boolean;
}

export interface UseAsyncValueOptions<T> {
  /** Cache identity; changing it reloads. */
  key: string;
  fetcher: ((options: AsyncFetchOptions) => Promise<T | null>) | null;
  enabled?: boolean;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { data: unknown; at: number }>();

function readCache<T>(key: string): T | null {
  const entry = cache.get(key);
  return entry && Date.now() - entry.at < CACHE_TTL_MS ? ((entry.data as T | undefined) ?? null) : null;
}

/** Single-value sibling of `usePagedResource` (used for the active organization membership). */
export function useAsyncValue<T>(options: UseAsyncValueOptions<T>): AsyncValue<T> {
  const { key, fetcher, enabled = true } = options;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [state, setState] = useState<{ data: T | null; isFetching: boolean; error: Error | null }>(() => ({
    data: readCache<T>(key),
    isFetching: Boolean(enabled),
    error: null,
  }));
  const requestIdRef = useRef(0);

  const load = useCallback(async (force = false) => {
    const current = fetcherRef.current;
    if (!enabled || !current) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((previous) => ({ ...previous, isFetching: true, error: null }));
    try {
      const result = await current({ force });
      if (requestIdRef.current !== requestId) return;
      cache.set(key, { data: result, at: Date.now() });
      trimCache(cache, CACHE_TTL_MS);
      setState({ data: result, isFetching: false, error: null });
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setState((previous) => ({
        ...previous,
        isFetching: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, [enabled, key]);

  useEffect(() => {
    requestIdRef.current += 1;
    if (!enabled || !fetcherRef.current) {
      setState({ data: null, isFetching: false, error: null });
      return;
    }
    // Seed from the new key's cache so switching organizations/accounts never shows stale data.
    setState({ data: readCache<T>(key), isFetching: true, error: null });
    void load();
    return () => { requestIdRef.current += 1; };
  }, [enabled, key, load]);

  return {
    data: state.data,
    isLoading: state.isFetching && state.data === null,
    isFetching: state.isFetching,
    error: state.error,
    revalidate: () => load(true),
  };
}
