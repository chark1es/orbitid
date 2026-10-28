import type { ApiErrorBody } from "@orbitid/shared";
import { camelizeDeep, snakeizeDeep } from "./case";
import { OrbitIdAPIError } from "./errors";

export type BackendFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BackendHttpOptions {
  secretKey: string;
  apiUrl?: string;
  fetch?: BackendFetch;
}

export interface BackendRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null | Array<string | number>>;
  body?: unknown;
  formData?: FormData;
}

export const DEFAULT_API_URL = "https://api.orbitid.dev";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function toQueryString(query: BackendRequestOptions["query"] = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const queryKey = key.replace(/\[\]$/, "");
      for (const item of value) search.append(queryKey, String(item));
    } else {
      search.append(key, String(value));
    }
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

/** Minimal Backend API transport: bearer auth, snake↔camel mapping, typed errors. */
export class BackendHttp {
  readonly apiUrl: string;
  readonly secretKey: string;
  private readonly fetchImpl: BackendFetch;

  constructor(options: BackendHttpOptions) {
    if (!options.secretKey) throw new Error("createOrbitIdClient requires a secretKey");
    if (!options.fetch && typeof fetch !== "function") throw new Error("No fetch implementation available");
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.secretKey = options.secretKey;
    this.fetchImpl = (options.fetch ?? fetch).bind(globalThis);
  }

  async request<T = unknown>(method: string, path: string, options: BackendRequestOptions = {}): Promise<T> {
    const url = `${joinUrl(this.apiUrl, path)}${toQueryString(options.query)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (options.formData) {
      init.body = options.formData;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(snakeizeDeep(options.body));
    }

    const response = await this.fetchImpl(url, init);
    if (response.status === 204) return undefined as T;

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const body = payload as Partial<ApiErrorBody> | null;
      const errors = Array.isArray(body?.errors) && body.errors.length ? body.errors : [{ code: "unknown_error", message: `Request failed with status ${response.status}` }];
      throw new OrbitIdAPIError(response.status, errors, body?.trace_id ?? null);
    }

    return camelizeDeep<T>(payload);
  }

  get<T = unknown>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }
  post<T = unknown>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, options);
  }
  patch<T = unknown>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }
  put<T = unknown>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, options);
  }
  delete<T = unknown>(path: string, options: BackendRequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }
}
