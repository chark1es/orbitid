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

/**
 * The `redirect_url` a protected route sent the visitor here with, when it points back into this site
 * (a path or a same-origin URL). Anything else is dropped so the parameter cannot be an open redirect.
 */
export function redirectUrlFromQuery(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = new URLSearchParams(window.location.search).get("redirect_url");
  if (!raw) return undefined;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return undefined;
    const target = `${url.pathname}${url.search}${url.hash}`;
    // `//host` and `/\\host` would be read as another origin once handed to the router.
    return /^\/[\\/]/.test(target) ? undefined : target;
  } catch {
    return undefined;
  }
}
