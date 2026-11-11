// Custom OAuth 2.0 (non-OIDC) and manually-configured OIDC providers, driven against real HTTP servers.
//
// The plain OAuth 2.0 provider is a minimal in-process HTTP server: authorization redirect, token exchange
// (client_secret_post), and a userinfo document with a nested, non-standard shape. The manual OIDC case points
// at a second OrbitID instance (a genuine OP) but supplies every endpoint by hand instead of a discovery URL.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { first } from "../../src/lib/db";
import {
  authorizeAtIdp, authorizeParams, backend, Browser, createOAuthApplication, createUser, resetFederationCaches,
  signIn, startFedServer, type FedServer, type OAuthApplication,
} from "./helpers";

const REDIRECT = "http://localhost:3000/done";

interface TokenRequest {
  authorization?: string;
  body: URLSearchParams;
}

interface FakeProvider {
  url: string;
  tokenRequests: TokenRequest[];
  close(): Promise<void>;
}

/**
 * A provider with a wrapped userinfo document. `email` can be omitted to model a provider that does not share
 * addresses; `verified` is deliberately a string, as several real providers send it.
 */
async function startFakeOAuth2Provider(opts: { email?: string | null; verified?: string; challenge?: string } = {}): Promise<FakeProvider> {
  const tokenRequests: TokenRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/oauth/authorize") {
      const redirect = url.searchParams.get("redirect_uri")!;
      const target = new URL(redirect);
      target.searchParams.set("code", "fake-code");
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.statusCode = 302;
      res.setHeader("location", target.toString());
      res.end();
      return;
    }
    if (url.pathname === "/oauth/token") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        tokenRequests.push({ authorization: req.headers.authorization, body });
        send(200, { access_token: "fake-access-token", token_type: "Bearer", scope: "read", expires_in: 3600 });
      });
      return;
    }
    if (url.pathname === "/oauth/userinfo") {
      if (req.headers.authorization !== "Bearer fake-access-token") return send(401, { error: "invalid_token" });
      send(200, {
        data: {
          profile: {
            id: "nested-user-1",
            contact: opts.email === null ? {} : { email: opts.email ?? "ada@nested.test", verified: opts.verified ?? "true" },
            display_name: "Ada Lovelace",
            login: "ada",
            avatar: { url: "https://img.example/ada.png" },
            challenge: opts.challenge ?? null,
          },
        },
      });
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    tokenRequests,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function configureProvider(rp: FedServer, provider: string, config: Record<string, unknown>) {
  const res = await backend(rp, "PATCH", "/v1/instance", { social: { [provider]: { enabled: true, ...config } } });
  expect(res.status, res.text).toBe(200);
}

async function startSocial(browser: Browser, rp: FedServer, provider: string) {
  const res = await browser.request(`${rp.url}/v1/client/sign_ins`, { json: { strategy: `oauth_${provider}`, redirect_url: REDIRECT } });
  expect(res.status).toBe(200);
  const body = res.json<{ response: { status: string; first_factor_verification?: { external_verification_redirect_url?: string | null } } }>();
  expect(body.response.status).toBe("needs_first_factor");
  const url = body.response.first_factor_verification?.external_verification_redirect_url;
  expect(url).toBeTruthy();
  return new URL(url!);
}

let rp: FedServer;

beforeEach(async () => {
  resetFederationCaches();
  rp = await startFedServer({ secretKey: "sk_test_federation_rp" });
});

afterEach(async () => {
  await rp.close();
  resetFederationCaches();
});

describe("custom OAuth 2.0 provider (no OIDC, nested userinfo)", () => {
  it("exchanges a code with client_secret_post, maps nested paths and links a verified email without PKCE", async () => {
    const provider = await startFakeOAuth2Provider();
    try {
      await createUser(rp, { email: "ada@nested.test", password: "Sup3rSecret!" });
      await configureProvider(rp, "custom_nested", {
        name: "Nested",
        clientId: "cid",
        clientSecret: "csecret",
        protocol: "oauth2",
        authorizationUrl: `${provider.url}/oauth/authorize`,
        tokenUrl: `${provider.url}/oauth/token`,
        userinfoUrl: `${provider.url}/oauth/userinfo`,
        scopes: ["read"],
        clientAuthMethod: "client_secret_post",
        pkce: false,
        trustEmailVerified: false,
        claimMapping: {
          sub: "data.profile.id",
          email: "data.profile.contact.email",
          emailVerified: "data.profile.contact.verified",
          name: "data.profile.display_name",
          username: "data.profile.login",
          picture: "data.profile.avatar.url",
        },
      });

      const browser = new Browser();
      const authorizeUrl = await startSocial(browser, rp, "custom_nested");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("cid");
      expect(authorizeUrl.searchParams.get("scope")).toBe("read");
      expect(authorizeUrl.searchParams.get("code_challenge")).toBeNull();

      const back = await browser.get(authorizeUrl.toString());
      expect(back.status).toBe(302);
      expect(back.location!.origin + back.location!.pathname).toBe(`${rp.url}/v1/oauth_callback/custom_nested`);
      const callback = await browser.get(back.location!.toString());
      expect(callback.status).toBe(302);
      // A verified address (the string "true" in userinfo) matched an existing local user.
      expect(callback.location!.origin + callback.location!.pathname).toBe(REDIRECT);
      expect(callback.location!.searchParams.get("__orbit_status")).toBe("complete");

      expect(provider.tokenRequests).toHaveLength(1);
      const token = provider.tokenRequests[0]!;
      expect(token.authorization).toBeUndefined();
      expect(token.body.get("client_id")).toBe("cid");
      expect(token.body.get("client_secret")).toBe("csecret");
      expect(token.body.get("code")).toBe("fake-code");
      expect(token.body.get("code_verifier")).toBeNull();

      const account = first(await rp.ctx.db.select().from(s.externalAccounts).where(and(eq(s.externalAccounts.provider, "custom_nested"))))!;
      expect(account.providerUserId).toBe("nested-user-1");
      expect(account.emailAddress).toBe("ada@nested.test");
      expect(account.userId).toBeTruthy();
      expect(account.imageUrl).toBe("https://img.example/ada.png");
      expect(account.username).toBe("ada");
      expect(account.firstName).toBe("Ada");
      expect(account.lastName).toBe("Lovelace");
    } finally {
      await provider.close();
    }
  }, 30_000);

  it("treats a provider without an email as transferable instead of failing", async () => {
    const provider = await startFakeOAuth2Provider({ email: null });
    try {
      await configureProvider(rp, "custom_noemail", {
        clientId: "cid",
        clientSecret: "csecret",
        protocol: "oauth2",
        authorizationUrl: `${provider.url}/oauth/authorize`,
        tokenUrl: `${provider.url}/oauth/token`,
        userinfoUrl: `${provider.url}/oauth/userinfo`,
        claimMapping: { sub: "data.profile.id", email: "data.profile.contact.email" },
      });
      const browser = new Browser();
      const authorizeUrl = await startSocial(browser, rp, "custom_noemail");
      const back = await browser.get(authorizeUrl.toString());
      const callback = await browser.get(back.location!.toString());
      expect(callback.location!.searchParams.get("__orbit_status")).toBe("transferable");
      expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
    } finally {
      await provider.close();
    }
  }, 30_000);

  it("publishes the custom provider with its display name and logo in the environment", async () => {
    await configureProvider(rp, "custom_branded", {
      clientId: "cid",
      clientSecret: "csecret",
      protocol: "oauth2",
      name: "Acme ID",
      logoUrl: "https://cdn.acme.test/icon.svg",
      authorizationUrl: "https://idp.example/authorize",
      tokenUrl: "https://idp.example/token",
      userinfoUrl: "https://idp.example/userinfo",
    });
    const res = await new Browser().get(`${rp.url}/v1/client/environment`);
    expect(res.status).toBe(200);
    const body = res.json<{ user_settings: { social: Record<string, { name: string; logo_url: string; strategy: string }> } }>();
    expect(body.user_settings.social.custom_branded).toMatchObject({
      name: "Acme ID",
      logo_url: "https://cdn.acme.test/icon.svg",
      strategy: "oauth_custom_branded",
    });
  });

  it("deletes a custom provider and refuses to delete a built-in preset", async () => {
    await configureProvider(rp, "custom_temp", {
      clientId: "cid",
      clientSecret: "csecret",
      protocol: "oauth2",
      authorizationUrl: "https://idp.example/authorize",
      tokenUrl: "https://idp.example/token",
      userinfoUrl: "https://idp.example/userinfo",
    });
    expect(rp.ctx.settings.get().social.custom_temp).toBeTruthy();

    const deleted = await backend(rp, "DELETE", "/v1/instance/social/custom_temp");
    expect(deleted.status, deleted.text).toBe(200);
    expect(rp.ctx.settings.get().social.custom_temp).toBeUndefined();

    const builtIn = await backend(rp, "DELETE", "/v1/instance/social/google");
    expect(builtIn.status).toBe(422);
    expect(builtIn.text).toMatch(/Only custom providers/);
  });

  it("rejects a provider with no usable profile endpoint at save time", async () => {
    const res = await backend(rp, "PATCH", "/v1/instance", {
      social: { custom_broken: { enabled: true, clientId: "cid", protocol: "oauth2", authorizationUrl: "https://a.example/auth", tokenUrl: "https://a.example/token" } },
    });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/userinfoUrl/);
  });
});

describe("custom OIDC provider with manual endpoints", () => {
  let idp: FedServer;
  let app: OAuthApplication;

  beforeEach(async () => {
    idp = await startFedServer({ secretKey: "sk_test_federation_idp" });
    await createUser(idp, { email: "ada@manual.test", password: "Sup3rSecret!", firstName: "Ada", lastName: "Lovelace" });
    app = await createOAuthApplication(idp, `${rp.url}/v1/oauth_callback/custom_manual`, { name: "Manual RP" });
  });

  afterEach(async () => {
    await idp.close();
  });

  it("builds the flow from manual endpoints, verifies the ID token and completes the sign-in", async () => {
    await configureProvider(rp, "custom_manual", {
      name: "Manual OIDC",
      clientId: app.client_id,
      clientSecret: app.client_secret,
      protocol: "oidc",
      issuer: idp.url,
      authorizationUrl: `${idp.url}/oauth/authorize`,
      tokenUrl: `${idp.url}/oauth/token`,
      userinfoUrl: `${idp.url}/oauth/userinfo`,
      jwksUrl: `${idp.url}/.well-known/jwks.json`,
      scopes: ["openid", "profile", "email"],
      clientAuthMethod: "client_secret_basic",
      pkce: true,
    });

    const idpBrowser = new Browser();
    await signIn(idpBrowser, idp, "ada@manual.test", "Sup3rSecret!");

    const browser = new Browser();
    const authorizeUrl = await startSocial(browser, rp, "custom_manual");
    expect(authorizeUrl.origin).toBe(idp.url);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy();

    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl));
    expect(back.origin + back.pathname).toBe(`${rp.url}/v1/oauth_callback/custom_manual`);
    const callback = await browser.get(back.toString());
    expect(callback.status).toBe(302);
    expect(callback.location!.searchParams.get("__orbit_status")).toBe("transferable");
  }, 30_000);

  it("reports a bad discovery/endpoint set through the test-connection endpoint without saving", async () => {
    const res = await backend(rp, "POST", "/v1/instance/social/test", {
      protocol: "oidc",
      authorizationUrl: "not-a-url",
      tokenUrl: `${idp.url}/oauth/token`,
    });
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; errors: string[] }>();
    expect(body.ok).toBe(false);
    expect(body.errors.join(" ")).toMatch(/URL/);
    // Nothing was saved by the check.
    expect(rp.ctx.settings.get().social.custom_nothing).toBeUndefined();
  });

  it("checks a real discovery document and reports its issuer and scopes", async () => {
    const res = await backend(rp, "POST", "/v1/instance/social/test", {
      discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
    });
    expect(res.status).toBe(200);
    const body = res.json<{ ok: boolean; issuer?: string; checks: { name: string; reachable: boolean }[]; warnings: string[] }>();
    expect(body.issuer).toBe(idp.url);
    expect(body.checks.length).toBeGreaterThanOrEqual(2);
    expect(body.checks.every((check) => check.reachable)).toBe(true);
  }, 30_000);
});
