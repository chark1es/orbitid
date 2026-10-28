// social OAuth: /v1/oauth_callback/:provider (+ start helpers)
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { appleProfileName, getOAuthAdapter } from "../services/oauth-providers";
import { handleExternalIdentity, type ExternalProfile } from "../services/external-identity";
import { regenerateClientToken } from "./auth/client-auth";
import { applyTrustedDeviceCookie, readTrustedDeviceToken } from "../services/trusted-devices";
import { browserMatches, browserMismatchMessage } from "./auth/browser-binding";
import { takeOAuthState, type StoredOAuthFlow } from "./auth/oauth-flow";
import { withQuery } from "./auth/redirects";
import { first } from "../lib/db";

async function readCallback(c: Context): Promise<{ state: string; code?: string; error?: string; userJson?: string }> {
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      let body: Record<string, unknown> = {};
      try { body = await c.req.json<Record<string, unknown>>(); } catch { body = {}; }
      return {
        state: typeof body.state === "string" ? body.state : "",
        code: typeof body.code === "string" ? body.code : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
        userJson: typeof body.user === "string" ? body.user : undefined,
      };
    }
    const body = await c.req.parseBody();
    return {
      state: typeof body.state === "string" ? body.state : "",
      code: typeof body.code === "string" ? body.code : undefined,
      error: typeof body.error === "string" ? body.error : undefined,
      userJson: typeof body.user === "string" ? body.user : undefined,
    };
  }
  return {
    state: c.req.query("state") ?? "",
    code: c.req.query("code"),
    error: c.req.query("error"),
  };
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  const callback = async (c: Context) => {
    const provider = c.req.param("provider");
    if (!provider) throw new OrbitError(404, ErrorCodes.resource_not_found, "Unknown OAuth provider");
    const params = await readCallback(c);
    let flow: StoredOAuthFlow | null = null;
    try {
      flow = await takeOAuthState(ctx, params.state, provider);
    } catch (err) {
      const message = err instanceof OrbitError ? err.message : "The OAuth state is invalid or has expired";
      const home = ctx.settings.get().application.homeUrl;
      return c.redirect(withQuery(home, { __orbit_error: ErrorCodes.oauth_callback_error, __orbit_error_message: message }), 302);
    }
    if (!flow) return c.redirect(withQuery(ctx.settings.get().application.homeUrl, { __orbit_error: ErrorCodes.oauth_callback_error }), 302);
    const target = flow.actionCompleteRedirectUrl || flow.redirectUrl;
    if (!browserMatches(c, flow.browserHash)) {
      return c.redirect(withQuery(target, { __orbit_error: ErrorCodes.oauth_callback_error, __orbit_error_message: browserMismatchMessage(ctx, c) }), 302);
    }
    if (params.error) {
      return c.redirect(withQuery(target, { __orbit_error: ErrorCodes.oauth_callback_error, __orbit_error_message: params.error }), 302);
    }
    if (!params.code) {
      return c.redirect(withQuery(target, { __orbit_error: ErrorCodes.oauth_callback_error, __orbit_error_message: "Missing authorization code" }), 302);
    }

    const adapter = await getOAuthAdapter(ctx, provider);
    if (!adapter) {
      return c.redirect(withQuery(target, { __orbit_error: ErrorCodes.oauth_provider_not_enabled }), 302);
    }

    let profile: ExternalProfile;
    try {
      const tokens = await adapter.exchangeCode({ code: params.code, codeVerifier: flow.codeVerifier });
      profile = await adapter.fetchProfile({ tokens });
      if (provider === "apple") {
        // Apple sends the name only on the very first authorization; later ones carry no `user` field.
        const name = appleProfileName(params.userJson);
        if (name.firstName || name.lastName) {
          profile = { ...profile, firstName: profile.firstName ?? name.firstName, lastName: profile.lastName ?? name.lastName };
        }
      }
    } catch (err) {
      const code = err instanceof OrbitError ? err.code : ErrorCodes.oauth_callback_error;
      const message = err instanceof Error ? err.message : "OAuth token exchange failed";
      return c.redirect(withQuery(target, { __orbit_error: code, __orbit_error_message: message }), 302);
    }

    // The browser is proven to be the initiator, so it takes over the flow's client (form_post callbacks do not carry the Lax client cookie).
    const client = first(await ctx.db.select().from(s.clients).where(eq(s.clients.id, flow.clientId)));
    if (!client) {
      return c.redirect(withQuery(target, { __orbit_error: ErrorCodes.client_state_invalid }), 302);
    }
    await regenerateClientToken(ctx, c, flow.clientId);

    const result = await handleExternalIdentity(ctx, {
      clientId: flow.clientId,
      kind: flow.kind,
      ownerId: flow.ownerId,
      userId: flow.userId,
      redirectUrl: flow.redirectUrl,
      actionCompleteRedirectUrl: flow.actionCompleteRedirectUrl,
      trustedDeviceToken: readTrustedDeviceToken(c),
    }, profile);
    applyTrustedDeviceCookie(c, ctx, result);
    return c.redirect(result.redirectTo, 302);
  };

  app.get("/:provider", callback);
  app.post("/:provider", callback);
  return app;
}
