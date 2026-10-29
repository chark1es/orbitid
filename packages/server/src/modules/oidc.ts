// OrbitID as OIDC/OAuth2 identity provider.
//   Discovery: /.well-known/openid-configuration
//   Protocol:  /oauth/{authorize,token,userinfo,revoke,introspect,jwks,device_authorization,device,consent_info,consent}
//              /oauth/device (server-rendered verification page) + /oauth/device.js (its script)
//              /oauth/m2m/token (machine-secret client_credentials; app.ts guards /v1/m2m with the secret key)
//   Frontend API for the device grant: /v1/client/oauth/device[/approve]
//   Management (secret key, guarded here because this module is mounted at "/"): /v1/oauth_applications
import { Hono, type Context } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { clientIp, parseBody, parsePagination } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { requireSecretKey } from "../middleware";
import { validateRedirectUrl } from "./auth/redirects";
import {
  accessGrantFromToken, assertRedirectUri, assertScopesAllowed, authenticateClient, burnDeviceCode,
  createApplication, createDeviceAuthorization, decideDeviceCode, deleteApplication, DEVICE_CODE_GRANT_TYPE,
  deviceApplication, discoveryDocument, exchangeAuthorizationCode, exchangeRefreshToken, findDeviceByUserCode,
  formatUserCode, getApplicationByClientId, hasConsent, introspectToken, issueAuthorizationCode, listApplications,
  normalizeUserCode, OAuthError, parseBasicAuthorization, parseScopes, pollDeviceCode, recordConsent, requireApplication,
  revokeToken, rotateClientSecret, SCOPE_DESCRIPTIONS, serializeApplication, storedConsent, updateApplication,
  userInfoClaims,
} from "../services/oidc";
import { authenticateMachineSecret, issueMachineToken, serializeMachineToken } from "../services/m2m";
import { getJwks } from "../services/tokens";
import { resolveCaller } from "./machine/auth";
import { devicePageHtml, deviceResultHtml, DEVICE_PAGE_CSP } from "./oidc-device-page";

/**
 * Attempts a single user code gets (per IP and per code) before the code is burned. Small on purpose: a
 * person needs a handful of tries, an attacker guessing an 8-character code needs billions.
 */
const DEVICE_CODE_ATTEMPTS = 10;
const DEVICE_CODE_WINDOW_MS = 10 * 60 * 1000;
/** Limits for the unauthenticated device endpoints. */
const DEVICE_LOOKUP_PER_IP = 20;

/** Static files next to this module (the device page's script and stylesheet). */
function serveAsset(name: string, contentType: string, maxAgeSeconds: number): Response {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  return new Response(readFileSync(path, "utf8"), {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${maxAgeSeconds}`,
      "x-content-type-options": "nosniff",
    },
  });
}

const urlWith = (base: string, params: Record<string, string | null | undefined>) => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  return url.toString();
};

const handle = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
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

const tokenRequestSchema = z.object({
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

const deviceAuthorizationSchema = z.object({
  client_id: z.string().optional(),
  scope: z.string().optional(),
  client_secret: z.string().optional(),
});

const applicationSchema = z.object({
  name: z.string().min(1).max(256),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  public: z.boolean().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
});
const applicationPatchSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  redirect_uris: z.array(z.string().url()).max(50).optional(),
  scopes: z.string().optional(),
  consent_screen_enabled: z.boolean().optional(),
  pkce_required: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

/** Full authorize URL of the current request (used as `redirect_url` for the sign-in / consent screens). */
const currentUrl = (c: Context) => {
  const url = new URL(c.req.url);
  return url.toString();
};

const appBase = (ctx: AppContext) => ctx.settings.get().application.homeUrl.replace(/\/$/, "");

const signInUrl = (ctx: AppContext, redirectUrl: string) =>
  urlWith(`${appBase(ctx)}/sign-in`, { redirect_url: redirectUrl });

const consentUrl = (ctx: AppContext, appName: string, clientId: string, scope: string, authorizeUrl: string) =>
  urlWith(`${appBase(ctx)}/oauth-consent`, {
    client_id: clientId,
    client_name: appName,
    scope,
    redirect_url: authorizeUrl,
  });

/** Device verification URL; `verification_uri_complete` carries the code so the user only confirms. */
const deviceVerificationUrl = (ctx: AppContext) => `${ctx.env.baseUrl}/oauth/device`;

/**
 * Link to the app's sign-in screen that comes back to `target`. The instance origin is not necessarily one of
 * the app's allowed redirect origins, so an unusable `redirect_url` is dropped instead of breaking sign-in.
 */
function signInLink(ctx: AppContext, target: string): string {
  try {
    const redirectUrl = validateRedirectUrl(ctx, target) ?? target;
    return signInUrl(ctx, redirectUrl);
  } catch {
    return signInUrl(ctx, appBase(ctx));
  }
}

export default function routes(ctx: AppContext) {
  const app = new Hono();
  const deviceEnabled = () => ctx.settings.get().oidcProvider.deviceAuthorizationEnabled;

  // ─────────── discovery + JWKS ───────────
  app.get("/.well-known/openid-configuration", (c) => c.json(discoveryDocument(ctx)));
  app.get("/oauth/jwks", async (c) => c.json(await getJwks(ctx)));

  // ─────────── authorize ───────────
  app.get("/oauth/authorize", handle(async (c) => {
    const q = c.req.query();
    const appRow = await getApplicationByClientId(ctx, q.client_id ?? "");
    if (!appRow) return c.json({ error: "invalid_request", error_description: "Unknown client_id" }, 400);

    let redirectUri: string;
    try {
      redirectUri = assertRedirectUri(appRow, q.redirect_uri);
    } catch (err) {
      return c.json({ error: "invalid_request", error_description: (err as Error).message }, 400);
    }

    const state = q.state ?? null;
    const fail = (error: string, description: string) =>
      c.redirect(urlWith(redirectUri, { error, error_description: description, state }));

    if ((q.response_type ?? "") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");

    const scopes = parseScopes(q.scope || "openid");
    try {
      assertScopesAllowed(appRow, scopes);
    } catch (err) {
      return fail("invalid_scope", (err as Error).message);
    }

    const pkceRequired = appRow.isPublic || appRow.pkceRequired;
    const codeChallenge = q.code_challenge ?? null;
    const codeChallengeMethod = q.code_challenge_method ?? (codeChallenge ? "S256" : null);
    if (pkceRequired && !codeChallenge) return fail("invalid_request", "code_challenge is required (PKCE, S256)");
    if (codeChallenge && codeChallengeMethod !== "S256") return fail("invalid_request", "Only code_challenge_method=S256 is supported");

    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) {
      if (q.prompt === "none") return fail("login_required", "The user is not signed in");
      return c.redirect(signInUrl(ctx, currentUrl(c)));
    }

    const prompt = q.prompt ?? "";
    const needsConsent = appRow.consentScreenEnabled && (prompt === "consent" || !await hasConsent(ctx, appRow.id, caller.userId, scopes));
    if (needsConsent && prompt === "none") return fail("consent_required", "The user has not consented to this request");
    if (needsConsent) return c.redirect(consentUrl(ctx, appRow.name, appRow.clientId, scopes.join(" "), currentUrl(c)));

    const code = await issueAuthorizationCode(ctx, {
          application: appRow,
          userId: caller.userId,
          scopes,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          nonce: q.nonce ?? null,
          sessionId: caller.sessionId,
        });
    return c.redirect(urlWith(redirectUri, { code, state }));
  }));

  // ─────────── consent screen data + decision ───────────
  app.get("/oauth/consent_info", handle(async (c) => {
    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
    const clientId = c.req.query("client_id") ?? "";
    const appRow = await getApplicationByClientId(ctx, clientId);
    if (!appRow) throw new OrbitError(404, ErrorCodes.resource_not_found, "OAuth application not found");
    const requested = parseScopes(c.req.query("scope") || "openid");
    const scopes = requested.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] ?? `Access to ${scope}` }));
    const previouslyApproved = await storedConsent(ctx, appRow.id, caller.userId);
    return c.json({
      client: { id: appRow.id, client_id: appRow.clientId, name: appRow.name, logo_url: null, public: appRow.isPublic },
      scopes,
      previously_approved: previouslyApproved ?? [],
      redirect_url: c.req.query("redirect_url") ?? null,
    });
  }));

  const consentBodySchema = z.object({
    client_id: z.string().min(1),
    approve: z.boolean(),
    scopes: z.array(z.string()).optional(),
    scope: z.string().optional(),
    redirect_uri: z.string().optional(),
    state: z.string().nullable().optional(),
    response_type: z.string().optional(),
    nonce: z.string().nullable().optional(),
    code_challenge: z.string().nullable().optional(),
    code_challenge_method: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
  });

  app.post("/oauth/consent", handle(async (c) => {
    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
    const body = await parseBody(c, consentBodySchema);
    const appRow = await getApplicationByClientId(ctx, body.client_id);
    if (!appRow) throw new OrbitError(404, ErrorCodes.resource_not_found, "OAuth application not found");
    const redirectUri = assertRedirectUri(appRow, body.redirect_uri);

    let scopes: string[];
    try {
      scopes = assertScopesAllowed(appRow, body.scopes && body.scopes.length ? body.scopes : parseScopes(body.scope || "openid"));
    } catch (err) {
      const description = (err as Error).message;
      return c.json({ redirect_url: urlWith(redirectUri, { error: "invalid_scope", error_description: description, state: body.state ?? null }) });
    }

    const state = body.state ?? null;
    if (!body.approve) {
      return c.json({ redirect_url: urlWith(redirectUri, { error: "access_denied", error_description: "The user denied the request", state }) });
    }
    await recordConsent(ctx, appRow.id, caller.userId, scopes);
    const code = await issueAuthorizationCode(ctx, {
          application: appRow,
          userId: caller.userId,
          scopes,
          redirectUri,
          codeChallenge: body.code_challenge ?? null,
          codeChallengeMethod: body.code_challenge_method ?? null,
          nonce: body.nonce ?? null,
          sessionId: caller.sessionId,
        });
    return c.json({ redirect_url: urlWith(redirectUri, { code, state }) });
  }));

  // ─────────── token ───────────
  app.post("/oauth/token", handle(async (c) => {
    const body = await parseBody(c, tokenRequestSchema);
    const appRow = await authenticateClient(ctx, {
          authorization: c.req.header("authorization"),
          clientId: body.client_id,
          clientSecret: body.client_secret,
        });
    if (body.grant_type === "authorization_code") {
      if (!body.code) throw new OAuthError(400, "invalid_request", "code is required");
      const tokens = await exchangeAuthorizationCode(ctx, {
        application: appRow,
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
      });
      return c.json(tokens);
    }
    if (body.grant_type === "refresh_token") {
      if (!body.refresh_token) throw new OAuthError(400, "invalid_request", "refresh_token is required");
      const tokens = await exchangeRefreshToken(ctx, appRow, body.refresh_token);
      return c.json(tokens);
    }
    if (body.grant_type === DEVICE_CODE_GRANT_TYPE) {
      if (!deviceEnabled()) throw new OAuthError(400, "unsupported_grant_type", `Unsupported grant_type: ${body.grant_type}`);
      if (!body.device_code) throw new OAuthError(400, "invalid_request", "device_code is required");
      const result = await pollDeviceCode(ctx, appRow, body.device_code);
      if (!result.ok) {
        if (result.intervalSeconds) c.header("Retry-After", String(result.intervalSeconds));
        throw new OAuthError(400, result.error, result.description);
      }
      return c.json(result.tokens);
    }
    throw new OAuthError(400, "unsupported_grant_type", `Unsupported grant_type: ${body.grant_type}`);
  }));

  // ─────────── userinfo ───────────
  const userinfo = handle(async (c) => {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (c.req.method === "GET" ? c.req.query("access_token") ?? "" : "");
    if (!bearer) {
      c.header("WWW-Authenticate", 'Bearer realm="orbitid"');
      throw new OAuthError(401, "invalid_token", "An access token is required");
    }
    const { row, user } = await accessGrantFromToken(ctx, bearer);
    return c.json(await userInfoClaims(ctx, row, user));
  });
  app.get("/oauth/userinfo", userinfo);
  app.post("/oauth/userinfo", userinfo);

  // ─────────── revocation (RFC 7009) ───────────
  app.post("/oauth/revoke", handle(async (c) => {
    const body = await parseBody(c, z.object({
      token: z.string().min(1),
      token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
    }));
    const appRow = await authenticateClient(ctx, {
          authorization: c.req.header("authorization"),
          clientId: body.client_id,
          clientSecret: body.client_secret,
        });
    await revokeToken(ctx, appRow, body.token);
    return c.body(null, 200);
  }));

  // ─────────── introspection (RFC 7662) ───────────
  app.post("/oauth/introspect", handle(async (c) => {
    const body = await parseBody(c, z.object({
      token: z.string().min(1),
      token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
    }));
    const appRow = await authenticateClient(ctx, {
          authorization: c.req.header("authorization"),
          clientId: body.client_id,
          clientSecret: body.client_secret,
        });
    // Public clients cannot introspect: RFC 7662 requires confidential client authentication.
    if (appRow.isPublic) throw new OAuthError(401, "invalid_client", "Public clients cannot introspect tokens");
    return c.json(await introspectToken(ctx, appRow, body.token));
  }));

  // ─────────── device authorization grant (RFC 8628) ───────────
  app.post("/oauth/device_authorization", handle(async (c) => {
    if (!deviceEnabled()) throw new OrbitError(404, ErrorCodes.resource_not_found, "Route not found");
    await hit(ctx, `oauth-device-authorization:${clientIp(c)}`, 30, 60 * 60 * 1000);
    const body = await parseBody(c, deviceAuthorizationSchema);
    const appRow = await authenticateClient(ctx, {
          authorization: c.req.header("authorization"),
          clientId: body.client_id,
          clientSecret: body.client_secret,
        });
    const scopes = assertScopesAllowed(appRow, parseScopes(body.scope || "openid"));
    const created = await createDeviceAuthorization(ctx, { application: appRow, scopes });
    const verificationUri = deviceVerificationUrl(ctx);
    return c.json({
      device_code: created.deviceCode,
      user_code: formatUserCode(created.row.userCode),
      verification_uri: verificationUri,
      verification_uri_complete: urlWith(verificationUri, { user_code: formatUserCode(created.row.userCode) }),
      expires_in: created.expiresInSeconds,
      interval: created.intervalSeconds,
    });
  }));

  // ─────────── device verification page (verification_uri) ───────────
  /** Counts one user-code attempt per IP and per submitted code; burning the code once its own budget runs out. */
  const countDeviceAttempt = async (c: Context, rawUserCode: string) => {
    await hit(ctx, `oauth-device:ip:${clientIp(c)}`, DEVICE_LOOKUP_PER_IP, DEVICE_CODE_WINDOW_MS);
    // Only a well-formed code gets a per-code counter: an arbitrary string must not become a rate-limit key.
    const userCode = normalizeUserCode(rawUserCode);
    if (!userCode) return;
    try {
      await hit(ctx, `oauth-device:code:${userCode}`, DEVICE_CODE_ATTEMPTS, DEVICE_CODE_WINDOW_MS);
    } catch (err) {
      // Only the per-code budget burns the code: a noisy IP must not be able to cancel someone's approval.
      const row = await findDeviceByUserCode(ctx, userCode);
      if (row) await burnDeviceCode(ctx, row);
      throw err;
    }
  };

  const productName = () => ctx.settings.get().application.name;
  const renderPage = (c: Context, input: Parameters<typeof devicePageHtml>[0]) => {
    const html = devicePageHtml(input, productName());
    return c.html(html, 200, {
      "content-security-policy": DEVICE_PAGE_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
  };

  const deviceState = async (c: Context, rawCode: string | undefined) => {
    const caller = await resolveCaller(ctx, c);
    const code = rawCode ? normalizeUserCode(rawCode) : null;
    const signedIn = !!caller?.userId;
    // Back to this page (on the instance origin) after signing in, so the code survives the round trip.
    const pageUrl = urlWith(deviceVerificationUrl(ctx), { user_code: code ? formatUserCode(code) : null });
    const signInHref = signInLink(ctx, pageUrl);
    if (!code) return { signedIn, signInHref, code: null as string | null, appName: null as string | null, scopes: [] as string[], state: "enter_code" as const };
    const row = await findDeviceByUserCode(ctx, code);
    if (!row) return { signedIn, signInHref, code, appName: null, scopes: [], state: "not_found" as const };
    if (row.expiresAt <= Date.now()) return { signedIn, signInHref, code, appName: null, scopes: [], state: "expired" as const };
    const application = await deviceApplication(ctx, row);
    const scopes = parseScopes(row.scopes);
    if (row.status !== "pending") {
      return { signedIn, signInHref, code, appName: application?.name ?? null, scopes, state: "already_decided" as const };
    }
    if (!signedIn) {
      return { signedIn, signInHref, code, appName: application?.name ?? null, scopes, state: "sign_in_required" as const };
    }
    return { signedIn, signInHref, code, appName: application?.name ?? null, scopes, scopesWithDescriptions: scopes.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] ?? `Access to ${s}` })), state: "consent" as const };
  };

  const devicePage = async (c: Context) => {
    if (!deviceEnabled()) return c.notFound();
    const raw = c.req.query("user_code");
    if (raw) {
      try {
        await countDeviceAttempt(c, raw);
      } catch (err) {
        if (err instanceof OrbitError && err.status === 429) {
          return c.html(deviceResultHtml("too_many_attempts", undefined, productName()), 429, { "content-security-policy": DEVICE_PAGE_CSP, "cache-control": "no-store" });
        }
        throw err;
      }
    }
    return renderPage(c, await deviceState(c, raw));
  };

  app.get("/oauth/device", handle(devicePage));

  app.post("/oauth/device", handle(async (c) => {
    if (!deviceEnabled()) return c.notFound();
    // Same-origin only: a cross-site form post must not be able to approve a code its author created.
    const origin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite === "cross-site" || (origin && origin !== new URL(ctx.env.baseUrl).origin)) {
      return c.html(deviceResultHtml("cross_site", undefined, productName()), 403, {
        "content-security-policy": DEVICE_PAGE_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer",
      });
    }
    const form = await c.req.parseBody();
    const rawCode = typeof form.user_code === "string" ? form.user_code : "";
    const action = form.action === "deny" ? "deny" : form.action === "approve" ? "approve" : null;
    const caller = await resolveCaller(ctx, c);
    const code = normalizeUserCode(rawCode);
    if (!action || !code) return renderPage(c, await deviceState(c, rawCode));
    if (!caller?.userId) return renderPage(c, await deviceState(c, rawCode));
    try {
      await countDeviceAttempt(c, code);
    } catch (err) {
      if (err instanceof OrbitError && err.status === 429) {
        return c.html(deviceResultHtml("too_many_attempts", undefined, productName()), 429, { "content-security-policy": DEVICE_PAGE_CSP, "cache-control": "no-store" });
      }
      throw err;
    }
    const decision = await decideDeviceCode(ctx, { userCode: code, userId: caller.userId, approve: action === "approve" });
    if (!decision.ok) return renderPage(c, await deviceState(c, rawCode));
    return c.html(deviceResultHtml(action === "approve" ? "approved" : "denied", decision.application.name, productName()), 200, {
      "content-security-policy": DEVICE_PAGE_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
  }));

  app.get("/oauth/device.js", (c) => {
    if (!deviceEnabled()) return c.notFound();
    return serveAsset("oidc-device.js", "text/javascript; charset=utf-8", 3600);
  });

  app.get("/oauth/device.css", (c) => {
    if (!deviceEnabled()) return c.notFound();
    return serveAsset("oidc-device.css", "text/css; charset=utf-8", 3600);
  });

  // ─────────── Frontend API for the device grant ───────────
  app.get("/v1/client/oauth/device", handle(async (c) => {
    if (!deviceEnabled()) throw new OrbitError(404, ErrorCodes.resource_not_found, "Route not found");
    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
    const raw = c.req.query("user_code") ?? "";
    const code = normalizeUserCode(raw);
    if (!code) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "user_code must look like ABCD-EFGH", { param_name: "user_code" });
    await countDeviceAttempt(c, code);
    const row = await findDeviceByUserCode(ctx, code);
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "That code is not valid");
    if (row.expiresAt <= Date.now()) throw new OrbitError(410, ErrorCodes.verification_expired, "That code has expired");
    const application = await deviceApplication(ctx, row);
    if (!application) throw new OrbitError(404, ErrorCodes.resource_not_found, "OAuth application not found");
    const scopes = parseScopes(row.scopes);
    return c.json({
      user_code: formatUserCode(row.userCode),
      status: row.status,
      expires_at: row.expiresAt,
      client: { id: application.id, client_id: application.clientId, name: application.name, public: application.isPublic },
      scopes: scopes.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] ?? `Access to ${scope}` })),
    });
  }));

  app.post("/v1/client/oauth/device/approve", handle(async (c) => {
    if (!deviceEnabled()) throw new OrbitError(404, ErrorCodes.resource_not_found, "Route not found");
    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
    const body = await parseBody(c, z.object({ user_code: z.string().min(1), action: z.enum(["approve", "deny"]) }));
    const code = normalizeUserCode(body.user_code);
    if (!code) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "user_code must look like ABCD-EFGH", { param_name: "user_code" });
    await countDeviceAttempt(c, code);
    const decision = await decideDeviceCode(ctx, { userCode: code, userId: caller.userId, approve: body.action === "approve" });
    if (!decision.ok) {
      if (decision.reason === "not_found") throw new OrbitError(404, ErrorCodes.resource_not_found, "That code is not valid");
      if (decision.reason === "expired") throw new OrbitError(410, ErrorCodes.verification_expired, "That code has expired");
      throw new OrbitError(409, ErrorCodes.verification_failed, "That code has already been used");
    }
    return c.json({
      object: "oauth_device_authorization",
      user_code: formatUserCode(code),
      status: body.action === "approve" ? "approved" : "denied",
      client: { id: decision.application.id, client_id: decision.application.clientId, name: decision.application.name },
      scopes: decision.scopes,
    });
  }));

  // ─────────── machine tokens (client_credentials, machine secret) ───────────
  // app.ts denies non-secret-key callers on /v1/m2m, so machines mint tokens here.
  app.post("/oauth/m2m/token", handle(async (c) => {
    const body = await parseBody(c, z.object({
      grant_type: z.string().optional(),
      machine_id: z.string().optional(),
      machine_secret: z.string().optional(),
      seconds_until_expiration: z.coerce.number().int().positive().optional(),
      claims: z.union([z.record(z.string(), z.unknown()), z.string()]).nullable().optional(),
      token_format: z.enum(["opaque", "jwt"]).optional(),
    }));
    if (body.grant_type && body.grant_type !== "client_credentials") {
      throw new OAuthError(400, "unsupported_grant_type", "Only client_credentials is supported");
    }
    const basic = parseBasicAuthorization(c.req.header("authorization"));
    const machineId = basic?.clientId ?? body.machine_id;
    const machineSecret = basic?.clientSecret ?? body.machine_secret;
    if (!machineId || !machineSecret) throw new OAuthError(401, "invalid_client", "machine_id and machine_secret are required");
    const machine = await authenticateMachineSecret(ctx, machineSecret);
    if (!machine || machine.id !== machineId) throw new OAuthError(401, "invalid_client", "Machine authentication failed");
    let claims: Record<string, unknown> | null = null;
    if (typeof body.claims === "string") {
      try {
        claims = JSON.parse(body.claims) as Record<string, unknown>;
      } catch {
        throw new OAuthError(400, "invalid_request", "claims must be a JSON object");
      }
    } else if (body.claims) {
      claims = body.claims;
    }
    const { row, token } = await issueMachineToken(ctx, machine, {
      secondsUntilExpiration: body.seconds_until_expiration ?? null,
      claims,
      tokenFormat: body.token_format ?? "opaque",
    });
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.round(((row.expiresAt ?? Date.now()) - Date.now()) / 1000)),
      token_format: body.token_format ?? "opaque",
      machine_token: serializeMachineToken(row),
      scope: (machine.scopedMachines ?? []).join(" "),
    });
  }));

  // ─────────── management API (secret key) ───────────
  const guard = requireSecretKey(ctx);
  app.use("/v1/oauth_applications", guard);
  app.use("/v1/oauth_applications/*", guard);

  app.post("/v1/oauth_applications", async (c) => {
    const body = await parseBody(c, applicationSchema);
    const { row, clientSecret } = await createApplication(ctx, {
          name: body.name,
          redirectUris: body.redirect_uris,
          scopes: body.scopes,
          isPublic: body.public,
          consentScreenEnabled: body.consent_screen_enabled,
          pkceRequired: body.pkce_required,
        });
    return c.json(serializeApplication(row, { clientSecret }), 201);
  });

  app.get("/v1/oauth_applications", async (c) => {
    const page = parsePagination(c);
    const { data, totalCount } = await listApplications(ctx, { limit: page.limit, offset: page.offset });
    return c.json({ data: data.map((r) => serializeApplication(r)), total_count: totalCount });
  });

  app.get("/v1/oauth_applications/:id", async (c) => c.json(serializeApplication(await requireApplication(ctx, c.req.param("id")))));

  app.patch("/v1/oauth_applications/:id", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    const body = await parseBody(c, applicationPatchSchema);
    return c.json(serializeApplication(await updateApplication(ctx, row, {
              name: body.name,
              redirectUris: body.redirect_uris,
              scopes: body.scopes,
              consentScreenEnabled: body.consent_screen_enabled,
              pkceRequired: body.pkce_required,
            })));
  });

  app.delete("/v1/oauth_applications/:id", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    await deleteApplication(ctx, row);
    return c.json({ object: "oauth_application", id: row.id, deleted: true });
  });

  app.post("/v1/oauth_applications/:id/rotate_secret", async (c) => {
    const row = await requireApplication(ctx, c.req.param("id"));
    const { row: updated, clientSecret } = await rotateClientSecret(ctx, row);
    return c.json(serializeApplication(updated, { clientSecret }));
  });

  return app;
}
