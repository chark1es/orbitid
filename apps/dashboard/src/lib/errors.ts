import { ApiError } from "./api";

/** Server error text is operator-facing; surface it verbatim instead of "Request failed". */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}
