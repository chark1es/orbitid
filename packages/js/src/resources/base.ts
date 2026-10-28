import type { ClientJSON } from "@orbitid/shared";
import type { FapiClient, HttpMethod, RequestOptions } from "../fapi";
import { toList, toPaginatedResponse, type PaginatedResponse } from "../util/pagination";
import { isRecord } from "../util/object";

export interface Envelope<T> {
  data: T;
  client?: ClientJSON;
}

/** Splits the Frontend API `{ response, client }` envelope. */
export function unwrap<T>(raw: unknown): Envelope<T> {
  if (isRecord(raw) && "response" in raw) {
    return { data: raw.response as T, client: raw.client as ClientJSON | undefined };
  }
  return { data: raw as T };
}

export async function fetchData<T>(fapi: FapiClient, method: HttpMethod, path: string, options?: RequestOptions): Promise<T> {
  const raw = await fapi.request<unknown>(method, path, options);
  return unwrap<T>(raw).data;
}

export async function fetchList<T>(fapi: FapiClient, path: string, options: RequestOptions, mapper: (item: unknown) => T): Promise<T[]> {
  const data = await fetchData<unknown>(fapi, "GET", path, options);
  return toList(data, mapper);
}

export async function fetchPaginated<T>(
  fapi: FapiClient,
  path: string,
  options: RequestOptions,
  mapper: (item: unknown) => T,
): Promise<PaginatedResponse<T>> {
  const data = await fetchData<unknown>(fapi, "GET", path, options);
  return toPaginatedResponse(data, mapper);
}
