import type { PaginationQuery } from "../../provider/types";

export interface UseOrganizationPaginationOptions extends PaginationQuery {
  pageSize?: number;
  initialPage?: number;
  /** Accumulate pages for infinite scroll. */
  infinite?: boolean;
  keepPreviousData?: boolean;
}

/** `true`/`undefined` → defaults, `false` → disabled, object → custom pagination. */
export type UseOrganizationParam = boolean | UseOrganizationPaginationOptions;

export interface ResolvedPageOptions {
  enabled: boolean;
  pageSize: number;
  initialPage: number;
  infinite: boolean;
  keepPreviousData: boolean;
  role?: string;
  query?: string;
}

export function resolvePageOptions(
  value: UseOrganizationParam | undefined,
  defaults: { enabled: boolean; pageSize: number },
): ResolvedPageOptions {
  if (value === false) {
    return { enabled: false, pageSize: defaults.pageSize, initialPage: 1, infinite: false, keepPreviousData: false };
  }
  if (value === true || value === undefined) {
    return {
      enabled: defaults.enabled,
      pageSize: defaults.pageSize,
      initialPage: 1,
      infinite: false,
      keepPreviousData: false,
    };
  }
  return {
    enabled: defaults.enabled,
    pageSize: value.pageSize ?? defaults.pageSize,
    initialPage: value.initialPage ?? 1,
    infinite: value.infinite ?? false,
    keepPreviousData: value.keepPreviousData ?? false,
    role: value.role,
    query: value.query,
  };
}
