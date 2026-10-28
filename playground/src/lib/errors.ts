import { isOrbitIdAPIError } from "@orbitid/backend";

/** One sentence an operator can act on, with the Backend API status and code when there is one. */
export function describeError(error: unknown): string {
  if (isOrbitIdAPIError(error)) {
    return `${error.status} ${error.code}: ${error.longMessage ?? error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "The request failed without an error message.";
}
