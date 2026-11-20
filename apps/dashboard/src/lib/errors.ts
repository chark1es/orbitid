import { ApiError } from "./api";

/** "Try again in 40 seconds" / "in 2 minutes", for a rate limit's `Retry-After`. */
export function retryAfterText(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "Try again in a moment.";
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** Server error text is operator-facing; surface it verbatim instead of "Request failed". */
export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  // The limiter's own text is generic; say how long to wait instead.
  if (error instanceof ApiError && error.status === 429) return `Too many attempts. ${retryAfterText(error.retryAfter)}`;
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}
