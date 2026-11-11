// Interop: the issuer behind a reverse proxy. Forwarded headers are honoured only when explicitly trusted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import type { AppContext } from "../../src/context";
import { createApplication } from "../../src/services/oidc";
import { insertClientSession, insertUser } from "../machine/helpers";

const REDIRECT_URI = "http://localhost:3000/callback";
const FORWARDED = { "x-forwarded-proto": "https", "x-forwarded-host": "id.example.com" };
const PROXY_ISSUER = "https://id.example.com";

describe("OIDC interop — reverse proxy issuer", () => {
  let ctx: AppContext;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    // No explicit ORBITID_BASE_URL and one trusted proxy: the forwarded scheme/host define the public issuer.
    ctx = await createContext({ databaseUrl: ":memory:", secretKey: "sk_test_proxy", baseUrl: undefined, trustProxy: 1 });
    app = createApp(ctx);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it("advertises the forwarded public issuer and the same issuer on tokens", async () => {
    const user = await insertUser(ctx, { username: "proxy-user" });
    const session = await insertClientSession(ctx, user.userId);
    const client = await createApplication(ctx, {
      name: "Proxy client", redirectUris: [REDIRECT_URI], scopes: "openid profile email", consentScreenEnabled: false,
    });

    const discovery = await (await app.request("/.well-known/openid-configuration", { headers: FORWARDED })).json() as Record<string, string>;
    expect(discovery.issuer).toBe(PROXY_ISSUER);
    expect(discovery.authorization_endpoint).toBe(`${PROXY_ISSUER}/oauth/authorize`);
    expect(discovery.token_endpoint).toBe(`${PROXY_ISSUER}/oauth/token`);
    expect(discovery.jwks_uri).toBe(`${PROXY_ISSUER}/oauth/jwks`);
    expect(discovery.end_session_endpoint).toBe(`${PROXY_ISSUER}/oauth/end_session`);

    const auth = await app.request(`/oauth/authorize?${new URLSearchParams({
      client_id: client.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid profile email",
    })}`, { headers: { ...FORWARDED, cookie: session.cookie } });
    expect(auth.status).toBe(302);
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;

    const tokenResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: { ...FORWARDED, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
        client_id: client.row.clientId, client_secret: client.clientSecret!,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, string>;
    const jwks = createLocalJWKSet(await (await app.request("/oauth/jwks")).json() as never);

    const idToken = await jwtVerify(tokens.id_token, jwks, { issuer: PROXY_ISSUER, audience: client.row.clientId });
    expect(idToken.payload.iss).toBe(PROXY_ISSUER);

    // The fallback issuer never leaks into the token when the proxy headers are present.
    expect(tokens.id_token).toBeTruthy();
  });

  it("serves path-based discovery and RFC 8414 metadata with the same issuer", async () => {
    for (const path of [
      "/orbitid/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
      "/orbitid/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/orbitid",
    ]) {
      const response = await app.request(path, { headers: FORWARDED });
      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, string>).issuer).toBe(PROXY_ISSUER);
    }
  });

  it("falls back to the configured URL without proxy headers and rejects a smuggled host", async () => {
    const direct = await (await app.request("/.well-known/openid-configuration")).json() as Record<string, string>;
    expect(direct.issuer).toBe("http://localhost:4000");

    const smuggled = await (await app.request("/.well-known/openid-configuration", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example/steal" },
    })).json() as Record<string, string>;
    expect(smuggled.issuer).toBe("http://localhost:4000");
  });

  it("answers CORS preflights for discovery, token, userinfo and JWKS", async () => {
    for (const path of ["/.well-known/openid-configuration", "/oauth/token", "/oauth/userinfo", "/oauth/jwks"]) {
      const response = await app.request(path, { method: "OPTIONS", headers: { origin: "https://spa.example", "access-control-request-method": "POST" } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    }
  });

  it("keeps an explicitly configured base URL authoritative", async () => {
    const explicit = await createContext({
      databaseUrl: ":memory:",
      secretKey: "sk_test_proxy_explicit",
      baseUrl: "https://auth.example.com",
      encryptionKey: "test-explicit-proxy-encryption-key!!",
      trustProxy: 1,
    });
    const explicitApp = createApp(explicit);
    const doc = await (await explicitApp.request("/.well-known/openid-configuration", { headers: { ...FORWARDED, "x-forwarded-host": "attacker.example" } })).json() as Record<string, string>;
    expect(doc.issuer).toBe("https://auth.example.com");
    await explicit.close();
  });
});
