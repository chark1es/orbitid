// GET /v1/client/handshake: turns a live `__client` cookie into a fresh session token for a hard
// navigation whose `__session` cookie has expired. Answers with a 302 back to `redirect_url`.
import { Hono } from "hono";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { clientIp } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { signSessionToken } from "../services/tokens";
import { activeClientSession, findClient } from "./auth/client-auth";
import { withQuery } from "./auth/redirects";
import { requestOriginAllowed } from "../lib/security";

/** Marker returned when the request has no usable client session; the middleware clears `__client_uat`. */
export const HANDSHAKE_SIGNED_OUT = "signed_out";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  /**
   * The token travels in the redirect URL, so it is capped by the normal session token lifetime
   * (`session.tokenLifetimeSeconds`, 60 s by default) and the response is uncacheable and
   * referrer-free. See docs/HANDSHAKE.md.
   */
  app.get("/", async (c) => {
    // Unauthenticated and token-minting: one budget per address, well above a normal navigation
    // rate (and generous enough for an office behind one proxy address).
    await hit(ctx, `handshake:${clientIp(c)}`, 120, 60_000);

    // Never cacheable and never a referrer source, error responses included.
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");

    const redirectUrl = requireRedirectUrl(ctx, c.req.query("redirect_url"));

    const client = await findClient(ctx, c);
    const session = client ? await activeClientSession(ctx, client) : null;
    let token: string | null = null;
    if (session?.status === "active") {
      try {
        // Only the app that is about to receive the token may use it.
        token = await signSessionToken(ctx, session.id, { azp: new URL(redirectUrl).origin });
      } catch {
        // Ended, expired, idle or banned between the lookup and the mint: fall through as signed out.
        token = null;
      }
    }
    return c.redirect(withQuery(redirectUrl, { [COOKIES.handshake]: token ?? HANDSHAKE_SIGNED_OUT }), 302);
  });

  return app;
}

/**
 * `redirect_url` goes through the shared validator (allow-listed origin, same origin as the app, or a
 * dev localhost), plus the API's own origin. Credentials in the URL are refused and a bad value is
 * 400, not a form error.
 */
function requireRedirectUrl(ctx: AppContext, value: string | undefined): string {
  if (!value?.trim()) {
    throw new OrbitError(400, ErrorCodes.form_param_missing, "redirect_url is required", { param_name: "redirect_url" });
  }
  let url: URL;
  try {
    url = new URL(value.trim(), ctx.settings.get().application.homeUrl || ctx.env.baseUrl);
  } catch {
    throw new OrbitError(400, ErrorCodes.form_param_format_invalid, "redirect_url is not a valid URL", { param_name: "redirect_url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OrbitError(400, ErrorCodes.form_param_format_invalid, "redirect_url must use http(s)", { param_name: "redirect_url" });
  }
  if (url.username || url.password) {
    throw new OrbitError(400, ErrorCodes.form_param_format_invalid, "redirect_url must not contain credentials", { param_name: "redirect_url" });
  }
  // The token goes to this origin, so it must be an application origin (or this server), not merely a place users
  // may be redirected to after sign-in.
  if (!requestOriginAllowed(ctx, url.origin)) {
    throw new OrbitError(400, ErrorCodes.form_param_format_invalid, "redirect_url origin is not allowed", { param_name: "redirect_url" });
  }
  return url.toString();
}
