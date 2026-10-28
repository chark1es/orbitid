import { isRecord } from "./object";

export interface PaginationParams {
  limit?: number;
  offset?: number;
  page?: number;
  orderBy?: string;
  query?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  totalCount: number;
  count: number;
}

export type QueryValue = string | number | boolean | undefined | null | Array<string | number>;
export type QueryParams = Record<string, QueryValue>;

export function toQueryString(params: QueryParams = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const queryKey = key.endsWith("[]") ? key : `${key}[]`;
      for (const item of value) search.append(queryKey, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function paginationQuery(params: PaginationParams = {}): QueryParams {
  return { limit: params.limit, offset: params.offset, order_by: params.orderBy, query: params.query };
}

export function toPaginatedResponse<T>(raw: unknown, mapper: (item: unknown) => T): PaginatedResponse<T> {
  if (Array.isArray(raw)) {
    const data = raw.map(mapper);
    return { data, totalCount: data.length, count: data.length };
  }
  if (isRecord(raw)) {
    const record = raw;
    const list = Array.isArray(record.data) ? record.data : [];
    const data = list.map(mapper);
    const total = typeof record.total_count === "number" ? record.total_count : data.length;
    return { data, totalCount: total, count: data.length };
  }
  return { data: [], totalCount: 0, count: 0 };
}

/** Parses a list endpoint response: `{ response: { data, total_count } }`, `{ response: [...] }` or a bare array. */
export function toList<T>(raw: unknown, mapper: (item: unknown) => T): T[] {
  if (Array.isArray(raw)) return raw.map(mapper);
  if (isRecord(raw)) {
    const record = raw;
    if (Array.isArray(record.data)) return record.data.map(mapper);
  }
  return [];
}
