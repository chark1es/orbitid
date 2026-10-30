/** Device authorization grant, verification page, and frontend API. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import type { Context } from "hono";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { clientIp, parseBody } from "../../lib/http";
import { hit } from "../../lib/rate-limit";
import { SCOPE_DESCRIPTIONS, assertScopesAllowed, authenticateClient, burnDeviceCode, createDeviceAuthorization, decideDeviceCode, deviceApplication, findDeviceByUserCode, formatUserCode, normalizeUserCode, parseScopes } from "../../services/oidc";
import { resolveCaller } from "../machine/auth";
import { DEVICE_PAGE_CSP, devicePageHtml, deviceResultHtml } from "../oidc-device-page";
import { DEVICE_CODE_ATTEMPTS, DEVICE_CODE_WINDOW_MS, DEVICE_LOOKUP_PER_IP, urlWith, handle, deviceAuthorizationSchema, deviceVerificationUrl, serveAsset, signInLink } from "./shared";

export function registerDeviceRoutes(app: Hono, ctx: AppContext) {
  const deviceEnabled = () => ctx.settings.get().oidcProvider.deviceAuthorizationEnabled;

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
}
