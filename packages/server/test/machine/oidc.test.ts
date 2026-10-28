import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { setup, authHeaders, insertUser, insertClientSession, BASE_URL } from "./helpers";
import { TEST_PUBLIC_JWK } from "./fake-tokens";

vi.mock("../../src/services/tokens", () => import("./fake-tokens"));

type Harness = Awaited<ReturnType<typeof setup>>;
const json = (body: unknown) => JSON.stringify(body);
const REDIRECT_URI = "http://localhost:3000/callback";
const verifier = () => randomBytes(32).toString("base64url");
const challengeFor = (v: string) => createHash("sha256").update(v).digest("base64url");

async function createApp(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/oauth_applications", {
    method: "POST",
    headers: authHeaders(),
    body: json({ name: "Test App", redirect_uris: [REDIRECT_URI], consent_screen_enabled: false, ...overrides }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

const form = (h: Harness, path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

/** Runs /oauth/authorize and returns the parsed redirect query. */
async function authorize(h: Harness, params: Record<string, string>, cookie?: string) {
  const res = await h.app.request(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  const location = res.headers.get("location")!;
  return { location, query: Object.fromEntries(new URL(location).searchParams) };
}

async function codeFlow(h: Harness, app: { client_id: string; client_secret?: string }, cookie: string, scopes = "openid profile email offline_access") {
  const pkce = verifier();
  const { query } = await authorize(h, {
    client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: scopes,
    state: "state-123", nonce: "nonce-123", code_challenge: challengeFor(pkce), code_challenge_method: "S256",
  }, cookie);
  expect(query.code).toBeTruthy();
  const tokenResponse = await form(h, "/oauth/token", {
    grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
    client_id: app.client_id, client_secret: app.client_secret ?? "",
  });
  expect(tokenResponse.status).toBe(200);
  return { tokens: await tokenResponse.json(), code: query.code! };
}

describe("OIDC provider — discovery + authorize", () => {
  let h: Harness;
  let user: ReturnType<typeof insertUser>;
  let session: ReturnType<typeof insertClientSession>;
  beforeEach(async () => {
    h = await setup();
    user = insertUser(h.ctx);
    session = insertClientSession(h.ctx, user.userId);
  });

  it("publishes a correct discovery document and JWKS", async () => {
    const res = await h.app.request("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.issuer).toBe(BASE_URL);
    expect(doc.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
    expect(doc.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(doc.userinfo_endpoint).toBe(`${BASE_URL}/oauth/userinfo`);
    expect(doc.jwks_uri).toBe(`${BASE_URL}/oauth/jwks`);
    expect(doc.code_challenge_methods_supported).toContain("S256");
    expect(doc.id_token_signing_alg_values_supported).toContain("RS256");
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));

    const jwks = await (await h.app.request("/oauth/jwks")).json();
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", kid: "test-key" });
  });

  it("redirects a signed-out user to the app sign-in with the authorize URL", async () => {
    const app = await createApp(h);
    const res = await h.app.request(`/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", code_challenge: challengeFor(verifier()),
    })}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("http://localhost:3000/sign-in");
    expect(location.searchParams.get("redirect_url")).toContain("/oauth/authorize?");
  });

  it("issues an authorization code with state and validates PKCE / redirect URIs", async () => {
    const app = await createApp(h);
    const pkce = verifier();
    const { query } = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid profile",
      state: "abc", code_challenge: challengeFor(pkce), code_challenge_method: "S256",
    }, session.cookie);
    expect(query.code).toMatch(/^oac_/);
    expect(query.state).toBe("abc");

    const missingPkce = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", state: "s2",
    }, session.cookie);
    expect(missingPkce.query.error).toBe("invalid_request");
    expect(missingPkce.query.state).toBe("s2");

    const badScope = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid admin",
      code_challenge: challengeFor(pkce),
    }, session.cookie);
    expect(badScope.query.error).toBe("invalid_scope");

    const badRedirect = await h.app.request(`/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, redirect_uri: "http://evil.example/cb", response_type: "code", scope: "openid",
    })}`, { headers: { cookie: session.cookie } });
    expect(badRedirect.status).toBe(400);
    expect((await badRedirect.json()).error).toBe("invalid_request");

    const unknownClient = await h.app.request(`/oauth/authorize?${new URLSearchParams({ client_id: "oa_nope", redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid" })}`);
    expect(unknownClient.status).toBe(400);
  });
});

describe("OIDC provider — token lifecycle", () => {
  let h: Harness;
  let user: ReturnType<typeof insertUser>;
  let session: ReturnType<typeof insertClientSession>;
  let app: { id: string; client_id: string; client_secret: string };
  beforeEach(async () => {
    h = await setup();
    user = insertUser(h.ctx);
    session = insertClientSession(h.ctx, user.userId);
    app = await createApp(h);
  });

  it("exchanges a code for access/refresh/id tokens and serves userinfo", async () => {
    const { tokens, code } = await codeFlow(h, app, session.cookie);
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toMatch(/^ort_/);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("openid profile email offline_access");

    const header = decodeProtectedHeader(tokens.id_token);
    expect(header.alg).toBe("RS256");
    const { payload } = await jwtVerify(tokens.id_token, TEST_PUBLIC_JWK);
    expect(payload).toMatchObject({
      iss: BASE_URL, aud: app.client_id, sub: user.userId, nonce: "nonce-123",
      email: "user@example.com", email_verified: true, name: "Ada Lovelace", given_name: "Ada", family_name: "Lovelace",
    });

    const userinfo = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({ sub: user.userId, email: "user@example.com", email_verified: true, name: "Ada Lovelace" });

    const replay = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: "x",
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  it("rotates refresh tokens, detects reuse and kills the family", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    const refreshed = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.refresh_token).toMatch(/^ort_/);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.id_token).toBeTruthy();

    // Reusing the rotated-out refresh token is treated as theft.
    const reuse = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");

    const deadAccess = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${next.access_token}` } });
    expect(deadAccess.status).toBe(401);
    const deadRefresh = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: next.refresh_token,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(deadRefresh.status).toBe(400);
  });

  it("introspects and revokes tokens (RFC 7662 / 7009)", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    const auth = { authorization: `Basic ${Buffer.from(`${app.client_id}:${app.client_secret}`).toString("base64")}` };

    const introspected = await form(h, "/oauth/introspect", { token: tokens.access_token }, auth);
    expect(introspected.status).toBe(200);
    expect(await introspected.json()).toMatchObject({
      active: true, client_id: app.client_id, sub: user.userId, token_type: "Bearer", iss: BASE_URL,
    });

    const foreign = await createApp(h, { name: "Other" });
    const notMine = await form(h, "/oauth/introspect", { token: tokens.access_token }, {
      authorization: `Basic ${Buffer.from(`${foreign.client_id}:${foreign.client_secret}`).toString("base64")}`,
    });
    expect(await notMine.json()).toEqual({ active: false });

    const revoked = await form(h, "/oauth/revoke", { token: tokens.access_token }, auth);
    expect(revoked.status).toBe(200);
    const afterRevoke = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(afterRevoke.status).toBe(401);
    const introspectedAfter = await form(h, "/oauth/introspect", { token: tokens.access_token }, auth);
    expect(await introspectedAfter.json()).toEqual({ active: false });

    // Revoking the refresh token revokes the rotated family it belongs to.
    await form(h, "/oauth/revoke", { token: tokens.refresh_token }, auth);
    const refreshAfter = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(refreshAfter.status).toBe(400);
  });

  it("enforces client authentication and PKCE verification", async () => {
    const pkce = verifier();
    const { query } = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
      code_challenge: challengeFor(pkce), code_challenge_method: "S256",
    }, session.cookie);

    const wrongSecret = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: "oas_wrong",
    });
    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).error).toBe("invalid_client");

    const wrongVerifier = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: "not-the-verifier",
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");

    const rotated = await h.app.request(`/v1/oauth_applications/${app.id}/rotate_secret`, { method: "POST", headers: authHeaders() });
    const rotatedBody = await rotated.json();
    expect(rotatedBody.client_secret).toMatch(/^oas_/);
    expect(rotatedBody.client_secret).not.toBe(app.client_secret);

    const withOldSecret = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(withOldSecret.status).toBe(401);
  });

  it("supports public clients (no secret, PKCE mandatory)", async () => {
    const publicApp = await createApp(h, { name: "SPA", public: true });
    expect(publicApp.client_secret).toBeUndefined();
    const pkce = verifier();
    const { query } = await authorize(h, {
      client_id: publicApp.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email",
      code_challenge: challengeFor(pkce), code_challenge_method: "S256",
    }, session.cookie);
    const tokenResponse = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce, client_id: publicApp.client_id,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toBeUndefined(); // scope did not include offline_access

    const withSecret = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: "oac_x", redirect_uri: REDIRECT_URI, client_id: publicApp.client_id, client_secret: "nope",
    });
    expect(withSecret.status).toBe(401);
  });
});

describe("OIDC provider — consent", () => {
  let h: Harness;
  let user: ReturnType<typeof insertUser>;
  let session: ReturnType<typeof insertClientSession>;
  beforeEach(async () => {
    h = await setup();
    user = insertUser(h.ctx);
    session = insertClientSession(h.ctx, user.userId);
  });

  it("sends users to the consent screen, stores consent and returns a redirect URL", async () => {
    const app = await createApp(h, { name: "Consent App", consent_screen_enabled: true });
    const pkce = verifier();
    const params = {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid profile",
      state: "s1", code_challenge: challengeFor(pkce), code_challenge_method: "S256",
    };
    const { location, query } = await authorize(h, params, session.cookie);
    expect(location).toContain("http://localhost:3000/oauth-consent");
    expect(query.client_id).toBe(app.client_id);
    expect(query.scope).toBe("openid profile");
    expect(query.redirect_url).toContain("/oauth/authorize?");

    const info = await h.app.request(`/oauth/consent_info?client_id=${app.client_id}&scope=openid%20profile`, { headers: { cookie: session.cookie } });
    expect(info.status).toBe(200);
    const infoBody = await info.json();
    expect(infoBody.client).toMatchObject({ client_id: app.client_id, name: "Consent App" });
    expect(infoBody.scopes.map((s: { scope: string }) => s.scope)).toEqual(["openid", "profile"]);

    const consent = await h.app.request("/oauth/consent", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: json({ ...params, client_id: app.client_id, approve: true, scopes: ["openid", "profile"] }),
    });
    expect(consent.status).toBe(200);
    const redirectUrl = new URL((await consent.json()).redirect_url);
    const code = redirectUrl.searchParams.get("code")!;
    expect(code).toMatch(/^oac_/);
    expect(redirectUrl.searchParams.get("state")).toBe("s1");

    // Consent is remembered: the next authorize call issues a code directly.
    const again = await authorize(h, params, session.cookie);
    expect(again.query.code).toBeTruthy();

    const tokenResponse = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(tokenResponse.status).toBe(200);
  });

  it("returns access_denied without issuing a code, and requires a session for consent endpoints", async () => {
    const app = await createApp(h, { consent_screen_enabled: true });
    const denied = await h.app.request("/oauth/consent", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: json({ client_id: app.client_id, redirect_uri: REDIRECT_URI, state: "s9", approve: false, scopes: ["openid"] }),
    });
    expect(denied.status).toBe(200);
    const url = new URL((await denied.json()).redirect_url);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("code")).toBeNull();
    expect(url.searchParams.get("state")).toBe("s9");

    const noSession = await h.app.request(`/oauth/consent_info?client_id=${app.client_id}&scope=openid`);
    expect(noSession.status).toBe(401);
  });
});

describe("OAuth application management", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("CRUDs applications behind the secret key", async () => {
    const unauthorized = await h.app.request("/v1/oauth_applications");
    expect(unauthorized.status).toBe(401);

    const app = await createApp(h);
    expect(app.object).toBe("oauth_application");
    expect(app.client_id).toMatch(/^oa_/);
    expect(app.redirect_uris).toEqual([REDIRECT_URI]);
    expect(app.pkce_required).toBe(true);

    const list = await h.app.request("/v1/oauth_applications", { headers: authHeaders() });
    expect((await list.json()).total_count).toBe(1);

    const patched = await h.app.request(`/v1/oauth_applications/${app.id}`, {
      method: "PATCH", headers: authHeaders(), body: json({ name: "Renamed", redirect_uris: ["http://localhost:3000/other"] }),
    });
    expect(await patched.json()).toMatchObject({ name: "Renamed", redirect_uris: ["http://localhost:3000/other"] });

    const deleted = await h.app.request(`/v1/oauth_applications/${app.id}`, { method: "DELETE", headers: authHeaders() });
    expect((await deleted.json()).deleted).toBe(true);
    const gone = await h.app.request(`/v1/oauth_applications/${app.id}`, { headers: authHeaders() });
    expect(gone.status).toBe(404);
  });
});
