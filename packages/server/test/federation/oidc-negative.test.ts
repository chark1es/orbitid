// Negative cases for the custom OIDC provider, driven against instance A as the real identity provider.
//
// Most tests break exactly one thing at the real IdP (state, code, browser, redirect_uri, consent, settings).
// The ID-token tests use a second real HTTP server ("hostile IdP") that reuses instance A's published JWKS
// and authorization endpoint but answers the token request with a token carrying forged claims, so the
// relying party's issuer/audience/nonce/expiry checks are the only thing standing in the way.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import * as s from "../../src/db/schema";
import { decrypt } from "../../src/lib/crypto";
import { first } from "../../src/lib/db";
import {
  authorizeAtIdp, authorizeParams, backend, Browser, createOAuthApplication, createUser, resetFederationCaches,
  signIn, startFedServer, type FedServer, type OAuthApplication,
} from "./helpers";

const REDIRECT = "http://localhost:3000/done";
const PROVIDER = "custom_acme";

let idp: FedServer;
let rp: FedServer;
let app: OAuthApplication;
let idpUser: { id: string; email: string; password: string };
let idpBrowser: Browser;

async function configureProvider(overrides: Record<string, unknown> = {}, discoveryUrl?: string) {
  const res = await backend(rp, "PATCH", "/v1/instance", {
    social: {
      [PROVIDER]: {
        enabled: true,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        discoveryUrl: discoveryUrl ?? `${idp.url}/.well-known/openid-configuration`,
        scopes: ["openid", "profile", "email"],
        name: "Acme ID",
        ...overrides,
      },
    },
  });
  expect(res.status).toBe(200);
}

async function startSocial(browser: Browser, provider = PROVIDER) {
  const res = await browser.request(`${rp.url}/v1/client/sign_ins`, {
    json: { strategy: `oauth_${provider}`, redirect_url: REDIRECT },
  });
  return {
    status: res.status,
    body: res.json<{
      response?: { first_factor_verification?: { external_verification_redirect_url?: string | null } };
      errors?: { code: string; message: string }[];
    }>(),
  };
}

const callbackUrl = (back: URL, provider = PROVIDER) => `${rp.url}/v1/oauth_callback/${provider}${back.search}`;

/** Runs the happy path up to the IdP's redirect back to the relying party. */
async function upToCallback(browser: Browser, provider = PROVIDER) {
  const start = await startSocial(browser, provider);
  expect(start.status).toBe(200);
  const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
  const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl));
  return { authorizeUrl, back };
}

async function expectNothingCreated() {
  expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);
  expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
  expect(await rp.ctx.db.select().from(s.sessions)).toHaveLength(0);
}

beforeEach(async () => {
  resetFederationCaches();
  idp = await startFedServer({ secretKey: "sk_test_federation_idp" });
  rp = await startFedServer({ secretKey: "sk_test_federation_rp" });
  idpUser = await createUser(idp, { email: "ada@acme.test", password: "Sup3rSecret!", firstName: "Ada", lastName: "Lovelace" });
  app = await createOAuthApplication(idp, `${rp.url}/v1/oauth_callback/${PROVIDER}`, { name: "Acme RP" });
  await configureProvider();
  idpBrowser = new Browser();
  await signIn(idpBrowser, idp, idpUser.email, idpUser.password);
});

afterEach(async () => {
  await rp.close();
  await idp.close();
  resetFederationCaches();
});

describe("custom OIDC provider — negative cases", () => {
  it("refuses a tampered or unknown state and creates nothing", async () => {
    const browser = new Browser();
    const { back } = await upToCallback(browser);
    const tampered = new URL(back.toString());
    tampered.searchParams.set("state", `${back.searchParams.get("state")}x`);

    const res = await browser.get(callbackUrl(tampered));
    expect(res.status).toBe(302);
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    // A state that does not match is not consumed, so the real callback can still complete.
    expect(first(await rp.ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, back.searchParams.get("state")!)))).toBeTruthy();
    await expectNothingCreated();

    const unknown = await browser.get(`${rp.url}/v1/oauth_callback/${PROVIDER}?state=nonsense&code=whatever`);
    expect(unknown.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses a replayed code (state is single use, and so is the code at the IdP)", async () => {
    const browser = new Browser();
    const { back } = await upToCallback(browser);
    const firstLanding = await browser.get(callbackUrl(back));
    expect(firstLanding.location!.searchParams.get("__orbit_status")).toBe("transferable");

    // Same state again: the row was consumed, so the callback is refused before the token endpoint.
    const replay = await browser.get(callbackUrl(back));
    expect(replay.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);

    // A fresh state with the old code: the IdP answers invalid_grant and the RP reports a callback error.
    const other = new Browser();
    const fresh = await startSocial(other);
    const freshUrl = new URL(fresh.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const staleCode = back.searchParams.get("code")!;
    const withStaleCode = await other.get(
      `${rp.url}/v1/oauth_callback/${PROVIDER}?state=${freshUrl.searchParams.get("state")}&code=${staleCode}`,
    );
    expect(withStaleCode.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses a callback that arrives in another browser than the one that started the flow", async () => {
    const initiator = new Browser();
    const { back } = await upToCallback(initiator);

    const victim = new Browser();
    const res = await victim.get(callbackUrl(back));
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    expect(victim.cookies.get("__client")).toBeUndefined();
    await expectNothingCreated();
  });

  it("refuses a discovery URL that resolves to a private address when development mode is off", async () => {
    await backend(rp, "PATCH", "/v1/instance", { application: { developmentMode: false, allowedOrigins: [idp.url] } });
    resetFederationCaches();

    const browser = new Browser();
    const res = await startSocial(browser);
    // 127.0.0.1 is a loopback address: refused before any connection is made.
    expect(res.status).toBe(502);
    expect(res.body.errors![0]!.code).toBe("oauth_callback_error");
    expect(res.body.errors![0]!.message).toMatch(/refused/i);
    await expectNothingCreated();
  });

  it("accepts the same private discovery URL in development mode", async () => {
    expect(rp.ctx.settings.get().application.developmentMode).toBe(true);
    const browser = new Browser();
    const { back } = await upToCallback(browser);
    expect((await browser.get(callbackUrl(back))).location!.searchParams.get("__orbit_status")).toBe("transferable");
  });

  it("refuses an unregistered redirect_uri at the IdP", async () => {
    const browser = new Browser();
    const start = await startSocial(browser);
    const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const evil = new URL(`${idp.url}/oauth/authorize`);
    for (const [key, value] of Object.entries({ ...authorizeParams(authorizeUrl), redirect_uri: "https://evil.example/steal" })) {
      if (value != null) evil.searchParams.set(key, value);
    }
    const res = await idpBrowser.get(evil.toString());
    expect(res.status).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("invalid_request");
    await expectNothingCreated();
  });

  it("refuses when the user denies consent at the IdP", async () => {
    const browser = new Browser();
    const start = await startSocial(browser);
    const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const denied = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl), { approve: false });
    expect(denied.searchParams.get("error")).toBe("access_denied");

    const res = await browser.get(callbackUrl(denied));
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("asks for consent again once the granted consent is revoked, and refuses the flow when it is denied", async () => {
    const browser = new Browser();
    const first = await upToCallback(browser);
    expect((await browser.get(callbackUrl(first.back))).location!.searchParams.get("__orbit_status")).toBe("transferable");
    expect(await idp.ctx.db.select().from(s.oauthConsents)).toHaveLength(1);

    // Revoking consent removes the stored grant at the IdP; the next authorization must ask again.
    await idp.ctx.db.delete(s.oauthConsents);
    const second = await startSocial(browser);
    const authorizeUrl = new URL(second.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const authorize = await idpBrowser.get(authorizeUrl.toString());
    expect(authorize.status).toBe(302);
    expect(authorize.location!.pathname).toBe("/oauth-consent");

    const denied = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl), { approve: false });
    expect(denied.searchParams.get("error")).toBe("access_denied");
    const landed = await browser.get(callbackUrl(denied));
    expect(landed.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    expect(await idp.ctx.db.select().from(s.oauthConsents)).toHaveLength(0);
    await expectNothingCreated();
  });

  it("refuses a client the identity provider no longer knows", async () => {
    // Deleting the application at the IdP is how an operator revokes the relying party entirely.
    expect((await backend(idp, "DELETE", `/v1/oauth_applications/${app.id}`)).status).toBe(200);

    const browser = new Browser();
    const start = await startSocial(browser);
    const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const authorized = await idpBrowser.get(authorizeUrl.toString());
    expect(authorized.status).toBe(400);
    expect(authorized.json<{ error: string }>().error).toBe("invalid_request");
    await expectNothingCreated();
  });

  it("refuses a provider that is disabled or has no credentials", async () => {
    await backend(rp, "PATCH", "/v1/instance", { social: { [PROVIDER]: { enabled: false } } });
    const browser = new Browser();
    const res = await startSocial(browser);
    expect(res.status).toBe(400);
    expect(res.body.errors![0]!.code).toBe("oauth_provider_not_enabled");

    await backend(rp, "PATCH", "/v1/instance", { social: { [PROVIDER]: { enabled: true, clientId: "" } } });
    const noCredentials = await startSocial(browser);
    expect(noCredentials.status).toBe(400);
    expect(noCredentials.body.errors![0]!.code).toBe("oauth_provider_not_enabled");
    await expectNothingCreated();
  });

  it("refuses a state issued for a different provider", async () => {
    const browser = new Browser();
    const { back } = await upToCallback(browser);
    const res = await browser.get(callbackUrl(back, "custom_other"));
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
    // The genuine callback still works afterwards: the wrong provider did not consume the state.
    const ok = await browser.get(callbackUrl(back));
    expect(ok.location!.searchParams.get("__orbit_status")).toBe("transferable");
  });

  it("does not leak the client secret or the access token into the API responses", async () => {
    const settings = await backend(rp, "GET", "/v1/instance");
    expect(settings.text).not.toContain(app.client_secret);

    const browser = new Browser();
    const { back } = await upToCallback(browser);
    await browser.get(callbackUrl(back));
    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUpId = transfer.json<{ response: { id: string } }>().response.id;
    await browser.request(`${rp.url}/v1/client/sign_ups/${signUpId}`, { method: "PATCH", json: { password: "Sup3rSecret!" } });
    const accounts = await browser.get(`${rp.url}/v1/client/me/external_accounts`).then((res) => res.json<{ response: { provider: string; provider_user_id: string }[] }>());
    expect(accounts.response[0]!.provider).toBe(PROVIDER);
    expect(JSON.stringify(accounts)).not.toContain("oat_");
  });
});

describe("custom OIDC provider — discovery document endpoints", () => {
  it("refuses a discovery document whose endpoints point at a private address", async () => {
    // A document served from a public-looking host is still not allowed to send the server inward.
    const { createServer } = await import("node:http");
    const served = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/authorize",
          token_endpoint: "http://127.0.0.1:1/token",
          jwks_uri: "https://issuer.example/jwks",
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => served.listen(0, "127.0.0.1", resolve));
    const { port } = served.address() as import("node:net").AddressInfo;
    try {
      await backend(rp, "PATCH", "/v1/instance", { application: { developmentMode: false, allowedOrigins: [idp.url] } });
      resetFederationCaches();
      await configureProvider({}, `http://127.0.0.1:${port}/.well-known/openid-configuration`);
      const res = await startSocial(new Browser());
      expect(res.status).toBe(502);
      expect(res.body.errors![0]!.code).toBe("oauth_callback_error");
      await expectNothingCreated();
    } finally {
      await new Promise<void>((resolve) => served.close(() => resolve()));
    }
  });
});

// ───────────── ID token validation, with a hostile real IdP ─────────────

interface HostileIdp {
  url: string;
  server: Server;
  /** Claims the token endpoint signs into the next id_token (signed with `signingKey`). */
  nextClaims: Record<string, unknown> | null;
  /** A token returned verbatim instead of signing `nextClaims` (used for `alg: none`). */
  rawToken: string | null;
  signingKey: CryptoKey | null;
  kid: string;
  close(): Promise<void>;
}

/**
 * A real HTTP server that is a plausible OIDC provider: discovery, JWKS (instance A's published keys, or a
 * key of its own) and a token endpoint that returns whatever ID token the test staged.
 */
async function startHostileIdp(opts: { kid: string; jwks: JWK[]; signingKey: CryptoKey }): Promise<HostileIdp> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: state.url,
        authorization_endpoint: `${idp.url}/oauth/authorize`,
        token_endpoint: `${state.url}/token`,
        userinfo_endpoint: `${state.url}/userinfo`,
        jwks_uri: `${state.url}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: opts.jwks });
    if (url.pathname === "/userinfo") return json(200, { sub: idpUser.id, email: "ada@acme.test", email_verified: true });
    if (url.pathname === "/token" && req.method === "POST") {
      let idToken = state.rawToken;
      if (!idToken) {
        if (!state.nextClaims) return json(400, { error: "invalid_grant" });
        idToken = await new SignJWT(state.nextClaims)
          .setProtectedHeader({ alg: "RS256", kid: state.kid })
          .sign(state.signingKey!);
      }
      return json(200, { access_token: "hostile-access-token", token_type: "Bearer", expires_in: 3600, id_token: idToken });
    }
    return json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const state: HostileIdp = {
    url: `http://127.0.0.1:${port}`,
    server,
    nextClaims: null,
    rawToken: null,
    signingKey: opts.signingKey,
    kid: opts.kid,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return state;
}

describe("custom OIDC provider — ID token validation", () => {
  let hostile: HostileIdp;
  let jwks: JWK[];
  let idpKey: CryptoKey;
  let idpKid: string;
  let attackerKey: CryptoKey;

  beforeEach(async () => {
    // The hostile provider publishes instance A's real JWKS and can sign with A's key, so a correctly
    // signed token is the control case; `attackerKey` is a key the published set does not contain.
    jwks = (JSON.parse(await (await fetch(`${idp.url}/oauth/jwks`)).text()) as { keys: JWK[] }).keys;
    const keyRow = first(await idp.ctx.db.select().from(s.signingKeys).where(eq(s.signingKeys.active, true)))!;
    idpKey = (await importJWK(JSON.parse(decrypt(idp.ctx.env.encryptionKey, keyRow.privateJwkEnc)) as JWK, keyRow.alg)) as CryptoKey;
    const other = await generateKeyPair("RS256", { extractable: true });
    attackerKey = other.privateKey as CryptoKey;
    idpKid = keyRow.kid;
    hostile = await startHostileIdp({ kid: idpKid, jwks, signingKey: idpKey });
    await configureProvider({ clientId: app.client_id }, `${hostile.url}/.well-known/openid-configuration`);
    resetFederationCaches();
  });

  afterEach(async () => {
    await hostile.close();
  });

  /** Drives the flow through the hostile provider's token endpoint with the staged claims. */
  async function flowWith(claims: Record<string, unknown>, browser = new Browser()) {
    const start = await startSocial(browser);
    expect(start.status).toBe(200);
    const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = authorizeUrl.searchParams.get("nonce")!;
    // The hostile provider forwards to instance A's real authorize endpoint, so a real code comes back.
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl));
    hostile.rawToken = null;
    hostile.nextClaims = { ...claims, nonce: claims.nonce === undefined ? nonce : claims.nonce };
    const res = await browser.get(`${rp.url}/v1/oauth_callback/${PROVIDER}?state=${state}&code=${back.searchParams.get("code")}`);
    return { res, nonce, state };
  }

  const baseClaims = () => ({ sub: idpUser.id, email: "ada@acme.test", email_verified: true });

  it("accepts a correctly signed token (control case)", async () => {
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: app.client_id, exp: Math.floor(Date.now() / 1000) + 300 });
    expect(res.location!.searchParams.get("__orbit_status")).toBe("transferable");
  });

  it("refuses a token with the wrong issuer", async () => {
    const { res } = await flowWith({ ...baseClaims(), iss: "https://evil.example", aud: app.client_id });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses a token with the wrong audience", async () => {
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: "some-other-client" });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses a token with the wrong nonce", async () => {
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: app.client_id, nonce: "replayed-nonce" });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses an expired token", async () => {
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: app.client_id, exp: Math.floor(Date.now() / 1000) - 600 });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("refuses a token whose signature does not verify against the provider's JWKS", async () => {
    hostile.signingKey = attackerKey;
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: app.client_id });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });

  it("does not fall back to userinfo when the ID token fails verification", async () => {
    // The hostile provider serves userinfo naming a real user; a forged ID token must not quietly turn into
    // a userinfo-based sign-in (that is the downgrade the old adapter allowed).
    hostile.signingKey = attackerKey;
    const { res } = await flowWith({ ...baseClaims(), iss: hostile.url, aud: app.client_id });
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);
  });

  it("refuses an unsigned (alg=none) token", async () => {
    const browser = new Browser();
    const start = await startSocial(browser);
    const authorizeUrl = new URL(start.body.response!.first_factor_verification!.external_verification_redirect_url!);
    const state = authorizeUrl.searchParams.get("state")!;
    const nonce = authorizeUrl.searchParams.get("nonce")!;
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl));
    hostile.rawToken = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...baseClaims(), iss: hostile.url, aud: app.client_id, nonce, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url"),
      "",
    ].join(".");
    const res = await browser.get(`${rp.url}/v1/oauth_callback/${PROVIDER}?state=${state}&code=${back.searchParams.get("code")}`);
    expect(res.location!.searchParams.get("__orbit_error")).toBe("oauth_callback_error");
    await expectNothingCreated();
  });
});
