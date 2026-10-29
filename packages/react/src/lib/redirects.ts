/** Redirect URL handling: precedence, same-origin validation, URL assembly. */

export interface RedirectAllowlistOptions {
  /** Current origin; defaults to `window.location.origin` when available. */
  origin?: string;
  /** Extra origins allowed as redirect targets (exact origin strings or RegExp). */
  allowedRedirectOrigins?: Array<string | RegExp>;
}

export interface RedirectResolutionOptions extends RedirectAllowlistOptions {
  /** `redirect_url` from the current URL (untrusted). */
  redirectUrl?: string | null;
  /** Developer-provided, always wins. */
  forceRedirectUrl?: string | null;
  /** Developer-provided fallback when `redirectUrl` is absent or unsafe. */
  fallbackRedirectUrl?: string | null;
  /** Last resort (e.g. `afterSignOutUrl`). */
  defaultRedirectUrl?: string | null;
}

const currentOrigin = (): string | undefined =>
  typeof window !== "undefined" && typeof window.location !== "undefined" ? window.location.origin : undefined;

/** True for same-origin paths (`/foo`), same-origin URLs and allowlisted origins. */
export function isValidRedirectUrl(url: string | null | undefined, options: RedirectAllowlistOptions = {}): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Browsers drop tabs and newlines and read `\` as `/`, so these all turn into `//evil.com`.
  if (/[\u0000-\u001f]/.test(trimmed)) return false;
  // `//evil.com` is protocol-relative and therefore cross-origin.
  if (/^[/\\]{2}/.test(trimmed) || trimmed.startsWith("/\\")) return false;
  if (trimmed.startsWith("/")) return true;
  if (!/^https?:\/\//i.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const origin = options.origin ?? currentOrigin();
  if (origin && parsed.origin === origin) return true;
  return (options.allowedRedirectOrigins ?? []).some((allowed) =>
    typeof allowed === "string"
      ? allowed === parsed.origin
      : new RegExp(allowed.source, allowed.flags).test(parsed.origin),
  );
}

/**
 * Redirect precedence: `forceRedirectUrl` → validated `redirectUrl` →
 * `fallbackRedirectUrl` → `defaultRedirectUrl`.
 */
export function resolveRedirectUrl(options: RedirectResolutionOptions): string | undefined {
  const { redirectUrl, forceRedirectUrl, fallbackRedirectUrl, defaultRedirectUrl } = options;
  if (forceRedirectUrl) return forceRedirectUrl;
  if (redirectUrl && isValidRedirectUrl(redirectUrl, options)) return redirectUrl;
  if (fallbackRedirectUrl) return fallbackRedirectUrl;
  return defaultRedirectUrl ?? undefined;
}

/** Read `?redirect_url=` (or a custom param) from the search string or the hash query. */
export function getRedirectUrlFromLocation(paramName = "redirect_url"): string | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") return null;
  const fromSearch = new URLSearchParams(window.location.search).get(paramName);
  if (fromSearch) return fromSearch;
  const hash = window.location.hash.replace(/^#/, "");
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get(paramName);
}

/** The `redirect_url` in the current location when it is safe to follow (same origin or allowlisted), else undefined. */
export function safeRedirectUrlFromLocation(options: RedirectAllowlistOptions = {}): string | undefined {
  const url = getRedirectUrlFromLocation();
  return url && isValidRedirectUrl(url, options) ? url : undefined;
}

/** Append `param=value` to a relative or absolute URL, before any hash. Idempotent. */
export function appendRedirectParam(url: string, paramName: string, value?: string | null): string {
  if (!value) return url;
  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);
  if (new URLSearchParams(search).has(paramName)) return url;
  const query = `${search ? `${search}&` : ""}${paramName}=${encodeURIComponent(value)}`;
  return `${pathname}?${query}${hash}`;
}

/** Swap the trailing `sign-in`/`sign-up` segment of `baseUrl` for `component`. */
export function buildComponentUrl(baseUrl: string | null | undefined, component: string): string {
  const slug = component.replace(/^\//, "");
  if (!baseUrl) return `/${slug}`;
  const hashIndex = baseUrl.indexOf("#");
  if (hashIndex >= 0) {
    const prefix = baseUrl.slice(0, hashIndex);
    const hashPath = baseUrl.slice(hashIndex + 1) || "/";
    return `${prefix}#${withTrailingComponent(hashPath, slug)}`;
  }
  const [pathname, search] = baseUrl.split("?") as [string, string?];
  return `${withTrailingComponent(pathname!, slug)}${search ? `?${search}` : ""}`;
}

function withTrailingComponent(pathname: string, slug: string): string {
  const segments = pathname.split("/");
  const last = segments[segments.length - 1];
  if (segments.length > 1 && (last === "sign-in" || last === "sign-up")) {
    segments[segments.length - 1] = slug;
    return segments.join("/");
  }
  return `${pathname.replace(/\/$/, "")}/${slug}`;
}

export interface ResolveComponentUrlOptions {
  /** Component slug, e.g. `sign-in`. */
  component: string;
  /** Explicit prop URL — highest precedence. */
  url?: string | null;
  /** Provider option for this component (`signInUrl`, `signUpUrl`). */
  configuredUrl?: string | null;
  /** Base URL to derive the component URL from (e.g. `signInUrl` for `user-profile`). */
  baseUrl?: string | null;
  /** URL produced by the SDK (`buildSignInUrl`); used verbatim, no extra params appended. */
  sdkUrl?: string | null;
  /** Round-trip target appended as `redirect_url`. */
  redirectUrl?: string | null;
  paramName?: string;
}

/** Assemble a component URL: explicit prop → provider option → derived → `/<component>`. */
export function resolveComponentUrl(options: ResolveComponentUrlOptions): string {
  const { component, url, configuredUrl, baseUrl, sdkUrl, redirectUrl, paramName = "redirect_url" } = options;
  if (sdkUrl) return sdkUrl;
  const target = url ?? configuredUrl ?? buildComponentUrl(baseUrl, component);
  return appendRedirectParam(target, paramName, redirectUrl);
}

/** Current absolute URL, or `undefined` during SSR. */
export function currentLocationUrl(): string | undefined {
  if (typeof window === "undefined" || typeof window.location === "undefined") return undefined;
  return window.location.href;
}
