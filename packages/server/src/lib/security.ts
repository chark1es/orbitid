// Response hardening + cross-site request protection for the whole server.
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import { randomToken } from "./crypto";
import { MAX_UPLOAD_BYTES } from "./http";
import type { AppContext } from "../context";

/** Extra origins the dashboard may call (`connect-src`), for operators whose API lives elsewhere. */
export function dashboardConnectSources(ctx: AppContext): string[] {
  const raw = process.env.ORBITID_DASHBOARD_CONNECT_SRC ?? "";
  return raw.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean).filter((v) => v === "'self'" || /^https?:\/\/[^\s/]+$/.test(v));
}

/**
 * Content-Security-Policy for the dashboard HTML. Inline scripts are only allowed with the per-request
 * nonce (`<script nonce="…">`); the UI library injects styles, hence `style-src 'unsafe-inline'`.
 */
export function dashboardCsp(ctx: AppContext, nonce: string): string {
  const connect = ["'self'", ...dashboardConnectSources(ctx)].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh CSP nonce for one HTML response. */
export const cspNonce = () => randomToken(18);

const HSTS = "max-age=31536000; includeSubDomains";

/**
 * Baseline response headers for every response: no MIME sniffing, no referrer leakage, no framing,
 * no camera/microphone/geolocation, HSTS when this instance is served over https. JSON API responses
 * that did not choose a cache policy themselves become `no-store`, because they can carry tokens and
 * personal data.
 */
export const securityHeaders = (ctx: AppContext): MiddlewareHandler => async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has("x-content-type-options")) h.set("x-content-type-options", "nosniff");
  if (!h.has("referrer-policy")) h.set("referrer-policy", "no-referrer");
  if (!h.has("x-frame-options")) h.set("x-frame-options", "DENY");
  if (!h.has("permissions-policy")) {
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  }
  if (ctx.env.baseUrl.startsWith("https://") && !h.has("strict-transport-security")) h.set("strict-transport-security", HSTS);
  // HTML documents always get a CSP; the dashboard replaces this with its nonce-based policy.
  if (h.get("content-type")?.includes("text/html") && !h.has("content-security-policy")) {
    h.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  }
  if (c.req.path.startsWith("/v1/") && !h.has("cache-control")) h.set("cache-control", "no-store");
};

const originOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/** Origins a browser request may legitimately come from: configured origins, the app origin and this server. */
export function requestOriginAllowed(ctx: AppContext, origin: string): boolean {
  const app = ctx.settings.get().application;
  const allowed = new Set<string>();
  for (const value of [...app.allowedOrigins, ...app.allowedRedirectOrigins]) {
    const normalized = originOf(value);
    if (normalized) allowed.add(normalized);
  }
  const home = originOf(app.homeUrl);
  if (home) allowed.add(home);
  const base = originOf(ctx.env.baseUrl);
  if (base) allowed.add(base);
  if (app.developmentMode && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  return allowed.has(origin);
}

/**
 * Cross-site request forgery guard for the cookie-authenticated Frontend API. Requests that carry the
 * `__client` cookie and change state must come from an origin this instance trusts. Browsers always send
 * `Origin` on such requests (or at least `Referer`); a request with neither cannot be a browser-driven
 * cross-site attack, so non-browser clients keep working. Bearer-token requests are unaffected.
 */
export const csrfProtection = (ctx: AppContext): MiddlewareHandler => async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") return next();
  if (!c.req.path.startsWith("/v1/client")) return next();
  if (!getCookie(c, COOKIES.client)) return next();

  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase() ?? "";
  const origin = c.req.header("origin");
  const candidate = origin ? originOf(origin) : originOf(c.req.header("referer"));

  if (candidate && requestOriginAllowed(ctx, candidate)) return next();
  // No Origin/Referer at all: not a browser cross-site request (curl, server-side SDK, tests).
  if (!candidate && fetchSite !== "cross-site") return next();

  throw new OrbitError(403, ErrorCodes.not_allowed_access, "Cross-site request blocked. Start the request from this application's origin.", {
    origin: candidate ?? null,
  });
};

/** Console/log-safe value: control characters (including CR/LF) are escaped so they cannot forge log lines. */
export function logSafe(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Routes that legitimately take an image upload; everything else is capped much lower. */
const UPLOAD_PATH = /\/(profile_image|logo)(\/|$)/;
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Request body cap, enforced on the stream itself: a declared `Content-Length` over the cap is refused up front,
 * and a body that arrives without one (chunked) is cut off with a 413 as soon as it passes the cap. Image uploads
 * get 5 MB, everything else 1 MB. It runs before any route parses a body, callbacks and multipart forms included.
 */
export const uploadSizeLimit = (maxBytes = MAX_UPLOAD_BYTES): MiddlewareHandler => async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const cap = UPLOAD_PATH.test(c.req.path) ? maxBytes : Math.min(maxBytes, MAX_BODY_BYTES);
  const limited = bodyLimit({
    maxSize: cap,
    onError: () => {
      throw new OrbitError(413, ErrorCodes.request_body_invalid, `Request body must be smaller than ${cap >= 1024 * 1024 ? Math.round(cap / 1024 / 1024) + " MB" : Math.round(cap / 1024) + " KB"}`);
    },
  });
  return limited(c, next);
};
