/** Token, userinfo, revocation, and introspection routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { parseBody } from "../../lib/http";
import { DEVICE_CODE_GRANT_TYPE, OAuthError, accessGrantFromToken, authenticateClient, exchangeAuthorizationCode, exchangeRefreshToken, introspectToken, pollDeviceCode, revokeToken, userInfoClaims } from "../../services/oidc";
import { handle, tokenRequestSchema } from "./shared";

export function registerTokenRoutes(app: Hono, ctx: AppContext) {
  const deviceEnabled = () => ctx.settings.get().oidcProvider.deviceAuthorizationEnabled;

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
}
