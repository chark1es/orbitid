/** Constants, schemas, and helpers shared by the OAuth/OIDC routes. */
import { type Context } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { type AppContext } from "../../context";
import { validateRedirectUrl } from "../auth/redirects";
import { OAuthError } from "../../services/oidc";

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

export const handle = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof OAuthError) {
      if (err.error === "invalid_client") c.header("WWW-Authenticate", 'Basic realm="orbitid"');
      return c.json({ error: err.error, error_description: err.message }, err.status as ContentfulStatusCode);
    }
    throw err;
  }
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

export const applicationSchema = z.object({
  name: z.string().min(1).max(256),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  public: z.boolean().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
});
export const applicationPatchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

/** Full authorize URL of the current request (used as `redirect_url` for the sign-in / consent screens). */
export const currentUrl = (c: Context) => {
  const url = new URL(c.req.url);
  return url.toString();
};

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
export const deviceVerificationUrl = (ctx: AppContext) => `${ctx.env.baseUrl}/oauth/device`;

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
