import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

export const API_URL: string = (import.meta as any).env?.VITE_ORBITID_API_URL ?? "http://localhost:4000";
const KEY = "orbitid.secretKey";
export const getSecretKey = () => sessionStorage.getItem(KEY) ?? "";
export const setSecretKey = (k: string | null) => (k ? sessionStorage.setItem(KEY, k) : sessionStorage.removeItem(KEY));

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Backend API call. `path` like "/users?limit=10". Throws ApiError. Returns parsed JSON (undefined for 204). */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${getSecretKey()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.errors?.[0];
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
