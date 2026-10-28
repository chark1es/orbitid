// OrbitID as OIDC/OAuth2 identity provider.
//   Discovery: /.well-known/openid-configuration
//   Protocol:  /oauth/{authorize,token,userinfo,revoke,introspect,jwks,consent_info,consent}
//              /oauth/m2m/token (machine-secret client_credentials; app.ts guards /v1/m2m with the secret key)
//   Management (secret key, guarded here because this module is mounted at "/"): /v1/oauth_applications
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { parseBody, parsePagination } from "../lib/http";
import { requireSecretKey } from "../middleware";
import {
  assertRedirectUri, assertScopesAllowed, authenticateClient, createApplication, deleteApplication,
  discoveryDocument, exchangeAuthorizationCode, exchangeRefreshToken, getApplicationByClientId, hasConsent, introspectToken,
  issueAuthorizationCode, listApplications, OAuthError, parseBasicAuthorization, parseScopes,
  recordConsent, requireApplication, revokeToken, rotateClientSecret, SCOPE_DESCRIPTIONS, serializeApplication,
  storedConsent, updateApplication, accessGrantFromToken, userInfoClaims,
} from "../services/oidc";
import { authenticateMachineSecret, issueMachineToken, serializeMachineToken } from "../services/m2m";
import { getJwks } from "../services/tokens";
import { resolveCaller } from "./machine/auth";

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

const signInUrl = (ctx: AppContext, authorizeUrl: string) =>
  urlWith(`${ctx.settings.get().application.homeUrl.replace(/\/$/, "")}/sign-in`, { redirect_url: authorizeUrl });

const consentUrl = (ctx: AppContext, appName: string, clientId: string, scope: string, authorizeUrl: string) =>
  urlWith(`${ctx.settings.get().application.homeUrl.replace(/\/$/, "")}/oauth-consent`, {
    client_id: clientId,
    client_name: appName,
    scope,
    redirect_url: authorizeUrl,
  });

export default function routes(ctx: AppContext) {
  const app = new Hono();

  // ─────────── discovery + JWKS ───────────
  app.get("/.well-known/openid-configuration", (c) => c.json(discoveryDocument(ctx)));
  app.get("/oauth/jwks", async (c) => c.json(await getJwks(ctx)));

  // ─────────── authorize ───────────
  app.get("/oauth/authorize", handle(async (c) => {
    const q = c.req.query();
    const appRow = getApplicationByClientId(ctx, q.client_id ?? "");
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
    const needsConsent = appRow.consentScreenEnabled && (prompt === "consent" || !hasConsent(ctx, appRow.id, caller.userId, scopes));
    if (needsConsent && prompt === "none") return fail("consent_required", "The user has not consented to this request");
    if (needsConsent) return c.redirect(consentUrl(ctx, appRow.name, appRow.clientId, scopes.join(" "), currentUrl(c)));

    const code = issueAuthorizationCode(ctx, {
      application: appRow,
      userId: caller.userId,
      scopes,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      nonce: q.nonce ?? null,
    });
    return c.redirect(urlWith(redirectUri, { code, state }));
  }));

  // ─────────── consent screen data + decision ───────────
  app.get("/oauth/consent_info", handle(async (c) => {
    const caller = await resolveCaller(ctx, c);
    if (!caller?.userId) throw new OrbitError(401, ErrorCodes.authentication_invalid, "Authentication invalid. Please sign in again.");
    const clientId = c.req.query("client_id") ?? "";
    const appRow = getApplicationByClientId(ctx, clientId);
    if (!appRow) throw new OrbitError(404, ErrorCodes.resource_not_found, "OAuth application not found");
    const requested = parseScopes(c.req.query("scope") || "openid");
    const scopes = requested.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] ?? `Access to ${scope}` }));
    const previouslyApproved = storedConsent(ctx, appRow.id, caller.userId);
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
    const appRow = getApplicationByClientId(ctx, body.client_id);
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
    recordConsent(ctx, appRow.id, caller.userId, scopes);
    const code = issueAuthorizationCode(ctx, {
      application: appRow,
      userId: caller.userId,
      scopes,
      redirectUri,
      codeChallenge: body.code_challenge ?? null,
      codeChallengeMethod: body.code_challenge_method ?? null,
      nonce: body.nonce ?? null,
    });
    return c.json({ redirect_url: urlWith(redirectUri, { code, state }) });
  }));

  // ─────────── token ───────────
  app.post("/oauth/token", handle(async (c) => {
    const body = await parseBody(c, tokenRequestSchema);
    const appRow = authenticateClient(ctx, {
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
    throw new OAuthError(400, "unsupported_grant_type", `Unsupported grant_type: ${body.grant_type}`);
  }));

  // ─────────── userinfo ───────────
  app.get("/oauth/userinfo", handle((c) => {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (c.req.query("access_token") ?? "");
    if (!bearer) {
      c.header("WWW-Authenticate", 'Bearer realm="orbitid"');
      throw new OAuthError(401, "invalid_token", "An access token is required");
    }
    const { row, user } = accessGrantFromToken(ctx, bearer);
    return c.json(userInfoClaims(ctx, row, user));
  }));
  app.post("/oauth/userinfo", handle((c) => {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!bearer) {
      c.header("WWW-Authenticate", 'Bearer realm="orbitid"');
      throw new OAuthError(401, "invalid_token", "An access token is required");
    }
    const { row, user } = accessGrantFromToken(ctx, bearer);
    return c.json(userInfoClaims(ctx, row, user));
  }));

  // ─────────── revocation (RFC 7009) ───────────
  app.post("/oauth/revoke", handle(async (c) => {
    const body = await parseBody(c, z.object({
      token: z.string().min(1),
      token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
    }));
    const appRow = authenticateClient(ctx, {
      authorization: c.req.header("authorization"),
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
    revokeToken(ctx, appRow, body.token);
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
    const appRow = authenticateClient(ctx, {
      authorization: c.req.header("authorization"),
      clientId: body.client_id,
      clientSecret: body.client_secret,
    });
    return c.json(introspectToken(ctx, appRow, body.token));
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
    const machine = authenticateMachineSecret(ctx, machineSecret);
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
    const { row, clientSecret } = createApplication(ctx, {
      name: body.name,
      redirectUris: body.redirect_uris,
      scopes: body.scopes,
      isPublic: body.public,
      consentScreenEnabled: body.consent_screen_enabled,
      pkceRequired: body.pkce_required,
    });
    return c.json(serializeApplication(row, { clientSecret }), 201);
  });

  app.get("/v1/oauth_applications", (c) => {
    const page = parsePagination(c);
    const { data, totalCount } = listApplications(ctx, { limit: page.limit, offset: page.offset });
    return c.json({ data: data.map((r) => serializeApplication(r)), total_count: totalCount });
  });

  app.get("/v1/oauth_applications/:id", (c) => c.json(serializeApplication(requireApplication(ctx, c.req.param("id")))));

  app.patch("/v1/oauth_applications/:id", async (c) => {
    const row = requireApplication(ctx, c.req.param("id"));
    const body = await parseBody(c, applicationPatchSchema);
    return c.json(serializeApplication(updateApplication(ctx, row, {
      name: body.name,
      redirectUris: body.redirect_uris,
      scopes: body.scopes,
      consentScreenEnabled: body.consent_screen_enabled,
      pkceRequired: body.pkce_required,
    })));
  });

  app.delete("/v1/oauth_applications/:id", (c) => {
    const row = requireApplication(ctx, c.req.param("id"));
    deleteApplication(ctx, row);
    return c.json({ object: "oauth_application", id: row.id, deleted: true });
  });

  app.post("/v1/oauth_applications/:id/rotate_secret", (c) => {
    const row = requireApplication(ctx, c.req.param("id"));
    const { row: updated, clientSecret } = rotateClientSecret(ctx, row);
    return c.json(serializeApplication(updated, { clientSecret }));
  });

  return app;
}
