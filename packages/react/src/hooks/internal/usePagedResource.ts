import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaginatedResult, PaginationQuery } from "../../provider/types";

/** Paginated resource returned by `useOrganization()` / `useOrganizationList()`. */
export interface PagedResource<T> {
  data: T[];
  /** Total rows on the server. */
  count: number;
  /** 1-based current page. */
  page: number;
  pageCount: number;
  /** First load of the current view (no data yet). */
  isLoading: boolean;
  /** Any request in flight (including background revalidation). */
  isFetching: boolean;
  /** `isLoading` while on the initial page. */
  isInitialLoading: boolean;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  error: Error | null;
  fetchNext(): Promise<void>;
  fetchPrevious(): Promise<void>;
  /** Refetch the current page, bypassing the cache. */
  revalidate(): Promise<void>;
  setData(data: T[]): void;
}

export interface PagedFetchArgs extends PaginationQuery {
  limit: number;
  offset: number;
  page: number;
  /** `revalidate()` bypasses the shared request cache. */
  force?: boolean;
}

export interface UsePagedResourceOptions<T> {
  /** Resource identity (e.g. `org:org_123:memberships`); changing it resets pagination. */
  key: string;
  /** Fetches one page. Must be stable or closure-safe: only `args` is used. */
  fetcher: (args: PagedFetchArgs) => Promise<PaginatedResult<T>>;
  /** Extra query params — hashed into the cache key and part of the resource identity. */
  params?: Record<string, unknown>;
  pageSize?: number;
  initialPage?: number;
  /** Accumulate pages (infinite scroll) instead of replacing `data`. */
  infinite?: boolean;
  /** Keep the previous page visible while the next one loads. */
  keepPreviousData?: boolean;
  enabled?: boolean;
}

interface CacheEntry {
  data: unknown[];
  count: number;
  at: number;
}

interface PagedState<T> {
  page: number;
  data: T[];
  count: number;
  isFetching: boolean;
  error: Error | null;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

/** Drop every seeded page for `key`, so a remount after a mutation cannot show old rows. */
function invalidatePages(key: string): void {
  for (const cacheKey of [...cache.keys()]) {
    if (cacheKey === key || cacheKey.startsWith(`${key}|`)) cache.delete(cacheKey);
  }
}

function serializeParams(params?: Record<string, unknown>): string {
  if (!params) return "";
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Tiny SWR-like pagination hook (no dependencies): caches each page for 5 minutes, seeds the
 * first paint from cache, always revalidates on mount, and ignores stale responses.
 */
export function usePagedResource<T>(options: UsePagedResourceOptions<T>): PagedResource<T> {
  const {
    key,
    fetcher,
    params,
    pageSize = 10,
    initialPage = 1,
    infinite = false,
    keepPreviousData = false,
    enabled = true,
  } = options;

  const paramsKey = useMemo(() => serializeParams(params), [params]);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const cacheKeyFor = useCallback((page: number) => `${key}|p${page}|${paramsKey}`, [key, paramsKey]);

  const [state, setState] = useState<PagedState<T>>({
    page: initialPage,
    data: [],
    count: 0,
    isFetching: enabled,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestIdRef = useRef(0);
  const pagesRef = useRef(new Map<number, T[]>());

  const load = useCallback(
    async (targetPage: number, mode: "initial" | "next" | "previous" | "revalidate") => {
      if (!enabled) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      const seed = mode === "revalidate" ? undefined : cache.get(cacheKeyFor(targetPage));
      const freshSeed = seed && Date.now() - seed.at < CACHE_TTL_MS ? seed : undefined;
      setState((previous) => ({
        page: targetPage,
        data:
          freshSeed !== undefined
            ? (freshSeed.data as T[]) // cache holds pages fetched for this key
            : keepPreviousData || infinite
              ? previous.data
              : [],
        count: freshSeed?.count ?? previous.count,
        isFetching: true,
        error: null,
      }));

      const offset = (targetPage - 1) * pageSize;
      try {
        const result = await fetcherRef.current({
          limit: pageSize,
          offset,
          page: targetPage,
          ...(mode === "revalidate" ? { force: true } : {}),
        });
        if (requestIdRef.current !== requestId) return;
        cache.set(cacheKeyFor(targetPage), { data: result.data, count: result.totalCount, at: Date.now() });

        if (infinite) {
          pagesRef.current.set(targetPage, result.data);
          for (const cachedPage of [...pagesRef.current.keys()]) {
            if (cachedPage > targetPage) pagesRef.current.delete(cachedPage);
          }
        }

        setState(() => {
          if (!infinite) {
            return { page: targetPage, data: result.data, count: result.totalCount, isFetching: false, error: null };
          }
          const merged: T[] = [];
          for (let page = 1; page <= targetPage; page++) merged.push(...(pagesRef.current.get(page) ?? []));
          return { page: targetPage, data: merged, count: result.totalCount, isFetching: false, error: null };
        });
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setState((previous) => ({
          ...previous,
          page: targetPage,
          isFetching: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    },
    [enabled, cacheKeyFor, pageSize, infinite, keepPreviousData],
  );

  useEffect(() => {
    pagesRef.current = new Map();
    requestIdRef.current += 1;
    if (!enabled) {
      setState({ page: initialPage, data: [], count: 0, isFetching: false, error: null });
      return;
    }
    const seed = cache.get(cacheKeyFor(initialPage));
    const freshSeed = seed && Date.now() - seed.at < CACHE_TTL_MS ? seed : undefined;
    setState({
      page: initialPage,
      data: freshSeed !== undefined ? (freshSeed.data as T[]) : [],
      count: freshSeed?.count ?? 0,
      isFetching: true,
      error: null,
    });
    void load(initialPage, "initial");
  }, [cacheKeyFor, initialPage, enabled, load]);

  const pageCount = state.count > 0 ? Math.ceil(state.count / pageSize) : 0;
  const isLoading = state.isFetching && state.data.length === 0;

  const fetchNext = useCallback(async () => {
    const current = stateRef.current;
    const pages = current.count > 0 ? Math.ceil(current.count / pageSize) : 0;
    if (pages === 0 || current.page >= pages) return;
    await load(current.page + 1, "next");
  }, [load, pageSize]);

  const fetchPrevious = useCallback(async () => {
    const current = stateRef.current;
    if (current.page <= 1) return;
    await load(current.page - 1, "previous");
  }, [load]);

  const revalidate = useCallback(async () => {
    invalidatePages(key);
    await load(stateRef.current.page, "revalidate");
  }, [key, load]);

  const setData = useCallback((data: T[]) => {
    setState((previous) => ({ ...previous, data }));
  }, []);

  return useMemo(
    () => ({
      data: state.data,
      count: state.count,
      page: state.page,
      pageCount,
      isLoading,
      isFetching: state.isFetching,
      isInitialLoading: isLoading && state.page === initialPage,
      hasNextPage: pageCount > 0 && state.page < pageCount,
      hasPreviousPage: state.page > 1,
      error: state.error,
      fetchNext,
      fetchPrevious,
      revalidate,
      setData,
    }),
    [state, pageCount, isLoading, initialPage, fetchNext, fetchPrevious, revalidate, setData],
  );
}
