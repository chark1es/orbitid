import type { BackendFetch } from "@orbitid/backend";
import { errorFromResponse, OrbitIdError } from "./errors";
import { USER_AGENT } from "./version";

export type FetchImpl = typeof fetch;

export interface TransportOptions {
  /** Transport used for every HTTP call. Defaults to the global `fetch`. */
  fetch?: BackendFetch;
  /** Per-attempt timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Extra attempts for idempotent GETs after a network failure, timeout or 5xx. Defaults to 2. */
  retries?: number;
  /** Base backoff in milliseconds; doubles per attempt. Defaults to 150. */
  retryDelayMs?: number;
  /** `User-Agent` sent on every request. */
  userAgent?: string;
}

export interface Transport {
  /** Raw fetch: retries, timeout and `User-Agent`, but non-2xx responses are returned as-is. */
  fetch: BackendFetch;
  /** Same as `fetch`, but a non-2xx response becomes an `OrbitIdError`. */
  request: BackendFetch;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Headers are merged without letting the caller drop the SDK's `User-Agent` or `Accept`. */
function withHeaders(init: RequestInit | undefined, userAgent: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  return { ...init, headers };
}

function retryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * The SDK transport. Retries only `GET` requests (and only for network failures, timeouts, 429 and
 * 5xx), so a create/update is never applied twice; `POST /tokens` and webhook delivery stay single-shot.
 */
export function createTransport(options: TransportOptions = {}): Transport {
  const baseFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = Math.max(0, options.retries ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);
  const userAgent = options.userAgent ?? USER_AGENT;

  const fetchOnce: BackendFetch = async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const callerSignal = init?.signal;
    const onAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await baseFetch(input, { ...withHeaders(init, userAgent), signal: controller.signal });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", onAbort);
    }
  };

  const fetchWithRetry: BackendFetch = async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const idempotent = method === "GET";
    const attempts = idempotent ? retries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchOnce(input, init);
        if (!idempotent || !retryableStatus(response.status) || attempt === attempts - 1) return response;
        const retryAfter = retryAfterMs(response);
        await response.body?.cancel().catch(() => {});
        await sleep(retryAfter ?? retryDelayMs * 2 ** attempt);
      } catch (error) {
        lastError = error;
        if (!idempotent || attempt === attempts - 1) break;
        await sleep(retryDelayMs * 2 ** attempt);
      }
    }

    if (lastError instanceof OrbitIdError) throw lastError;
    if (lastError instanceof Error && lastError.name === "AbortError") {
      throw new OrbitIdError({
        code: "request_timeout",
        reason: "request-timeout",
        message: `The OrbitID request timed out after ${timeoutMs}ms`,
        cause: lastError,
      });
    }
    throw new OrbitIdError({
      code: "network_error",
      reason: "network-error",
      message: "Could not reach the OrbitID server",
      cause: lastError,
    });
  };

  const request: BackendFetch = async (input, init) => {
    const response = await fetchWithRetry(input, init);
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  };

  return { fetch: fetchWithRetry, request };
}
