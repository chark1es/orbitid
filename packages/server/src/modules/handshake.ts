// GET /v1/client/handshake: turns a live `__client` cookie into a fresh session token for a hard
// navigation whose `__session` cookie has expired. Answers with a 302 back to `redirect_url`.
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { clientIp } from "../lib/http";
import { hit } from "../lib/rate-limit";
import { signSessionToken } from "../services/tokens";
import { activeClientSession, findClient, renewClientCookieIfDue } from "./auth/client-auth";
import { evaluateSessionStatus, getSession, slideSessionActivity } from "../services/sessions";
import { withQuery } from "./auth/redirects";
import { requestOriginAllowed } from "../lib/security";
import { first } from "../lib/db";
import * as s from "../db/schema";

/** Marker returned when the request has no usable client session; the middleware clears `__client_uat`. */
export const HANDSHAKE_SIGNED_OUT = "signed_out";
/**
 * Marker for an infrastructure failure (signing key unreadable, database error). The middleware must treat it as
 * transient and keep the visitor's cookies: a broken database is not a sign-out.
 */
export const HANDSHAKE_TRANSIENT = "transient";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  /**
   * The token travels in the redirect URL, so it is capped by the normal session token lifetime
   * (`session.tokenLifetimeSeconds`, 60 s by default) and the response is uncacheable and
   * referrer-free. See docs/HANDSHAKE.md.
   */
  app.get("/", async (c) => {
    // Unauthenticated and token-minting: one budget per address. A handshake is a hard navigation, and a
    // restored browser can replay it from several tabs at once while an office shares one address, so keep the
    // budget far above any human navigation rate. A 429 here would surface as a broken page, never as a sign-out.
    await hit(ctx, `handshake:${clientIp(c)}`, 600, 60_000);

    // Never cacheable and never a referrer source, error responses included.
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");

    const redirectUrl = requireRedirectUrl(ctx, c.req.query("redirect_url"));

    const client = await findClient(ctx, c);
    if (client) await renewClientCookieIfDue(ctx, c, client);
    const session = client ? await activeClientSession(ctx, client) : null;
    let token: string | null = null;
    // A session waiting for required MFA enrolment is live and may mint the same pending token the Frontend API
    // returns from `GET /v1/client`. Treating it as signed out here cleared the cookies and ended the enrolment
    // flow. The middleware sees `sts: "pending"` and keeps the visitor signed-in-incomplete, never signed out.
    if (session?.status === "active" || session?.status === "pending") {
      try {
        // Only the app that is about to receive the token may use it.
        token = await signSessionToken(ctx, session.id, { azp: new URL(redirectUrl).origin });
      } catch {
        // The mint failed. Only a session that is positively gone is a sign-out; a signing-key or database
        // failure must stay retriable, never clear the browser's credentials.
        let ended = false;
        try {
          ended = await sessionIsDefinitelyEnded(ctx, session.id, session.userId);
        } catch {
          ended = false;
        }
        if (!ended) {
          c.header("Retry-After", "5");
          return c.redirect(withQuery(redirectUrl, { [COOKIES.handshake]: HANDSHAKE_TRANSIENT }), 302);
        }
        token = null;
      }
      if (token) {
        // Activity bookkeeping is best-effort: a failed write must not fail the handshake.
        try {
          // A hard navigation is activity: an opt-in inactivity timeout slides, exactly as it does for a refresh.
          await slideSessionActivity(ctx, session);
        } catch (error) {
          console.error("[handshake] activity write failed", error);
        }
      }
    }
    return c.redirect(withQuery(redirectUrl, { [COOKIES.handshake]: token ?? HANDSHAKE_SIGNED_OUT }), 302);
  });

  return app;
}

/** Reads the row again and answers whether the session (or its user) really is gone, rather than an infra error. */
async function sessionIsDefinitelyEnded(ctx: AppContext, sessionId: string, userId: string): Promise<boolean> {
  const row = await getSession(ctx, sessionId);
  if (!row || row.userId !== userId) return true;
  const status = await evaluateSessionStatus(ctx, row);
  if (status !== "active" && status !== "pending") return true;
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, userId)));
  return !user || user.banned;
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
