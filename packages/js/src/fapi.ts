import { decodePublishableKey, type ClientJSON } from "@orbitid/shared";
import { errorFromBody, networkError, OrbitAPIResponseError } from "./util/errors";
import { inBrowser } from "./util/browser";
import { toQueryString, type QueryParams } from "./util/pagination";
import { delay } from "./util/async";

export const CLIENT_HEADER = "x-orbitid-client";
export const SDK_VERSION = "0.1.0";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FapiClientOptions {
  publishableKey: string;
  domain?: string;
  proxyUrl?: string;
  /** Explicit Frontend API URL (overrides the one encoded in the publishable key). */
  frontendApi?: string;
  fetch?: FetchLike;
  navigate?: (url: string, options?: { replace?: boolean }) => void;
  /** Called with the raw `client` envelope of every response that carries one. */
  onClient?: (client: ClientJSON) => void;
  retry?: { attempts?: number; delayMs?: number };
}

export interface RequestOptions {
  body?: unknown;
  formData?: FormData;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Per-request retry override (GETs retry on network failure by default). */
  retry?: boolean;
}

class NetworkFailure extends Error {}

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Low-level Frontend API transport. Owns the base URL, headers, credentials, retries and error mapping.
 * Resources never call `fetch` directly.
 */
export class FapiClient {
  readonly publishableKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  onClient?: (client: ClientJSON) => void;
  navigate?: (url: string, options?: { replace?: boolean }) => void;

  constructor(options: FapiClientOptions) {
    if (!options.fetch && typeof fetch !== "function") throw new Error("No fetch implementation available");
    this.publishableKey = options.publishableKey;
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.onClient = options.onClient;
    this.navigate = options.navigate;
    this.retryAttempts = Math.max(1, options.retry?.attempts ?? 3);
    this.retryDelayMs = options.retry?.delayMs ?? 200;
    this.baseUrl = this.resolveBaseUrl(options);
  }

  private resolveBaseUrl(options: FapiClientOptions): string {
    const proxy = options.proxyUrl ?? options.domain;
    if (proxy) return proxy.startsWith("http") ? proxy.replace(/\/+$/, "") : `https://${proxy.replace(/\/+$/, "")}`;
    if (options.frontendApi) return options.frontendApi.replace(/\/+$/, "");
    try {
      return decodePublishableKey(options.publishableKey).frontendApi.replace(/\/+$/, "");
    } catch {
      throw new Error("Invalid publishable key: the Frontend API URL could not be decoded");
    }
  }

  get<T = unknown>(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("GET", path, options);
  }
  post<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, options);
  }
  patch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, options);
  }
  put<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, options);
  }
  del<T = unknown>(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  async request<T = unknown>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const attempts = method === "GET" && options.retry !== false ? this.retryAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, options);
      } catch (err) {
        const retryable = err instanceof NetworkFailure;
        if (!retryable || attempt === attempts - 1) throw retryable ? networkError() : err;
        await delay(this.retryDelayMs);
      }
    }
    throw networkError();
  }

  private async requestOnce<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
    const url = joinUrl(this.baseUrl, path) + toQueryString(options.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      [CLIENT_HEADER]: `@orbitid/js/${SDK_VERSION}`,
    };
    const init: RequestInit = { method, credentials: "include", headers, signal: options.signal };
    if (options.formData) {
      init.body = options.formData;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new NetworkFailure(err instanceof Error ? err.message : "Network request failed");
    }

    if (res.status === 204) return undefined as T;

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }

    if (!res.ok) throw errorFromBody(res.status, json);

    if (json && typeof json === "object" && !Array.isArray(json)) {
      const envelope = json as { client?: ClientJSON };
      if (envelope.client?.object === "client") this.onClient?.(envelope.client);
    }
    return json as T;
  }

  /** Navigates the browser (OAuth redirects); honours an injected router in SSR/tests. */
  redirectTo(url: string): void {
    if (this.navigate) {
      this.navigate(url);
      return;
    }
    if (inBrowser) window.location.assign(url);
  }

  buildUrl(path: string): string {
    return joinUrl(this.baseUrl, path);
  }
}

export { OrbitAPIResponseError };
export type { OrbitAPIResponseError as FapiError };
