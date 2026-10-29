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

/** Backend API call. `path` like "/users?limit=10". Throws ApiError. Returns parsed JSON (undefined for 204). */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getApiUrl()}/v1${path}`, apiInit(method, body));
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.errors?.[0];
    if (res.status === 401) {
      // The session expired or was revoked: tell the shell so it can send the operator to /login.
      window.dispatchEvent(
        new CustomEvent<string>("orbitid:unauthorized", { detail: "Your dashboard session ended. Sign in again." }),
      );
    }
    throw new ApiError(res.status, e?.code ?? "unknown", e?.long_message ?? e?.message ?? res.statusText);
  }
  return json as T;
}

/** `const { data } = useApi<PaginatedList<UserJSON>>(["users", q], `/users?query=${q}`)` */
export function useApi<T>(key: unknown[], path: string, opts: Partial<UseQueryOptions<T>> = {}) {
  return useQuery<T>({ queryKey: key, queryFn: () => api<T>("GET", path), ...opts });
}
/** `const m = useApiMutation("POST", "/users", { invalidate: [["users"]] }); m.mutate(body)`; for dynamic paths pass a function. */
export function useApiMutation<TBody = unknown, TRes = any>(method: string, path: string | ((b: TBody) => string), o: { invalidate?: unknown[][]; onSuccess?: (r: TRes) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: (b) => api<TRes>(method, typeof path === "function" ? path(b) : path, method === "DELETE" && b === undefined ? undefined : b),
    onSuccess: (r) => { o.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k })); o.onSuccess?.(r); },
  });
}
