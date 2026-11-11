import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

declare global {
  interface Window {
    /** Injected by the OrbitID server into the dashboard it serves. */
    __ORBITID__?: { apiUrl?: string; publishableKey?: string; database?: string };
  }
}

/**
 * The server that served this page, else VITE_ORBITID_API_URL (Vite dev server talking to a separate API
 * process), else the page's own origin. A dashboard is same-origin with the instance it manages: the
 * operator session cookie only works there.
 */
export const DEFAULT_API_URL: string = (typeof window !== "undefined" ? window.__ORBITID__?.apiUrl : undefined)
  ?? (import.meta as any).env?.VITE_ORBITID_API_URL
  ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost:4000");
/** Default API origin; prefer `getApiUrl()`. */
export const API_URL: string = DEFAULT_API_URL;
const API_URL_KEY = "orbitid.apiUrl";
/** Hard ceiling for `apiAllPages`: a broken server must never spin the tab forever. */
const MAX_LIST_PAGES = 200;

/**
 * API origin the dashboard talks to. It defaults to the server that served the page. A cross-origin origin
 * is remembered for the tab only, and only matters for a local development server; a hosted dashboard is
 * same-origin by design, because the operator session cookie is same-origin only.
 */
export const getApiUrl = (): string => {
  if (typeof sessionStorage === "undefined") return DEFAULT_API_URL;
  return sessionStorage.getItem(API_URL_KEY) ?? DEFAULT_API_URL;
};
export const setApiUrl = (url: string | null) => {
  if (typeof sessionStorage === "undefined") return;
  const trimmed = url?.trim().replace(/\/+$/, "") ?? "";
  if (!trimmed || trimmed === DEFAULT_API_URL) sessionStorage.removeItem(API_URL_KEY);
  else sessionStorage.setItem(API_URL_KEY, trimmed);
};

/** True when the dashboard is served by the instance it manages. The operator cookie only works there. */
export const isSameOrigin = (url: string = getApiUrl()): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** `fetch` options every Backend API call needs: the httpOnly operator cookie travels automatically. */
export function apiInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    // The operator session is an httpOnly cookie, not a header, so it must be sent with credentials. It is
    // `SameSite=Strict` and scoped to `/v1`, and the server rejects it from any other origin.
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

/** Tell the shell an operator session has ended, so it can send the operator to /login. */
export function notifyUnauthorized(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>("orbitid:unauthorized", { detail: "Your dashboard session ended. Sign in again." }),
  );
}

/** Backend API call. `path` like "/users?limit=10". Throws ApiError. Returns parsed JSON (undefined for 204). */
export async function api<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${getApiUrl()}/v1${path}`, signal ? { ...apiInit(method, body), signal } : apiInit(method, body));
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.errors?.[0];
    if (res.status === 401 && path !== "/operator_sessions/current") {
      // A 401 is not proof that the operator session ended: a proxy or a captive portal can answer with
      // its own HTML 401. The server's own session answer is the structured `authentication_invalid`
      // error; anything else has to be confirmed against the session endpoint before the shell signs out.
      const structured = e?.code === "authentication_invalid";
      if (structured) notifyUnauthorized();
      else await confirmOperatorSessionEnded();
    }
    throw new ApiError(res.status, e?.code ?? "unknown", e?.long_message ?? e?.message ?? res.statusText);
  }
  return json as T;
}

/** One confirmation at a time: N queries failing together ask the session endpoint once, not N times. */
let sessionEndConfirmation: Promise<boolean> | null = null;

/** True only when the session endpoint itself says the operator cookie no longer works. */
function confirmOperatorSessionEnded(): Promise<boolean> {
  sessionEndConfirmation ??= (async () => {
    try {
      const res = await fetch(`${getApiUrl()}/v1/operator_sessions/current`, apiInit("GET"));
      const ended = res.status === 401 || res.status === 403;
      // One notification for the whole wave: every caller is waiting on this same promise.
      if (ended) notifyUnauthorized();
      return ended;
    } catch {
      // The confirmation did not reach the instance: keep the session rather than bouncing to /login.
      return false;
    }
  })().finally(() => {
    sessionEndConfirmation = null;
  });
  return sessionEndConfirmation;
}

/**
 * Reads every page of a Backend API list. Use it for admin lists that the UI shows in full (a badge count
 * or a client-side filter): a single `?limit=100` request silently truncates at the server's cap.
 */
export async function apiAllPages<T>(
  path: string,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<{ data: T[]; total_count: number }> {
  const pageSize = options.pageSize ?? 100;
  const separator = path.includes("?") ? "&" : "?";
  const data: T[] = [];
  let offset = 0;
  let total = 0;
  let pages = 0;
  let previousPage = "";
  for (;;) {
    if (pages >= MAX_LIST_PAGES) break;
    pages += 1;
    const page = await api<{ data?: T[]; response?: T[]; total_count?: number }>(
      "GET",
      `${path}${separator}limit=${pageSize}&offset=${offset}`,
      undefined,
      options.signal,
    );
    const batch = Array.isArray(page) ? (page as T[]) : page?.data ?? page?.response ?? [];
    // A server that ignores `offset` returns the same page forever. Treat an identical page as the end.
    const pageKey = JSON.stringify(batch);
    if (batch.length > 0 && pageKey === previousPage) break;
    previousPage = pageKey;
    if (typeof page?.total_count === "number") total = page.total_count;
    data.push(...batch);
    offset += batch.length;
    if (batch.length === 0) break;
    if (total > 0 ? offset >= total : batch.length < pageSize) break;
  }
  return { data, total_count: total || data.length };
}

/** `const { data } = useApi<PaginatedList<UserJSON>>(["users", q], `/users?query=${q}`)` */
export function useApi<T>(key: unknown[], path: string, opts: Partial<UseQueryOptions<T>> = {}) {
  // The query's signal cancels the request when its key changes or its component unmounts.
  return useQuery<T>({ queryKey: key, queryFn: ({ signal }) => api<T>("GET", path, undefined, signal), ...opts });
}
/** `const m = useApiMutation("POST", "/users", { invalidate: [["users"]] }); m.mutate(body)`; for dynamic paths pass a function. */
export function useApiMutation<TBody = unknown, TRes = any>(method: string, path: string | ((b: TBody) => string), o: { invalidate?: unknown[][]; onSuccess?: (r: TRes) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: (b) => api<TRes>(method, typeof path === "function" ? path(b) : path, method === "DELETE" && b === undefined ? undefined : b),
    onSuccess: (r) => { o.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k })); o.onSuccess?.(r); },
  });
}
