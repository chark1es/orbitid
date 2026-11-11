/** RP-initiated logout (`GET|POST /oauth/end_session`). */
import type { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../../context";
import { z } from "zod";
import { parseBody } from "../../lib/http";
import { endSessionAtProvider } from "../../services/oidc";
import { handle, requestIssuer } from "./shared";

const logoutSchema = z.object({
  id_token_hint: z.string().optional(),
  client_id: z.string().optional(),
  post_logout_redirect_uri: z.string().optional(),
  state: z.string().optional(),
  logout_hint: z.string().optional(),
  ui_locales: z.string().optional(),
});

async function readParams(c: Context): Promise<z.infer<typeof logoutSchema>> {
  if (c.req.method === "GET") return logoutSchema.parse(c.req.query());
  return parseBody(c, logoutSchema);
}

export function registerLogoutRoutes(app: Hono, ctx: AppContext) {
  const endpoint = handle(async (c) => {
    const params = await readParams(c);
    const result = await endSessionAtProvider(ctx, {
      idTokenHint: params.id_token_hint,
      clientId: params.client_id,
      postLogoutRedirectUri: params.post_logout_redirect_uri,
      state: params.state,
      issuer: requestIssuer(ctx, c),
    });
    c.header("Cache-Control", "no-store");
    return c.redirect(result.redirectTo);
  });
  app.get("/oauth/end_session", endpoint);
  app.post("/oauth/end_session", endpoint);
}
