import type { ApiErrorItem } from "@orbitid/shared";

/** Thrown for every non-2xx Backend API response. */
export class OrbitIdAPIError extends Error {
  readonly status: number;
  readonly errors: ApiErrorItem[];
  readonly traceId: string | null;

  constructor(status: number, errors: ApiErrorItem[], traceId: string | null = null) {
    super(errors[0]?.message ?? `OrbitID Backend API request failed with status ${status}`);
    this.name = "OrbitIdAPIError";
    this.status = status;
    this.errors = errors;
    this.traceId = traceId;
  }

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
    return this.errors.some((item) => item.code === code);
  }
}

export function isOrbitIdAPIError(error: unknown): error is OrbitIdAPIError {
  return error instanceof OrbitIdAPIError || (!!error && typeof error === "object" && (error as { name?: string }).name === "OrbitIdAPIError");
}
