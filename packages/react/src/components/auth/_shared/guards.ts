/**
 * Canonical runtime guards for the auth component package.
 *
 * Values crossing the SDK/provider boundary are `unknown`; narrow them once with these guards instead
 * of casting fabricated object shapes at individual call sites.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}
