import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { limitFromParam, pageFromParam } from "./query";

export interface TableStateOptions {
  limit?: number;
  orderBy?: string;
  /** Extra query-string keys this table owns (filters). */
  filterKeys?: string[];
}

/**
 * URL-as-state for paginated tables: page, limit, search, sort and filters live in the query string so
 * links, reloads and the back button all preserve the view.
 */
export function useTableState(options: TableStateOptions = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultLimit = options.limit ?? 20;
  const defaultOrderBy = options.orderBy ?? "-created_at";

  const page = pageFromParam(searchParams.get("page"));
  const limit = limitFromParam(searchParams.get("limit"), defaultLimit);
  const query = searchParams.get("query") ?? "";
  const orderBy = searchParams.get("order_by") ?? defaultOrderBy;

  const apply = useCallback(
    (patch: Record<string, string | number | boolean | null | undefined>, opts: { keepPage?: boolean } = {}) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === "" || value === false) next.delete(key);
        else next.set(key, String(value));
      }
      if (!opts.keepPage) next.delete("page");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setPage = useCallback(
    (value: number) => apply({ page: value > 1 ? value : null }, { keepPage: true }),
    [apply],
  );
  const setLimit = useCallback((value: number) => apply({ limit: value === defaultLimit ? null : value }), [apply, defaultLimit]);
  const setQuery = useCallback((value: string) => apply({ query: value.trim() || null }), [apply]);
  const setFilter = useCallback((key: string, value: string | null) => apply({ [key]: value }), [apply]);

  const toggleSort = useCallback(
    (key: string) => {
      const current = orderBy.replace(/^-/, "");
      const ascending = orderBy.startsWith("-") === false;
      apply({ order_by: current === key && ascending ? `-${key}` : key });
    },
    [apply, orderBy],
  );

  const reset = useCallback(() => {
    const next = new URLSearchParams();
    if (limit !== defaultLimit) next.set("limit", String(limit));
    if (defaultOrderBy) next.set("order_by", defaultOrderBy);
    setSearchParams(next, { replace: true });
  }, [defaultOrderBy, defaultLimit, limit, setSearchParams]);

  const filter = useCallback((key: string) => searchParams.get(key) ?? "", [searchParams]);
  const filterKeys = options.filterKeys ?? [];
  const hasFilters = filterKeys.some((key) => !!filter(key)) || !!query;

  return {
    searchParams,
    page,
    limit,
    offset: (page - 1) * limit,
    query,
    orderBy,
    sortKey: orderBy.replace(/^-/, ""),
    sortDescending: orderBy.startsWith("-"),
    setPage,
    setLimit,
    setQuery,
    setFilter,
    toggleSort,
    reset,
    filter,
    hasFilters,
  };
}
