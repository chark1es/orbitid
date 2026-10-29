import type { ApiErrorItem } from "@orbitid/shared";
import type { AuthContext } from "../auth-context";
import type { OrbitIdNode } from "../client";
import type { RequestLike } from "../request";

/** The subset of the SDK the adapters need. Lets tests pass a stub. */
export type AuthResolver = Pick<OrbitIdNode, "authenticate">;

export interface AdapterOptions {
  /**
   * Called when authentication could not run at all (JWKS unreachable, bad configuration).
   * The HTTP response stays generic; use this hook for your own logging.
   */
  onError?: (error: unknown, request: RequestLike) => void;
}

/** Wire body of every refusal, matching the server's `{ errors: [...] }` shape. */
export interface ErrorResponseBody {
  errors: ApiErrorItem[];
}

export function unauthorized(message = "Authentication required"): ErrorResponseBody {
  return { errors: [{ code: "authentication_invalid", message }] };
}

export function forbidden(message = "You do not have permission to perform this action"): ErrorResponseBody {
  return { errors: [{ code: "org_permission_required", message }] };
}

export function forbiddenRole(message = "This action requires a different role"): ErrorResponseBody {
  return { errors: [{ code: "not_allowed_access", message }] };
}

/** Authentication infrastructure failed; the detail is reported through `onError`, never to the caller. */
export function authUnavailable(): ErrorResponseBody {
  return { errors: [{ code: "authentication_unavailable", message: "Authentication is temporarily unavailable" }] };
}

/** Normalizes `"a"` / `["a", "b"]` to a non-empty array. */
export function toList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Resolves the caller and classifies the outcome so every adapter answers the same way:
 * `signed-out` → 401, `signed-in` → continue, `error` → 503 (detail via `onError`).
 */
export type ResolvedAuth =
  | { kind: "signed-in"; auth: AuthContext }
  | { kind: "signed-out" }
  | { kind: "error" };

export async function resolveAuth(orbit: AuthResolver, request: RequestLike, options: AdapterOptions = {}): Promise<ResolvedAuth> {
  try {
    const auth = await orbit.authenticate(request);
    return auth ? { kind: "signed-in", auth } : { kind: "signed-out" };
  } catch (error) {
    options.onError?.(error, request);
    return { kind: "error" };
  }
}

export function missingPermission(permission: string): ErrorResponseBody {
  return forbidden(`You do not have permission to perform this action. Missing permission: ${permission}`);
}
