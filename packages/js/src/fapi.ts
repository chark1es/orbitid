import { decodePublishableKey, type ClientJSON } from "@orbitid/shared";
import { errorFromBody, networkError, OrbitAPIResponseError, parseRetryAfter } from "./util/errors";
import { inBrowser } from "./util/browser";
import { toQueryString, type QueryParams } from "./util/pagination";
import { delayWithSignal } from "./util/async";

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

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

function abortError(signal?: AbortSignal): unknown {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

/** Only absolute `http(s)` URLs may be navigated to from an API-supplied redirect. */
function isNavigableUrl(url: string): boolean {
  // Resolving `//evil.test` against the current origin yields a different origin, so the scheme has to be
  // explicit: a protocol-relative or relative value from an API response is not a navigation target.
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

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
    // A caller that aborted must never be retried: the retry would outlive the component that asked.
    if (options.signal?.aborted) throw abortError(options.signal);
    const attempts = method === "GET" && options.retry !== false ? this.retryAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.requestOnce<T>(method, path, options);
      } catch (err) {
        if (options.signal?.aborted || isAbortError(err)) throw isAbortError(err) ? err : abortError(options.signal);
        const retryable = err instanceof NetworkFailure;
        if (!retryable || attempt === attempts - 1) throw retryable ? networkError() : err;
        // Wake immediately on abort instead of holding a timer for the whole back-off.
        await delayWithSignal(this.retryDelayMs, options.signal);
        if (options.signal?.aborted) throw abortError(options.signal);
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
      if (isAbortError(err)) throw err;
      throw new NetworkFailure(err instanceof Error ? err.message : "Network request failed");
    }

    if (res.status === 204) return undefined as T;

    let json: unknown = null;
    try {
      json = await res.json();
    } catch (err) {
      // A body that never finishes must not turn into a slow-motion retry loop.
      if (isAbortError(err) || options.signal?.aborted) throw isAbortError(err) ? err : abortError(options.signal);
      json = null;
    }

    if (!res.ok) throw errorFromBody(res.status, json, parseRetryAfter(res.headers?.get?.("retry-after") ?? null));

    if (json && typeof json === "object" && !Array.isArray(json)) {
      const envelope = json as { client?: ClientJSON };
      if (envelope.client?.object === "client") this.onClient?.(envelope.client);
    }
    return json as T;
  }

  /**
   * Navigates the browser (OAuth redirects); honours an injected router in SSR/tests.
   * Only `http(s)` targets are followed: the URL comes from an API response, and `javascript:`/`data:`
   * would execute or render attacker content on this origin.
   */
  redirectTo(url: string): void {
    if (!isNavigableUrl(url)) return;
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
