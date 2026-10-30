import type { BackendHttp } from "../http";
import type { PaginatedResult } from "../types";
import type { Metadata } from "@orbitid/shared";

/** Query values the Backend API accepts on list endpoints. `undefined`/`null` entries are dropped by `BackendHttp`. */
export type ListQuery = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

export interface UpdateMetadataParams {
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
}

/**
 * Unwraps both Backend API list shapes: `{ data, totalCount }` and a bare array. A missing `data` array is treated as
 * empty rather than invalid, so a successful-but-empty response never becomes `undefined` in resource lists.
 */
export async function list<T>(http: BackendHttp, path: string, query: ListQuery = {}): Promise<PaginatedResult<T>> {
  const raw = await http.get<{ data?: T[]; totalCount?: number } | T[]>(path, { query });
  if (Array.isArray(raw)) return { data: raw, totalCount: raw.length };
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return { data, totalCount: raw?.totalCount ?? data.length };
}
