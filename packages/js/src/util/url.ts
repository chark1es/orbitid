import { inBrowser } from "./browser";

export interface RedirectValidationOptions {
  /** Extra origins considered safe (e.g. `settings.application.allowedRedirectOrigins`). */
  allowedOrigins?: string[];
  /** Origin of the current app; defaults to `window.location.origin` when in a browser. */
  origin?: string;
}

function currentOrigin(origin?: string): string | null {
  if (origin) return origin;
  if (inBrowser) return window.location.origin;
  return null;
}

export function isAbsoluteUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || url.startsWith("//");
}

/** C0 control characters and DEL, which browsers drop or truncate in a URL and so change what it means. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * True when `url` is same-origin with the current app (or an explicitly allowed origin).
 *
 * Every candidate — relative or absolute — is resolved with `new URL` before it is judged, exactly the way
 * the browser (and `router.push`) will interpret it. Checking the string prefix is not enough: browsers read
 * `\` as `/` and drop tabs, so `/\evil.test/x` and `/<TAB>/evil.test` are protocol-relative URLs that leave
 * the app, while `//evil.test` and `javascript:` are obvious. Anything that resolves off the allowed origins
 * is refused.
 */
export function isSafeRedirectUrl(url: string, options: RedirectValidationOptions = {}): boolean {
  if (!url) return false;
  if (UNSAFE_CHARS.test(url)) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (!isAbsoluteUrl(trimmed) && !trimmed.startsWith("/")) return false;

  const base = currentOrigin(options.origin) ?? "http://localhost";
  let parsed: URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
    parsed = new URL(trimmed, baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // `https://user:pass@host` is never a redirect target we want to follow.
  if (parsed.username || parsed.password) return false;

  const allowed = new Set<string>([baseUrl.origin]);
  for (const extra of options.allowedOrigins ?? []) {
    try {
      allowed.add(new URL(extra).origin);
    } catch {
      /* ignore malformed configured origins */
    }
  }
  return allowed.has(parsed.origin);
}

/**
 * Returns the redirect target only when it stays on the app's origin (or an allowed origin), otherwise the
 * fallback. The result is always a path on this origin, so `router.push` never leaves the app — even for an
 * input the browser would re-read differently (`/\evil.test`, tab-prefixed paths).
 */
export function getSafeRedirectUrl(url: string | null | undefined, fallback = "/", options: RedirectValidationOptions = {}): string {
  if (!url || !isSafeRedirectUrl(url, options)) return fallback;
  try {
    const parsed = new URL(url.trim(), currentOrigin(options.origin) ?? "http://localhost");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function validateRedirectUrl(url: string | null | undefined, options: RedirectValidationOptions = {}): string | null {
  if (!url || !isSafeRedirectUrl(url, options)) return null;
  return url.trim();
}

export function appendQuery(url: string, params: Record<string, string | undefined | null>): string {
  const [path, hash = ""] = url.split("#", 2) as [string, string?];
  const separator = path.includes("?") ? "&" : "?";
  const query = Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const base = query ? `${path}${separator}${query}` : path;
  return hash ? `${base}#${hash}` : base;
}

/** Appends `redirect_url` to a sign-in/sign-up/profile URL. */
export function buildRedirectUrl(baseUrl: string, redirectUrl?: string | null): string {
  return appendQuery(baseUrl, { redirect_url: redirectUrl ?? undefined });
}

export function toAbsoluteUrl(url: string, base?: string): string {
  const origin = currentOrigin(base);
  let baseUrl: URL;
  try {
    baseUrl = new URL(origin ?? "http://localhost");
  } catch {
    return url;
  }
  const root = new URL("/", baseUrl).toString();
  if (isAbsoluteUrl(url)) {
    // An absolute URL is a configured value (a sign-in page on another host), so it is used as given —
    // but only over http(s), and never with credentials embedded in it.
    try {
      const parsed = new URL(url, baseUrl);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return root;
      return url;
    } catch {
      return root;
    }
  }
  // Without an origin (SSR) a relative path cannot be resolved; only an unambiguous same-app path passes.
  if (!origin) return url.startsWith("/") && !url.startsWith("//") && !UNSAFE_CHARS.test(url) && !url.includes("\\") ? url : root;
  // Resolve before judging: `/\evil.test` and `/<TAB>/evil.test` are read as protocol-relative by browsers,
  // so a string prefix check cannot see that they leave the app.
  try {
    const resolved = new URL(url, baseUrl);
    if (resolved.origin !== baseUrl.origin) return root;
    return resolved.toString();
  } catch {
    return root;
  }
}
