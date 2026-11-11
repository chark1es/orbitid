/** Constants, schemas, and helpers shared by the OAuth/OIDC routes. */
import { type Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type AppContext } from "../../context";
import { validateRedirectUrl } from "../auth/redirects";
import { GROUPS_CLAIM_MODES, LIFETIME_BOUNDS, OAuthError } from "../../services/oidc/shared";
import { issuerFor } from "../../services/oidc/issuer";
import { cspNonce } from "../../lib/security";
import { escapeHtml } from "../../lib/html";

/**
 * Attempts a single user code gets (per IP and per code) before the code is burned. Small on purpose: a
 * person needs a handful of tries, an attacker guessing an 8-character code needs billions.
 */
export const DEVICE_CODE_ATTEMPTS = 10;
export const DEVICE_CODE_WINDOW_MS = 10 * 60 * 1000;
/** Limits for the unauthenticated device endpoints. */
export const DEVICE_LOOKUP_PER_IP = 20;

/** Static files in the parent `modules` directory (the device page's script and stylesheet). */
export function serveAsset(name: string, contentType: string, maxAgeSeconds: number): Response {
  // Resolved relative to this module, so `../` reaches the `modules` directory that holds the assets.
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  return new Response(readFileSync(path, "utf8"), {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${maxAgeSeconds}`,
      "x-content-type-options": "nosniff",
    },
  });
}

export const urlWith = (base: string, params: Record<string, string | null | undefined>) => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  return url.toString();
};

/** Public issuer for this request (ORBITID_BASE_URL, or a trusted proxy's forwarded scheme/host). */
export const requestIssuer = (ctx: AppContext, c: Context) => issuerFor(ctx, (name) => c.req.header(name));

export const handle = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.status === 401 && err.error === "invalid_client") {
        c.header("WWW-Authenticate", `Basic realm="orbitid", error="invalid_client", error_description="${err.message.replace(/"/g, "'")}"`);
      } else if (err.status === 401 && err.error === "invalid_token") {
        c.header("WWW-Authenticate", `Bearer realm="orbitid", error="invalid_token", error_description="${err.message.replace(/"/g, "'")}"`);
      }
      c.header("Cache-Control", "no-store");
      return c.json({ error: err.error, error_description: err.message }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
};

/** Endpoints a browser SPA calls directly; discovery and JWKS are public too. */
const CORS_PUBLIC = new Set([
  "/oauth/jwks", "/oauth/token", "/oauth/userinfo", "/oauth/revoke", "/oauth/introspect",
  "/oauth/device_authorization", "/oauth/end_session", "/.well-known/jwks.json",
]);
const isCorsPublic = (path: string) =>
  CORS_PUBLIC.has(path) || /(^|\/)\.well-known\/(openid-configuration|oauth-authorization-server)(\/.*)?$/.test(path);

/**
 * CORS for the OAuth/OIDC surface only. These endpoints authenticate with a bearer token (never a cookie), so a
 * wildcard origin is safe and lets browser SPAs read the token, userinfo and discovery responses. It is mounted
 * before the general Frontend API CORS policy and answers preflights itself.
 */
export const oidcCors: MiddlewareHandler = async (c, next) => {
  if (!isCorsPublic(c.req.path)) return next();
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  c.header("Access-Control-Max-Age", "600");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
};

export const tokenRequestSchema = z.object({
  grant_type: z.string().min(1),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  device_code: z.string().optional(),
});

export const deviceAuthorizationSchema = z.object({
  client_id: z.string().optional(),
  scope: z.string().optional(),
  client_secret: z.string().optional(),
});

const lifetime = (bounds: { min: number; max: number }) => z.number().int().min(bounds.min).max(bounds.max);

export const applicationSchema = z.object({
  name: z.string().min(1).max(256),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  post_logout_redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  public: z.boolean().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
  access_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.access).optional(),
  refresh_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.refresh).optional(),
  id_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.id).optional(),
  groups_claim: z.enum(GROUPS_CLAIM_MODES).optional(),
});
export const applicationPatchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  post_logout_redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
  access_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.access).optional(),
  refresh_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.refresh).optional(),
  id_token_lifetime_seconds: lifetime(LIFETIME_BOUNDS.id).optional(),
  groups_claim: z.enum(GROUPS_CLAIM_MODES).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

/** Full public authorize URL of the current request (used as `redirect_url` for the sign-in / consent screens). */
export const currentUrl = (ctx: AppContext, c: Context) => {
  const path = c.req.path.startsWith("/") ? c.req.path : `/${c.req.path}`;
  const query = new URL(c.req.url).search;
  return `${requestIssuer(ctx, c)}${path}${query}`;
};

/**
 * The authorize URL to come back to after sign-in. `prompt=login`/`select_account` and `max_age` are removed:
 * that visit already satisfied them, and leaving them would loop from the sign-in screen back to itself.
 * `prompt=consent` stays so the consent screen is still shown after a fresh sign-in.
 */
export function signInReturnUrl(ctx: AppContext, c: Context): string {
  const url = new URL(currentUrl(ctx, c));
  const prompts = (url.searchParams.get("prompt") ?? "").split(/\s+/).filter(Boolean)
    .filter((prompt) => prompt !== "login" && prompt !== "select_account");
  if (prompts.length) url.searchParams.set("prompt", prompts.join(" "));
  else url.searchParams.delete("prompt");
  url.searchParams.delete("max_age");
  return url.toString();
}

export const appBase = (ctx: AppContext) => ctx.settings.get().application.homeUrl.replace(/\/$/, "");

export const signInUrl = (ctx: AppContext, redirectUrl: string) =>
  urlWith(`${appBase(ctx)}/sign-in`, { redirect_url: redirectUrl });

export const consentUrl = (ctx: AppContext, appName: string, clientId: string, scope: string, authorizeUrl: string) =>
  urlWith(`${appBase(ctx)}/oauth-consent`, {
    client_id: clientId,
    client_name: appName,
    scope,
    redirect_url: authorizeUrl,
  });

/** Device verification URL; `verification_uri_complete` carries the code so the user only confirms. */
export const deviceVerificationUrl = (ctx: AppContext, issuer = ctx.env.baseUrl) => `${issuer.replace(/\/+$/, "")}/oauth/device`;

/**
 * Link to the app's sign-in screen that comes back to `target`. The instance origin is not necessarily one of
 * the app's allowed redirect origins, so an unusable `redirect_url` is dropped instead of breaking sign-in.
 */
export function signInLink(ctx: AppContext, target: string): string {
  try {
    const redirectUrl = validateRedirectUrl(ctx, target) ?? target;
    return signInUrl(ctx, redirectUrl);
  } catch {
    return signInUrl(ctx, appBase(ctx));
  }
}

export type AuthorizeResponseMode = "query" | "form_post";

/**
 * Returns the authorization response to the relying party. `query` is a redirect; `form_post` (used by
 * response_mode=form_post and required by some web apps) posts the parameters instead, with a nonce-protected
 * inline script and a CSP that allows the form to reach only the redirect URI's origin.
 */
export function authorizeResponse(c: Context, redirectUri: string, params: Record<string, string | null | undefined>, mode: AuthorizeResponseMode) {
  if (mode !== "form_post") return c.redirect(urlWith(redirectUri, params));
  const nonce = cspNonce();
  const inputs = Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] != null && entry[1] !== "")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const origin = new URL(redirectUri).origin;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue</title></head>` +
    `<body><form method="post" action="${escapeHtml(redirectUri)}">${inputs}` +
    `<noscript><button type="submit">Continue</button></noscript></form>` +
    `<script nonce="${nonce}">document.forms[0].submit()</script></body></html>`;
  return c.html(html, 200, {
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; form-action ${origin}; base-uri 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
  });
}
