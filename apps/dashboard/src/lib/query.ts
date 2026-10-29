export interface UsersQuery {
  page: number;
  limit: number;
  query?: string;
  orderBy?: string;
  banned?: boolean;
  locked?: boolean;
  mfa?: boolean;
  /** `true` lists guest accounts only, `false` registered accounts only. */
  isAnonymous?: boolean;
  createdAfter?: number;
  createdBefore?: number;
}

export interface ListPathOptions {
  limit: number;
  offset?: number;
  page?: number;
  query?: string;
  orderBy?: string;
  extra?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Builds a Backend API list URL. Only non-empty values are serialised so that URL query state,
 * query keys and server responses stay in lockstep.
 */
export function buildListPath(base: string, options: ListPathOptions): string {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit));
  const offset = options.offset ?? Math.max(0, ((options.page ?? 1) - 1) * options.limit);
  params.set("offset", String(offset));
  if (options.orderBy) params.set("order_by", options.orderBy);
  if (options.query) params.set("query", options.query);
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  return `${base}?${params.toString()}`;
}

export function usersListPath(input: UsersQuery): string {
  return buildListPath("/users", {
    limit: input.limit,
    page: input.page,
    query: input.query,
    orderBy: input.orderBy,
    extra: {
      paginated: true,
      banned: input.banned,
      locked: input.locked,
      mfa: input.mfa,
      // Sent as a string because `buildListPath` drops `false` as "no filter".
      is_anonymous: input.isAnonymous === undefined ? undefined : String(input.isAnonymous),
      created_at_after: input.createdAfter,
      created_at_before: input.createdBefore,
    },
  });
}

/** `1`-based page from a query string value, clamped to >= 1. */
export function pageFromParam(value: string | null, fallback = 1): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function limitFromParam(value: string | null, fallback = 20): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? Math.floor(parsed) : fallback;
}
