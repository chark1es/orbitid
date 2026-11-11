/** OpenID discovery, JWKS, authorize, and consent routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import {
  SCOPE_DESCRIPTIONS, assertRedirectUri, assertScopesAllowed, discoveryDocument, getApplicationByClientId, hasConsent,
  issueAuthorizationCode, parseScopes, recordConsent, storedConsent,
} from "../../services/oidc";
import { sessionAuthTime } from "../../services/oidc/claims";
import { getUserByIdentifier } from "../../services/users";
import { getJwks } from "../../services/tokens";
import { resolveCaller } from "../machine/auth";
import {
  urlWith, handle, currentUrl, signInUrl, signInReturnUrl, consentUrl, requestIssuer, authorizeResponse,
  type AuthorizeResponseMode,
} from "./shared";

// `oauth-authorization-server` also accepts RFC 8414's issuer-path suffix (`.well-known/oauth-authorization-server/<path>`).
const DISCOVERY_PATH = /(^|\/)\.well-known\/(openid-configuration|oauth-authorization-server)(\/.*)?$/;

export function registerDiscoveryRoutes(app: Hono, ctx: AppContext) {
  // ─────────── discovery + JWKS ───────────
  const discovery = (c: Parameters<typeof requestIssuer>[1]) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(discoveryDocument(ctx, requestIssuer(ctx, c)));
  };
  app.get("/.well-known/openid-configuration", discovery);
  app.get("/.well-known/oauth-authorization-server", discovery);
  // Some clients derive `https://issuer/<path>/.well-known/openid-configuration` from a path-bearing issuer.
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" || !DISCOVERY_PATH.test(c.req.path)) return next();
    return discovery(c);
  });
  app.get("/oauth/jwks", async (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(await getJwks(ctx));
  });

  // ─────────── authorize ───────────
  app.get("/oauth/authorize", handle(async (c) => {
    const q = c.req.query();
    const issuer = requestIssuer(ctx, c);
    const appRow = await getApplicationByClientId(ctx, q.client_id ?? "");
    if (!appRow) return c.json({ error: "invalid_request", error_description: "Unknown client_id" }, 400);

    let redirectUri: string;
    try {
      redirectUri = assertRedirectUri(appRow, q.redirect_uri);
    } catch (err) {
      // Never redirect to an unregistered URI: the error is returned to the caller instead.
      return c.json({ error: "invalid_request", error_description: (err as Error).message }, 400);
    }

    let responseMode: AuthorizeResponseMode = "query";
    if (q.response_mode !== undefined && q.response_mode !== "") {
      if (q.response_mode !== "query" && q.response_mode !== "form_post") {
        return c.json({ error: "unsupported_response_mode", error_description: "response_mode must be query or form_post" }, 400);
      }
      responseMode = q.response_mode;
    }

    const state = q.state ?? null;
    const fail = (error: string, description: string) =>
      authorizeResponse(c, redirectUri, { error, error_description: description, state }, responseMode);

    if ((q.response_type ?? "") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");

    const prompts = new Set((q.prompt ?? "").split(/\s+/).filter(Boolean));
    if (prompts.has("none") && prompts.size > 1) return fail("invalid_request", "prompt=none cannot be combined with other prompt values");
    let maxAge: number | null = null;
    if (q.max_age !== undefined && q.max_age !== "") {
      const parsed = Number(q.max_age);
      if (!Number.isInteger(parsed) || parsed < 0) return fail("invalid_request", "max_age must be a non-negative integer");
      maxAge = parsed;
    }

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
    const toSignIn = () => {
      const url = new URL(signInUrl(ctx, signInReturnUrl(ctx, c)));
      if (q.login_hint) url.searchParams.set("login_hint", q.login_hint);
      if (prompts.has("select_account")) url.searchParams.set("prompt", "select_account");
      return url.toString();
    };
    const reauthenticate = prompts.has("login") || prompts.has("select_account");
    if (!caller?.userId || reauthenticate) {
      if (prompts.has("none")) return fail("login_required", "The user is not signed in");
      return c.redirect(toSignIn());
    }

    // A hint that names a different account means the current session is not the one the client wants.
    if (q.login_hint) {
      const hinted = await getUserByIdentifier(ctx, q.login_hint);
      if (hinted && hinted.user.id !== caller.userId) {
        if (prompts.has("none")) return fail("login_required", "The requested account is not signed in");
        return c.redirect(toSignIn());
      }
    }

    if (maxAge !== null) {
      const authTime = await sessionAuthTime(ctx, caller.sessionId);
      const now = Math.floor(Date.now() / 1000);
      if (authTime === null || now - authTime > maxAge) {
        if (prompts.has("none")) return fail("login_required", "The user must sign in again (max_age)");
        return c.redirect(toSignIn());
      }
    }

    const needsConsent = appRow.consentScreenEnabled && (prompts.has("consent") || !await hasConsent(ctx, appRow.id, caller.userId, scopes));
    if (needsConsent && prompts.has("none")) return fail("consent_required", "The user has not consented to this request");
    if (needsConsent) return c.redirect(consentUrl(ctx, appRow.name, appRow.clientId, scopes.join(" "), currentUrl(ctx, c)));

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
    return authorizeResponse(c, redirectUri, { code, state, iss: issuer }, responseMode);
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
    response_mode: z.string().nullable().optional(),
    nonce: z.string().nullable().optional(),
    code_challenge: z.string().nullable().optional(),
    code_challenge_method: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    max_age: z.string().nullable().optional(),
    login_hint: z.string().nullable().optional(),
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
    return c.json({ redirect_url: urlWith(redirectUri, { code, state, iss: requestIssuer(ctx, c) }) });
  }));
}
