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

/** True when `url` is same-origin with the current app (or an explicitly allowed origin). */
export function isSafeRedirectUrl(url: string, options: RedirectValidationOptions = {}): boolean {
  if (!url) return false;
  if (!isAbsoluteUrl(url)) return url.startsWith("/") && !url.startsWith("//");
  let parsed: URL;
  try {
    parsed = new URL(url, currentOrigin(options.origin) ?? "http://localhost");
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const allowed = new Set<string>();
  const origin = currentOrigin(options.origin);
  if (origin) allowed.add(origin);
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
 * fallback. Absolute same-origin URLs are reduced to their path so `router.push` never leaves the app.
 */
export function getSafeRedirectUrl(url: string | null | undefined, fallback = "/", options: RedirectValidationOptions = {}): string {
  if (!url || !isSafeRedirectUrl(url, options)) return fallback;
  if (!isAbsoluteUrl(url)) return url;
  try {
    const parsed = new URL(url, currentOrigin(options.origin) ?? "http://localhost");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function validateRedirectUrl(url: string | null | undefined, options: RedirectValidationOptions = {}): string | null {
  return url && isSafeRedirectUrl(url, options) ? url : null;
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
  if (isAbsoluteUrl(url)) return url;
  const origin = currentOrigin(base);
  if (!origin) return url;
  return new URL(url, origin).toString();
}
