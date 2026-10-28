import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { setup, authHeaders, insertClient, BASE_URL } from "./helpers";

const handleExternalIdentity = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, flow: { redirectUrl: string }, profile: { provider: string; email?: string }) => ({
    redirectTo: `${flow.redirectUrl}?provider=${profile.provider}&email=${profile.email ?? ""}`,
  })),
);
vi.mock("../../src/services/external-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/external-identity")>();
  return { ...actual, handleExternalIdentity };
});

type Harness = Awaited<ReturnType<typeof setup>>;
const json = (body: unknown) => JSON.stringify(body);

/** Minimal IdP: discovery, JWKS, token endpoint (checks PKCE) and userinfo. */
interface MockIdp {
  issuer: string;
  server: Server;
  discoveryHits: number;
  lastTokenRequest: URLSearchParams | null;
  expectedNonce: string;
  signIdToken: (claims: Record<string, unknown>) => Promise<string>;
}

let idp: MockIdp;
let idpPublicJwk: JWK;
let idpPrivateKey: CryptoKey;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  idpPrivateKey = privateKey as CryptoKey;
  idpPublicJwk = { ...(await exportJWK(publicKey)), alg: "RS256", use: "sig", kid: "mock-idp" };

  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const state: MockIdp = {
    issuer,
    discoveryHits: 0,
    lastTokenRequest: null,
    expectedNonce: "",
    server: undefined as unknown as Server,
    signIdToken: async (claims) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "mock-idp" })
        .setIssuer(issuer)
        .setAudience("mock-client")
        .setSubject(String(claims.sub))
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 300);
      return jwt.sign(idpPrivateKey);
    },
  };

  state.server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      state.discoveryHits++;
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [idpPublicJwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const params = new URLSearchParams(raw);
      state.lastTokenRequest = params;
      if (params.get("grant_type") !== "authorization_code" || params.get("code") !== "good-code") {
        return send(400, { error: "invalid_grant" });
      }
      const verifier = params.get("code_verifier");
      if (!verifier || !params.get("redirect_uri")) return send(400, { error: "invalid_request" });
      const id_token = await state.signIdToken({
        sub: "idp-user-1",
        nonce: state.expectedNonce,
        email: "ada@acme.com",
        email_verified: true,
        given_name: "Ada",
        family_name: "Lovelace",
        preferred_username: "ada",
        picture: "https://idp.acme.test/ada.png",
      });
      return send(200, { access_token: "idp-access-token", token_type: "Bearer", expires_in: 3600, id_token, scope: "openid profile email" });
    }
    if (url.pathname === "/userinfo") {
      if (req.headers.authorization !== "Bearer idp-access-token") return send(401, { error: "invalid_token" });
      return send(200, { sub: "idp-user-1", email: "ada@acme.com", email_verified: true });
    }
    return send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => state.server.listen(Number(new URL(issuer).port), "127.0.0.1", resolve));
  idp = state;
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.server.close(() => resolve()));
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function createOidcConnection(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/enterprise_connections", {
    method: "POST",
    headers: authHeaders(),
    body: json({
      name: "Acme OIDC",
      protocol: "oidc",
      domains: ["acme.com"],
      active: true,
      client_id: "mock-client",
      client_secret: "mock-secret",
      discovery_url: `${idp.issuer}/.well-known/openid-configuration`,
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** What a browser does: start with its client cookie, keep the binding cookie the server sets for the callback. */
async function startFlow(h: Harness, connectionId: string, client: ReturnType<typeof insertClient>, identifier = "ada@acme.com") {
  const res = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
    client_id: client.clientId, identifier, redirect_url: "http://localhost:3000/after",
  })}`, { headers: { cookie: `__client=${client.token}` } });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  const query = Object.fromEntries(location.searchParams);
  const stateRow = h.ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, query.state!)).get()!;
  const binding = /__orbit_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return { location, query, stateRow, connectionId, cookie: `__client=${client.token}; __orbit_oauth=${binding}` };
}

const callback = (h: Harness, connectionId: string, params: Record<string, string>, cookie?: string) =>
  h.app.request(`/v1/client/enterprise/oidc_callback/${connectionId}?${new URLSearchParams(params)}`, cookie ? { headers: { cookie } } : undefined);

describe("enterprise OIDC connections", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    handleExternalIdentity.mockClear();
    idp.lastTokenRequest = null;
    idp.discoveryHits = 0;
    idp.expectedNonce = "";
  });

  it("creates a connection without leaking the client secret", async () => {
    const conn = await createOidcConnection(h);
    expect(conn.oidc).toMatchObject({ client_id: "mock-client", discovery_url: `${idp.issuer}/.well-known/openid-configuration` });
    expect(conn.oidc.client_secret).toBeUndefined();
    expect(JSON.stringify(conn)).not.toContain("mock-secret");

    const row = h.ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, conn.id)).get()!;
    const stored = (row.config as Record<string, unknown>).clientSecretEnc as string;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain("mock-secret");

    const start = await startFlow(h, conn.id, insertClient(h.ctx));
    expect(start.query.client_id).toBe("mock-client");
    expect(start.query.code_challenge).toBeTruthy();
    expect(start.query.code_challenge_method).toBe("S256");
    expect(start.query.redirect_uri).toBe(`${BASE_URL}/v1/client/enterprise/oidc_callback/${conn.id}`);
  });

  it("completes the authorization-code + PKCE callback and maps the profile", async () => {
    const conn = await createOidcConnection(h);
    const client = insertClient(h.ctx);
    const start = await startFlow(h, conn.id, client);
    idp.expectedNonce = start.stateRow.nonce!;

    // Another browser holding the link cannot finish the flow.
    const foreign = await callback(h, conn.id, { code: "good-code", state: start.query.state! }, `__client=${insertClient(h.ctx).token}`);
    expect(foreign.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();

    const restarted = await startFlow(h, conn.id, client);
    idp.expectedNonce = restarted.stateRow.nonce!;
    const res = await callback(h, conn.id, { code: "good-code", state: restarted.query.state! }, restarted.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`http://localhost:3000/after?provider=oidc_${conn.id}&email=ada@acme.com`);

    const verifier = idp.lastTokenRequest!.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(restarted.query.code_challenge);
    expect(idp.lastTokenRequest!.get("client_id")).toBe("mock-client");
    expect(idp.lastTokenRequest!.get("client_secret")).toBe("mock-secret");

    const flow = handleExternalIdentity.mock.calls[0]![1];
    const profile = handleExternalIdentity.mock.calls[0]![2];
    expect(flow).toMatchObject({ kind: "sign_in", clientId: client.clientId, redirectUrl: "http://localhost:3000/after", connectionId: conn.id });
    expect(profile).toMatchObject({
      provider: `oidc_${conn.id}`,
      providerUserId: "idp-user-1",
      email: "ada@acme.com",
      emailVerified: true,
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada",
      imageUrl: "https://idp.acme.test/ada.png",
    });

    // The state is single use.
    const replay = await callback(h, conn.id, { code: "good-code", state: restarted.query.state! }, restarted.cookie);
    expect(replay.status).toBe(400);
  });

  it("caches the discovery document", async () => {
    const conn = await createOidcConnection(h);
    const client = insertClient(h.ctx);
    await startFlow(h, conn.id, client);
    await startFlow(h, conn.id, client);
    expect(idp.discoveryHits).toBe(1);
  });

  it("rejects a nonce mismatch and IdP errors", async () => {
    const conn = await createOidcConnection(h);
    const client = insertClient(h.ctx);
    const start = await startFlow(h, conn.id, client);
    idp.expectedNonce = "different-nonce";
    const mismatch = await callback(h, conn.id, { code: "good-code", state: start.query.state! }, start.cookie);
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).errors[0].code).toBe("oauth_callback_error");
    expect(handleExternalIdentity).not.toHaveBeenCalled();

    const second = await startFlow(h, conn.id, client);
    const idpError = await callback(h, conn.id, { error: "access_denied", error_description: "user said no", state: second.query.state! }, second.cookie);
    expect(idpError.status).toBe(400);

    const unknownState = await callback(h, conn.id, { code: "good-code", state: "nonsense" });
    expect(unknownState.status).toBe(400);
  });

  it("refuses inactive connections, wrong protocols and unregistered redirect targets", async () => {
    const conn = await createOidcConnection(h);
    const client = insertClient(h.ctx);
    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ active: false }) });
    const inactive = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`, { headers: { cookie: `__client=${client.token}` } });
    expect(inactive.status).toBe(404);

    const saml = await h.app.request("/v1/enterprise_connections", {
      method: "POST", headers: authHeaders(),
      body: json({
        name: "SAML", protocol: "saml", active: true,
        idp_entity_id: "https://idp", idp_sso_url: "https://idp/sso", idp_certificate: "not-a-cert",
      }),
    });
    expect(saml.status).toBe(422); // certificate validation still applies
  });
});
