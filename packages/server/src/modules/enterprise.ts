// Enterprise SSO: backend CRUD `/v1/enterprise_connections`, Frontend API
// `/v1/client/enterprise/*` (start + OIDC callback) and the SAML service provider at `/v1/saml/:id/*`.
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, desc, eq, sql } from "drizzle-orm";
import { COOKIES, ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { clientIp, parseBody, parsePagination } from "../lib/http";
import { randomToken, sha256 } from "../lib/crypto";
import { handleExternalIdentity } from "../services/external-identity";
import { pkceChallengeFor } from "../services/oidc";
import {
  enterpriseOidcAuthorizeUrl, enterpriseOidcProfile, exchangeEnterpriseOidcCode, fetchEnterpriseUserInfo,
  findActiveConnection, findConnectionForIdentifier, getOidcDiscovery, profileToExternalProfile, samlAuthorizeUrl,
  serializeConnection, serviceProviderMetadata, validateSamlResponse, verifyEnterpriseIdToken,
} from "../services/saml";
import { bindBrowser, browserMatches, browserMismatchMessage } from "./auth/browser-binding";
import { setClientCookie } from "./auth/client-auth";
import { createClient } from "./machine/auth";
import { connectionBodySchema, connectionPatchSchema, createConnection, updateConnection } from "./machine/enterprise-config";
import {
  assertAllowedRedirectUrl, createEnterpriseState, peekEnterpriseState, takeEnterpriseState, type EnterpriseFlow,
} from "./machine/enterprise-flow";

type ConnectionRow = typeof s.enterpriseConnections.$inferSelect;

const providerFor = (protocol: string, id: string) => `enterprise_${protocol}_${id}`;

function requireConnection(ctx: AppContext, id: string): ConnectionRow {
  const row = ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, id)).get();
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Enterprise connection not found");
  return row;
}

const oidcCallbackUrl = (ctx: AppContext, id: string) => `${ctx.env.baseUrl}/v1/client/enterprise/oidc_callback/${id}`;

/** Builds the flow record shared by SP-initiated SAML and enterprise OIDC logins. */
function flowFromQuery(ctx: AppContext, c: Context, connection: ConnectionRow): EnterpriseFlow {
  const q = c.req.query();
  // The client is the browser's own; a `client_id` in a link must never choose whose session gets created.
  const token = getCookie(c, COOKIES.client);
  const client = token ? ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(token))).get() : undefined;
  if (!client || (q.client_id && q.client_id !== client.id)) {
    throw new OrbitError(422, ErrorCodes.client_state_invalid, "This browser has no sign-in in progress", { param_name: "client_id" });
  }
  const homeUrl = ctx.settings.get().application.homeUrl;
  return {
    kind: q.action === "sign_up" ? "sign_up" : "sign_in",
    clientId: client.id,
    browserHash: bindBrowser(ctx, c),
    redirectUrl: assertAllowedRedirectUrl(ctx, q.redirect_url || homeUrl, "redirect_url"),
    actionCompleteRedirectUrl: q.action_complete_redirect_url
      ? assertAllowedRedirectUrl(ctx, q.action_complete_redirect_url, "action_complete_redirect_url")
      : undefined,
    connectionId: connection.id,
  };
}

export default function routes(ctx: AppContext): { fapi?: Hono; backend?: Hono; saml?: Hono } {
  return { fapi: frontendRoutes(ctx), backend: backendRoutes(ctx), saml: samlRoutes(ctx) };
}

function backendRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post("/enterprise_connections", async (c) => {
    const body = await parseBody(c, connectionBodySchema);
    return c.json(serializeConnection(ctx, createConnection(ctx, body)), 201);
  });

  app.get("/enterprise_connections", (c) => {
    const page = parsePagination(c);
    const protocol = c.req.query("protocol");
    const active = c.req.query("active");
    const filters = [];
    if (protocol) filters.push(eq(s.enterpriseConnections.protocol, protocol));
    if (active === "true" || active === "false") filters.push(eq(s.enterpriseConnections.active, active === "true"));
    const where = filters.length ? and(...filters) : undefined;
    const data = ctx.db.select().from(s.enterpriseConnections).where(where)
      .orderBy(desc(s.enterpriseConnections.createdAt)).limit(page.limit).offset(page.offset).all();
    const totalCount = ctx.db.select({ n: sql<number>`count(*)` }).from(s.enterpriseConnections).where(where).get()?.n ?? 0;
    return c.json({ data: data.map((row) => serializeConnection(ctx, row)), total_count: totalCount });
  });

  app.get("/enterprise_connections/:id", (c) => c.json(serializeConnection(ctx, requireConnection(ctx, c.req.param("id")))));

  app.patch("/enterprise_connections/:id", async (c) => {
    const row = requireConnection(ctx, c.req.param("id"));
    const body = await parseBody(c, connectionPatchSchema);
    return c.json(serializeConnection(ctx, updateConnection(ctx, row, body)));
  });

  app.delete("/enterprise_connections/:id", (c) => {
    const row = requireConnection(ctx, c.req.param("id"));
    ctx.db.delete(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, row.id)).run();
    return c.json({ object: "enterprise_connection", id: row.id, deleted: true });
  });

  return app;
}

function frontendRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  /** `enterprise_sso` first factor: resolves the connection, then redirects to the IdP. */
  app.get("/enterprise/start", async (c) => {
    const q = c.req.query();
    let connection: ConnectionRow | null = null;
    if (q.connection_id) {
      connection = findActiveConnection(ctx, q.connection_id);
      if (!connection) throw new OrbitError(404, ErrorCodes.resource_not_found, "Enterprise connection not found");
    } else {
      connection = findConnectionForIdentifier(ctx, q.identifier ?? q.domain ?? q.email_address ?? "");
      if (!connection) throw new OrbitError(404, ErrorCodes.resource_not_found, "No enterprise connection matches this identifier");
    }

    const flow = flowFromQuery(ctx, c, connection);
    const provider = providerFor(connection.protocol, connection.id);

    if (connection.protocol === "saml") {
      const state = createEnterpriseState(ctx, { provider, flow });
      return c.redirect(await samlAuthorizeUrl(ctx, connection, state));
    }
    const discovery = await getOidcDiscovery(ctx, connection);
    const nonce = randomToken(16);
    const codeVerifier = randomToken(32);
    const state = createEnterpriseState(ctx, { provider, flow, codeVerifier, nonce });
    return c.redirect(enterpriseOidcAuthorizeUrl(connection, discovery, {
      redirectUri: oidcCallbackUrl(ctx, connection.id),
      state,
      nonce,
      codeChallenge: pkceChallengeFor(codeVerifier),
    }));
  });

  /** Enterprise OIDC: code exchange against the IdP, id_token verification, then the shared identity flow. */
  app.get("/enterprise/oidc_callback/:id", async (c) => {
    const connection = requireConnection(ctx, c.req.param("id"));
    if (connection.protocol !== "oidc") throw new OrbitError(404, ErrorCodes.resource_not_found, "Enterprise OIDC connection not found");
    if (!connection.active) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Enterprise connection is inactive");
    const q = c.req.query();
    if (q.error) throw new OrbitError(400, ErrorCodes.oauth_callback_error, `The identity provider returned an error: ${q.error_description ?? q.error}`);
    if (!q.code || !q.state) throw new OrbitError(400, ErrorCodes.form_param_missing, "code and state are required");

    const state = takeEnterpriseState(ctx, q.state, providerFor("oidc", connection.id));
    if (!state) throw new OrbitError(400, ErrorCodes.verification_failed, "Enterprise SSO state is invalid or expired");
    if (!browserMatches(c, state.flow.browserHash)) throw new OrbitError(400, ErrorCodes.verification_failed, browserMismatchMessage(ctx, c));

    const discovery = await getOidcDiscovery(ctx, connection);
    const tokens = await exchangeEnterpriseOidcCode(ctx, connection, discovery, {
      code: q.code,
      redirectUri: oidcCallbackUrl(ctx, connection.id),
      codeVerifier: state.codeVerifier,
    });

    let claims: Record<string, unknown> = {};
    if (tokens.id_token) claims = await verifyEnterpriseIdToken(connection, discovery, tokens.id_token, state.nonce);
    let userInfo: Record<string, unknown> = {};
    try {
      userInfo = await fetchEnterpriseUserInfo(discovery, tokens.access_token);
    } catch {
      // userinfo is optional when the id_token already carries the profile
      if (!tokens.id_token) throw new OrbitError(400, ErrorCodes.oauth_callback_error, "The identity provider returned neither id_token nor userinfo");
    }
    const merged = { ...userInfo, ...claims };
    const profile = enterpriseOidcProfile(connection, merged, tokens);
    const { redirectTo } = await handleExternalIdentity(ctx, state.flow, profile);
    return c.redirect(redirectTo);
  });

  return app;
}

function samlRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get("/:id/metadata", (c) => {
    const connection = requireConnection(ctx, c.req.param("id"));
    if (connection.protocol !== "saml") throw new OrbitError(404, ErrorCodes.resource_not_found, "SAML connection not found");
    return c.body(serviceProviderMetadata(ctx, connection), 200, { "content-type": "application/xml; charset=utf-8" });
  });

  /** SP-initiated login: `?flow=<relay state>` resumes an existing flow, otherwise the query is the flow. */
  app.get("/:id/sso", async (c) => {
    const connection = requireConnection(ctx, c.req.param("id"));
    if (connection.protocol !== "saml") throw new OrbitError(404, ErrorCodes.resource_not_found, "SAML connection not found");
    if (!connection.active) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Enterprise connection is inactive");
    const provider = providerFor("saml", connection.id);
    const state = c.req.query("flow");
    if (state) {
      // Peek (not consume): the ACS consumes the state when the assertion comes back.
      if (!peekEnterpriseState(ctx, state, provider)) throw new OrbitError(400, ErrorCodes.verification_failed, "Enterprise SSO state is invalid or expired");
      return c.redirect(await samlAuthorizeUrl(ctx, connection, state));
    }
    const flow = flowFromQuery(ctx, c, connection);
    return c.redirect(await samlAuthorizeUrl(ctx, connection, createEnterpriseState(ctx, { provider, flow })));
  });

  /** Assertion Consumer Service: validates the signed assertion, then runs the shared identity flow. */
  app.post("/:id/acs", async (c) => {
    const connection = requireConnection(ctx, c.req.param("id"));
    if (connection.protocol !== "saml") throw new OrbitError(404, ErrorCodes.resource_not_found, "SAML connection not found");
    if (!connection.active) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Enterprise connection is inactive");

    const body = await c.req.parseBody();
    const samlResponse = typeof body.SAMLResponse === "string" ? body.SAMLResponse : undefined;
    const relayState = typeof body.RelayState === "string" ? body.RelayState : undefined;
    const profile = await validateSamlResponse(ctx, connection, { SAMLResponse: samlResponse });

    let flow: EnterpriseFlow | null = null;
    if (relayState) {
      const state = takeEnterpriseState(ctx, relayState, providerFor("saml", connection.id));
      if (!state) throw new OrbitError(400, ErrorCodes.verification_failed, "Enterprise SSO state is invalid or expired");
      if (!browserMatches(c, state.flow.browserHash)) throw new OrbitError(400, ErrorCodes.verification_failed, browserMismatchMessage(ctx, c));
      flow = state.flow;
    } else if (connection.allowIdpInitiated) {
      const { client, token } = createClient(ctx, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
      setClientCookie(c, ctx, token);
      flow = {
        kind: "sign_in",
        clientId: client.id,
        redirectUrl: ctx.settings.get().application.homeUrl,
        connectionId: connection.id,
      };
    } else {
      throw new OrbitError(400, ErrorCodes.verification_failed, "Unsolicited SAML responses are not allowed for this connection");
    }

    const external = profileToExternalProfile(connection, profile);
    const { redirectTo } = await handleExternalIdentity(ctx, flow, external);
    return c.redirect(redirectTo);
  });

  return app;
}
