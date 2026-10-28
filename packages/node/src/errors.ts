import type { ApiErrorBody, ApiErrorItem } from "@orbitid/shared";
import { z } from "zod";

/**
 * Why an `OrbitIdError` was thrown. The reason is for application code and logs; the HTTP
 * response written by the framework adapters stays generic so internals never reach a client.
 */
export type OrbitIdErrorReason =
  | "configuration"
  | "token-missing"
  | "token-expired"
  | "token-not-active-yet"
  | "invalid-signature"
  | "invalid-algorithm"
  | "invalid-issuer"
  | "invalid-audience"
  | "invalid-authorized-party"
  | "invalid-claims"
  | "not-session-token"
  | "session-pending"
  | "jwks-fetch-failed"
  | "no-matching-key"
  | "permission-denied"
  | "role-required"
  | "network-error"
  | "request-timeout"
  | "webhook-verification-failed"
  | "unknown";

export interface OrbitIdErrorOptions {
  /** HTTP status of the failing call, or `null` when the failure never reached the server. */
  status?: number | null;
  /** Stable code: an OrbitID API error code, or one of the SDK's own codes. */
  code: string;
  message: string;
  reason?: OrbitIdErrorReason;
  traceId?: string | null;
  meta?: ApiErrorItem["meta"];
  /** Every error item when the API returned more than one. */
  errors?: ApiErrorItem[];
  cause?: unknown;
}

const errorItemSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    long_message: z.string().nullish(),
    meta: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();

const errorBodySchema = z
  .object({
    errors: z.array(errorItemSchema).min(1),
    trace_id: z.string().nullish(),
  })
  .passthrough();

/** Typed error for every failure raised by this SDK: API responses, verification and transport. */
export class OrbitIdError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly reason: OrbitIdErrorReason | null;
  readonly traceId: string | null;
  readonly meta: ApiErrorItem["meta"] | null;
  readonly errors: ApiErrorItem[];

  constructor(options: OrbitIdErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OrbitIdError";
    this.status = options.status ?? null;
    this.code = options.code;
    this.reason = options.reason ?? null;
    this.traceId = options.traceId ?? null;
    this.meta = options.meta ?? null;
    this.errors = options.errors?.length
      ? options.errors
      : [{ code: options.code, message: options.message, ...(options.meta ? { meta: options.meta } : {}) }];
  }

  toItem(): ApiErrorItem {
    return this.errors[0] ?? { code: this.code, message: this.message };
  }

  /** Wire shape shared with the OrbitID APIs. */
  toBody(): ApiErrorBody {
    return { errors: this.errors, ...(this.traceId ? { trace_id: this.traceId } : {}) };
  }

  hasCode(code: string): boolean {
    return this.errors.some((item) => item.code === code);
  }
}

export function isOrbitIdError(error: unknown): error is OrbitIdError {
  return error instanceof OrbitIdError || (!!error && typeof error === "object" && (error as { name?: string }).name === "OrbitIdError");
}

/** Parses an API error body, returning `null` when the payload is not the documented shape. */
export function parseApiErrorBody(value: unknown): ApiErrorBody | null {
  const parsed = errorBodySchema.safeParse(value);
  if (!parsed.success) return null;
  const errors = parsed.data.errors.map((item): ApiErrorItem => ({
    code: item.code,
    message: item.message,
    ...(item.long_message ? { long_message: item.long_message } : {}),
    ...(item.meta ? { meta: item.meta as ApiErrorItem["meta"] } : {}),
  }));
  return { errors, ...(parsed.data.trace_id ? { trace_id: parsed.data.trace_id } : {}) };
}

/**
 * Builds an `OrbitIdError` from a non-2xx response. The response body is validated before use;
 * an unexpected (non-JSON) body is summarized by status only, so proxy pages and stack traces
 * never surface to the application.
 */
export async function errorFromResponse(response: Response): Promise<OrbitIdError> {
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const parsed = parseApiErrorBody(body);
  if (!parsed) {
    return new OrbitIdError({
      status: response.status,
      code: "unknown_error",
      message: `The OrbitID server returned an unexpected response (status ${response.status})`,
    });
  }
  const first = parsed.errors[0]!;
  return new OrbitIdError({
    status: response.status,
    code: first.code,
    message: first.message,
    traceId: parsed.trace_id ?? response.headers.get("x-orbitid-trace-id") ?? null,
    meta: first.meta,
    errors: parsed.errors,
  });
}
