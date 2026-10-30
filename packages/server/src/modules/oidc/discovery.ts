/** OpenID discovery, JWKS, authorize, and consent routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../lib/http";
import { SCOPE_DESCRIPTIONS, assertRedirectUri, assertScopesAllowed, discoveryDocument, getApplicationByClientId, hasConsent, issueAuthorizationCode, parseScopes, recordConsent, storedConsent } from "../../services/oidc";
import { getJwks } from "../../services/tokens";
import { resolveCaller } from "../machine/auth";
import { urlWith, handle, currentUrl, signInUrl, consentUrl } from "./shared";

export function registerDiscoveryRoutes(app: Hono, ctx: AppContext) {
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
}
