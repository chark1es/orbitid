import type { ApiErrorBody, ApiErrorItem } from "@orbitid/shared";

/**
 * Error thrown for every non-2xx Frontend API response (and for exhausted network retries).
 * `.errors` holds the wire items, `.status` the HTTP status, `.traceId` the server trace id.
 */
export class OrbitAPIResponseError extends Error {
  readonly errors: ApiErrorItem[];
  readonly status: number;
  readonly traceId: string | null;
  /** Parsed `Retry-After` for a 429/503, in milliseconds, when the server sent one. */
  readonly retryAfterMs: number | null;

  constructor(status: number, errors: ApiErrorItem[], traceId: string | null = null, retryAfterMs: number | null = null) {
    super(errors[0]?.message ?? `OrbitID API request failed with status ${status}`);
    this.name = "OrbitAPIResponseError";
    this.errors = errors;
    this.status = status;
    this.traceId = traceId;
    this.retryAfterMs = retryAfterMs;
  }

  /** First error code, e.g. `form_password_incorrect`. */
  get code(): string {
    return this.errors[0]?.code ?? "unknown_error";
  }
  get longMessage(): string | undefined {
    return this.errors[0]?.long_message ?? this.errors[0]?.message;
  }
  get meta(): ApiErrorItem["meta"] | undefined {
    return this.errors[0]?.meta;
  }
  hasCode(code: string): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

export function isOrbitAPIResponseError(err: unknown): err is OrbitAPIResponseError {
  return err instanceof OrbitAPIResponseError || (!!err && typeof err === "object" && (err as { name?: string }).name === "OrbitAPIResponseError");
}

export interface ParsedError {
  errors: ApiErrorItem[];
  status: number | null;
  traceId: string | null;
}

/**
 * Normalises any thrown value into the OrbitID error shape.
 * Useful in form handlers: `const { errors } = parseError(e); setError("email", errors[0].message)`.
 */
export function parseError(err: unknown): ParsedError {
  if (isOrbitAPIResponseError(err)) return { errors: err.errors, status: err.status, traceId: err.traceId };
  if (err instanceof Error) return { errors: [{ code: "unknown_error", message: err.message }], status: null, traceId: null };
  return { errors: [{ code: "unknown_error", message: String(err) }], status: null, traceId: null };
}

/** Builds an error from a wire error body, tolerating malformed/empty responses. */
export function errorFromBody(
  status: number,
  body: unknown,
  retryAfterMs: number | null = null,
): OrbitAPIResponseError {
  const candidate = body as Partial<ApiErrorBody> | null;
  const traceId = candidate?.trace_id ?? null;
  if (candidate && Array.isArray(candidate.errors) && candidate.errors.length) {
    return new OrbitAPIResponseError(status, candidate.errors, traceId, retryAfterMs);
  }
  return new OrbitAPIResponseError(
    status,
    [{ code: "unknown_error", message: `Request failed with status ${status}` }],
    traceId,
    retryAfterMs,
  );
}

/**
 * Parses a `Retry-After` header (delta seconds or an HTTP date) into milliseconds. An unusable value
 * returns null so the caller falls back to its own back-off.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function networkError(): OrbitAPIResponseError {
  return new OrbitAPIResponseError(0, [{ code: "network_error", message: "Unable to reach the OrbitID Frontend API" }]);
}
