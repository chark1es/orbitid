export interface DailyCount {
  date: string;
  count: number;
}

/** Mirrors `InstanceStatsJSON` from the server's `services/stats.ts` (`GET /v1/stats`). */
export interface InstanceStatsJSON {
  users_total: number;
  users_active_7d: number;
  sessions_active: number;
  organizations_total: number;
  signups_by_day: DailyCount[];
  signins_by_day: DailyCount[];
  banned_users: number;
  locked_users: number;
  mfa_enabled_users: number;
  top_social_providers: { provider: string; count: number }[];
}

export interface ListResponse<T> {
  data: T[];
  total_count: number;
}

/**
 * Backend lists are `{data,total_count}`; a few relationship endpoints return a bare array or
 * `{response:[…]}`. Normalise all three so pages never crash on a shape difference.
 */
export function asList<T>(value: unknown): ListResponse<T> {
  if (Array.isArray(value)) return { data: value as T[], total_count: value.length };
  if (value && typeof value === "object") {
    if ("data" in value && Array.isArray(value.data)) {
      const total = "total_count" in value && typeof value.total_count === "number" ? value.total_count : value.data.length;
      return { data: value.data as T[], total_count: total };
    }
    if ("response" in value && Array.isArray(value.response)) {
      return { data: value.response as T[], total_count: value.response.length };
    }
  }
  return { data: [], total_count: 0 };
}
