// Safe redirect validation for post-auth navigation.
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";

export const isDevLocalhost = (origin: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/** Returns the normalized absolute URL, or throws `form_param_format_invalid` for untrusted origins. */
export function validateRedirectUrl(ctx: AppContext, value: string | null | undefined, param = "redirect_url"): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  // Resolve first, then judge the result: "/\\evil.example" and "//evil.example" normalize to another host.
  let url: URL;
  try {
    url = new URL(raw, ctx.settings.get().application.homeUrl || ctx.env.baseUrl);
  } catch {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${param} is not a valid URL`, { param_name: param });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${param} must use http(s)`, { param_name: param });
  }
  const app = ctx.settings.get().application;
  const allowed = new Set([...app.allowedOrigins, ...app.allowedRedirectOrigins].map((o) => safeOrigin(o)).filter((o): o is string => !!o));
  if (allowed.has(url.origin)) return url.toString();
  if (app.developmentMode && isDevLocalhost(url.origin)) return url.toString();
  if (safeOrigin(app.homeUrl) === url.origin) return url.toString();
  throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${param} origin is not allowed`, {
    param_name: param,
    allowed_origins: [...allowed],
  });
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Appends query params (used for `__orbit_status` / `__orbit_error` on the way back to the app). */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Allowed origin or null (for CORS-like checks on callback targets). */
export function originAllowed(ctx: AppContext, origin: string): boolean {
  const app = ctx.settings.get().application;
  return [...app.allowedOrigins, ...app.allowedRedirectOrigins].map(safeOrigin).includes(origin)
    || (app.developmentMode && isDevLocalhost(origin))
    || safeOrigin(app.homeUrl) === origin;
}
