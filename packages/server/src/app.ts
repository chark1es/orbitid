import { Hono } from "hono";
import { cors } from "hono/cors";
import { OrbitError, ErrorCodes, type ApiErrorBody } from "@orbitid/shared";
import { nanoid } from "nanoid";
import type { AppContext } from "./context";
import { requireSecretKey } from "./middleware";
import { dashboardHandler } from "./modules/dashboard";
import { csrfProtection, securityHeaders, uploadSizeLimit } from "./lib/security";

import jwks from "./modules/jwks";
import environment from "./modules/environment";
import client from "./modules/client";
import handshake from "./modules/handshake";
import signIn from "./modules/sign-in";
import signUp from "./modules/sign-up";
import oauth from "./modules/oauth";
import verifyLink from "./modules/verify-link";
import me from "./modules/me";
import orgClient from "./modules/org-client";
import orgBackend from "./modules/org-backend";
import admin from "./modules/admin";
import webhooksApi from "./modules/webhooks-api";
import waitlistClient from "./modules/waitlist-client";
import apiKeys from "./modules/api-keys";
import m2m from "./modules/m2m";
import oidc from "./modules/oidc";
import enterprise from "./modules/enterprise";
import docs from "./modules/docs";
import operatorSessions from "./modules/operator-sessions";

/** A race between a check and an insert surfaces as a unique-constraint error from either database. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code ?? "";
  return code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export function createApp(ctx: AppContext) {
  const app = new Hono();

  // ───────────── security (headers, CSRF, body caps) ─────────────
  // Mounted first so `await next()` wraps every response, including error responses from onError.
  app.use("*", securityHeaders(ctx));
  app.use("*", uploadSizeLimit());
  app.use("*", csrfProtection(ctx));

  // CORS: Frontend API is called from browsers with credentials, so only allow configured origins.
  app.use("*", cors({
    origin: (origin) => {
      const a = ctx.settings.get().application;
      // Redirect-only origins may receive the user after sign-in; they are not trusted to call this API with credentials.
      return a.allowedOrigins.includes(origin) || (a.developmentMode && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ? origin : null;
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-OrbitID-Client", "X-Requested-With"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 600,
  }));

  app.onError((err, c) => {
    const trace_id = nanoid(16);
    if (err instanceof OrbitError) {
      const items = (err as any).items ?? [err.toItem()];
      if (err.status === 429 && err.meta?.retry_after) c.header("Retry-After", String(err.meta.retry_after));
      return c.json({ errors: items, trace_id } satisfies ApiErrorBody, err.status as any);
    }
    if (isUniqueViolation(err)) return c.json({ errors: [{ code: ErrorCodes.duplicate_record, message: "That record already exists" }], trace_id } satisfies ApiErrorBody, 409);
    if ((err as any)?.name === "SyntaxError") return c.json({ errors: [{ code: ErrorCodes.request_body_invalid, message: "Invalid JSON" }], trace_id }, 400);
    // Error messages can contain provider responses, codes or credentials. Keep authentication failures
    // silent, and emit only a fixed diagnostic with the response trace id elsewhere.
    const authPath = /^\/(?:v1\/(?:client(?:\/|$)|operator_sessions(?:\/|$)|oauth_callback(?:\/|$)|verify(?:\/|$)|saml(?:\/|$))|oauth(?:\/|$))/.test(c.req.path);
    if (!authPath) console.error(`[${trace_id}] Unexpected server error`);
    return c.json({ errors: [{ code: "internal_server_error", message: "Internal server error" }], trace_id } satisfies ApiErrorBody, 500);
  });
  app.notFound((c) => c.json({ errors: [{ code: ErrorCodes.resource_not_found, message: "Route not found" }] } satisfies ApiErrorBody, 404));

  app.get("/health", (c) => c.json({ status: "ok", publishable_key: ctx.publishableKey, database: ctx.database.dialect, database_driver: ctx.database.driver }));

  // Public / well-known
  app.route("/", jwks(ctx));
  app.route("/", oidc(ctx)); // /oauth/*, /.well-known/openid-configuration, + its own /v1/oauth_applications (secret key guarded internally)
  app.route("/", docs(ctx)); // /docs (+ assets) and the public /v1/openapi.json

  // Frontend API (cookie/client authenticated)
  app.route("/v1/client/environment", environment(ctx));
  app.route("/v1/client/sign_ins", signIn(ctx));
  app.route("/v1/client/sign_ups", signUp(ctx));
  app.route("/v1/client/me", me(ctx));
  app.route("/v1/client", client(ctx));
  app.route("/v1/client/handshake", handshake(ctx));
  app.route("/v1/client", orgClient(ctx));
  app.route("/v1/client", waitlistClient(ctx));
  const keysApp = apiKeys(ctx);
  const ssoApp = enterprise(ctx);
  if (keysApp.fapi) app.route("/v1/client", keysApp.fapi);
  if (ssoApp.fapi) app.route("/v1/client", ssoApp.fapi);
  app.route("/v1/oauth_callback", oauth(ctx));
  app.route("/v1/verify", verifyLink(ctx));
  if (ssoApp.saml) app.route("/v1/saml", ssoApp.saml);

  // Dashboard operator sessions (the exchange route; the cookie it sets is accepted by the Backend API below)
  app.route("/v1", operatorSessions(ctx));

  // Backend API (secret key or same-origin operator-session cookie)
  const backend = new Hono();
  backend.use("*", requireSecretKey(ctx));
  backend.route("/", admin(ctx));
  backend.route("/", orgBackend(ctx));
  backend.route("/webhooks", webhooksApi(ctx));
  if (keysApp.backend) backend.route("/", keysApp.backend);
  backend.route("/m2m", m2m(ctx));
  if (ssoApp.backend) backend.route("/", ssoApp.backend);
  app.route("/v1", backend);

  const dashboard = dashboardHandler(ctx);
  if (dashboard) app.get("*", dashboard);

  return app;
}
