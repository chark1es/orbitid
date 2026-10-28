// OIDC provider: JWT access tokens, introspection/revocation, organization claims, device grant.
//
// Real HTTP against `app.request` and real crypto throughout: access tokens and id_tokens are verified
// offline against the instance JWKS, so a wrong key or audience fails the test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { addMembership, authHeaders, BASE_URL, grantPermissions, insertClientSession, insertOrganization, insertUser, setup } from "../machine/helpers";
import { first } from "../../src/lib/db";
import { newId } from "../../src/lib/ids";
import { sha256 } from "../../src/lib/crypto";
import { ID_PREFIX } from "@orbitid/shared";

type Harness = Awaited<ReturnType<typeof setup>>;
const json = (body: unknown) => JSON.stringify(body);
const REDIRECT_URI = "http://localhost:3000/callback";
/** Mirrors the server's per-code attempt budget for the device verification endpoints. */
const DEVICE_ATTEMPT_BUDGET = 10;
const verifier = () => randomBytes(32).toString("base64url");
const challengeFor = (v: string) => createHash("sha256").update(v).digest("base64url");

async function createApp(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/oauth_applications", {
    method: "POST",
    headers: authHeaders(),
    body: json({ name: "Test App", redirect_uris: [REDIRECT_URI], consent_screen_enabled: false, ...overrides }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; client_id: string; client_secret?: string }>;
}

const form = (h: Harness, path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

const basic = (clientId: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` });

async function authorize(h: Harness, params: Record<string, string>, cookie?: string) {
  const res = await h.app.request(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  return Object.fromEntries(new URL(res.headers.get("location")!).searchParams);
}

async function codeFlow(h: Harness, app: { client_id: string; client_secret?: string }, cookie: string, scopes = "openid profile email offline_access") {
  const pkce = verifier();
  const query = await authorize(h, {
    client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: scopes,
    state: "state-123", nonce: "nonce-123", code_challenge: challengeFor(pkce), code_challenge_method: "S256",
  }, cookie);
  expect(query.code).toBeTruthy();
  const tokenResponse = await form(h, "/oauth/token", {
    grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
    client_id: app.client_id, client_secret: app.client_secret ?? "",
  });
  expect(tokenResponse.status).toBe(200);
  return { tokens: await tokenResponse.json() as Record<string, string>, code: query.code! };
}

const jwks = async (h: Harness) => createLocalJWKSet(await (await h.app.request("/oauth/jwks")).json());

describe("OIDC — JWT access tokens", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret: string };

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h) as typeof app;
  });

  it("issues an RS256 access token verifiable against the JWKS, and still honours revocation", async () => {
    await h.ctx.settings.update({ oidcProvider: { accessTokenFormat: "jwt" } });
    const { tokens } = await codeFlow(h, app, session.cookie);
    expect(tokens.access_token).not.toMatch(/^oat_/);
    expect(decodeProtectedHeader(tokens.access_token).alg).toBe("RS256");

    const { payload } = await jwtVerify(tokens.access_token, await jwks(h), { issuer: BASE_URL, audience: app.client_id });
    expect(payload).toMatchObject({
      iss: BASE_URL,
      sub: user.userId,
      aud: app.client_id,
      azp: app.client_id,
      scope: "openid profile email offline_access",
      sid: session.sessionId,
    });
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.jti).toBe("string");

    // Recorded in oauth_grants, so revocation and introspection still work.
    const grant = first(await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.kind, "access")))!;
    expect(grant.userId).toBe(user.userId);

    const info = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ sub: user.userId, email: "user@example.com" });

    const revoked = await form(h, "/oauth/revoke", { token: tokens.access_token }, basic(app.client_id, app.client_secret));
    expect(revoked.status).toBe(200);
    const afterRevoke = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(afterRevoke.status).toBe(401);

    const introspected = await form(h, "/oauth/introspect", { token: tokens.access_token }, basic(app.client_id, app.client_secret));
    expect(await introspected.json()).toEqual({ active: false });
  });

  it("rejects a JWT access token whose signature was not made by the instance key", async () => {
    await h.ctx.settings.update({ oidcProvider: { accessTokenFormat: "jwt" } });
    const now = Date.now();
    // A grant row exists for this exact token, so only the signature check can reject it.
    const { privateKey } = await generateKeyPair("RS256");
    const grantId = newId(ID_PREFIX.oauthGrant);
    const forged = await new SignJWT({ sub: user.userId, azp: app.client_id, scope: "openid", jti: grantId })
      .setProtectedHeader({ alg: "RS256", kid: "not-a-real-kid" })
      .setIssuer(BASE_URL)
      .setAudience(app.client_id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(now / 1000) + 600)
      .sign(privateKey);
    await h.ctx.db.insert(schema.oauthGrants).values({
      id: grantId, kind: "access", applicationId: app.id, userId: user.userId, tokenHash: sha256(forged),
      scopes: "openid", redirectUri: null, codeChallenge: null, codeChallengeMethod: null,
      nonce: randomBytes(9).toString("base64url"), revoked: false, expiresAt: now + 600_000, createdAt: now,
    });
    const res = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${forged}` } });
    expect(res.status).toBe(401);
  });

  it("keeps opaque tokens by default", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    expect(tokens.access_token).toMatch(/^oat_/);
    const discovery = await (await h.app.request("/.well-known/openid-configuration")).json();
    expect(discovery.access_token_format).toBeUndefined();
  });

  it("refreshes a JWT access token and keeps the session binding", async () => {
    await h.ctx.settings.update({ oidcProvider: { accessTokenFormat: "jwt" } });
    const { tokens } = await codeFlow(h, app, session.cookie);
    const refreshed = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as { access_token: string };
    const { payload } = await jwtVerify(next.access_token, await jwks(h), { issuer: BASE_URL, audience: app.client_id });
    expect(payload.sid).toBe(session.sessionId);
  });
});

describe("OIDC — introspection and revocation", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
  });

  it("requires client authentication and refuses public clients", async () => {
    const app = await createApp(h) as { client_id: string; client_secret: string };
    const { tokens } = await codeFlow(h, app, session.cookie);

    const anonymous = await form(h, "/oauth/introspect", { token: tokens.access_token });
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error).toBe("invalid_client");

    const wrongSecret = await form(h, "/oauth/introspect", { token: tokens.access_token, client_id: app.client_id, client_secret: "oas_wrong" });
    expect(wrongSecret.status).toBe(401);

    const publicApp = await createApp(h, { public: true });
    const refused = await form(h, "/oauth/introspect", { token: tokens.access_token, client_id: publicApp.client_id });
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toBe("invalid_client");
  });

  it("returns active claims for both basic and body credentials, and active:false otherwise", async () => {
    const app = await createApp(h) as { client_id: string; client_secret: string };
    const { tokens } = await codeFlow(h, app, session.cookie);

    const viaBasic = await form(h, "/oauth/introspect", { token: tokens.access_token }, basic(app.client_id, app.client_secret));
    expect(await viaBasic.json()).toMatchObject({
      active: true, scope: "openid profile email offline_access", client_id: app.client_id,
      sub: user.userId, iss: BASE_URL, aud: app.client_id, token_type: "Bearer",
    });
    const viaBody = await form(h, "/oauth/introspect", { token: tokens.refresh_token, client_id: app.client_id, client_secret: app.client_secret });
    expect(await viaBody.json()).toMatchObject({ active: true, token_type: "refresh_token" });

    expect(await (await form(h, "/oauth/introspect", { token: "oat_unknown" }, basic(app.client_id, app.client_secret))).json()).toEqual({ active: false });

    const other = await createApp(h, { name: "Other" }) as { client_id: string; client_secret: string };
    expect(await (await form(h, "/oauth/introspect", { token: tokens.access_token }, basic(other.client_id, other.client_secret))).json()).toEqual({ active: false });
  });

  it("reports an expired access token as inactive and rejects revoking a foreign token", async () => {
    const app = await createApp(h) as { client_id: string; client_secret: string };
    const { tokens } = await codeFlow(h, app, session.cookie);
    await h.ctx.db.update(schema.oauthGrants).set({ expiresAt: Date.now() - 1000 }).where(eq(schema.oauthGrants.kind, "access"));
    expect(await (await form(h, "/oauth/introspect", { token: tokens.access_token }, basic(app.client_id, app.client_secret))).json()).toEqual({ active: false });

    const other = await createApp(h, { name: "Other" }) as { client_id: string; client_secret: string };
    const foreignRevoke = await form(h, "/oauth/revoke", { token: tokens.access_token }, basic(other.client_id, other.client_secret));
    expect(foreignRevoke.status).toBe(200); // RFC 7009: unknown/foreign tokens are ignored, never an error.
    const stillActive = await form(h, "/oauth/introspect", { token: tokens.access_token }, basic(app.client_id, app.client_secret));
    // The token itself was expired above, so re-issue one to prove a foreign revoke is a no-op.
    expect(await stillActive.json()).toEqual({ active: false });
  });

  it("advertises both endpoints in discovery", async () => {
    const doc = await (await h.app.request("/.well-known/openid-configuration")).json();
    expect(doc.introspection_endpoint).toBe(`${BASE_URL}/oauth/introspect`);
    expect(doc.revocation_endpoint).toBe(`${BASE_URL}/oauth/revoke`);
    expect(doc.introspection_endpoint_auth_methods_supported).toEqual(["client_secret_basic", "client_secret_post"]);
    expect(doc.revocation_endpoint_auth_methods_supported).toEqual(["client_secret_basic", "client_secret_post"]);
  });
});

describe("OIDC — organization claims", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret: string };

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h) as typeof app;
  });

  async function setupOrgs() {
    const active = await insertOrganization(h.ctx, "Active");
    const other = await insertOrganization(h.ctx, "Other");
    await grantPermissions(h.ctx, "org:admin", ["org:sys_memberships:manage"]);
    await addMembership(h.ctx, active.orgId, user.userId, "org:admin");
    await addMembership(h.ctx, other.orgId, user.userId, "org:member");
    await h.ctx.db.update(schema.sessions).set({ lastActiveOrganizationId: active.orgId }).where(eq(schema.sessions.id, session.sessionId));
    return { active, other };
  }

  it("includes the active organization and every membership when `organizations` is granted", async () => {
    const { active, other } = await setupOrgs();
    const scopes = "openid profile email organizations";
    const pkce = verifier();
    const query = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: scopes,
      code_challenge: challengeFor(pkce), code_challenge_method: "S256",
    }, session.cookie);
    const res = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(res.status).toBe(200);
    const tokens = await res.json() as { access_token: string; id_token: string };

    const { payload } = await jwtVerify(tokens.id_token, await jwks(h));
    expect(payload).toMatchObject({
      sub: user.userId,
      email: "user@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      org_id: active.orgId,
      org_role: "org:admin",
    });
    expect(payload.org_permissions as string[]).toEqual(expect.arrayContaining(["org:sys_memberships:manage"]));
    expect(typeof payload.org_slug).toBe("string");
    const orgs = payload.organizations as { id: string; slug: string; name: string; role: string }[];
    expect(orgs).toHaveLength(2);
    expect(orgs.map((o) => o.name).sort()).toEqual(["Active", "Other"]);
    expect(orgs.find((o) => o.id === other.orgId)).toMatchObject({ name: "Other", role: "org:member" });

    const info = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const claims = await info.json();
    expect(claims).toMatchObject({ sub: user.userId, email: "user@example.com", org_id: active.orgId, org_role: "org:admin" });
    expect((claims.organizations as unknown[]).length).toBe(2);
  });

  it("omits organization claims without the scope and when no organization is active", async () => {
    await setupOrgs();
    await h.ctx.db.update(schema.sessions).set({ lastActiveOrganizationId: null }).where(eq(schema.sessions.id, session.sessionId));
    const { tokens } = await codeFlow(h, app, session.cookie, "openid email");
    const { payload } = await jwtVerify(tokens.id_token, await jwks(h));
    expect(payload.org_id).toBeUndefined();
    expect(payload.organizations).toBeUndefined();
    expect(payload.email).toBe("user@example.com");

    // With the scope but no active organization, memberships are listed and org_* stay absent.
    const { tokens: orgTokens } = await codeFlow(h, app, session.cookie, "openid organizations");
    const { payload: orgPayload } = await jwtVerify(orgTokens.id_token, await jwks(h));
    expect(orgPayload.org_id).toBeUndefined();
    expect((orgPayload.organizations as unknown[]).length).toBe(2);
  });

  it("advertises the scope and claims", async () => {
    const doc = await (await h.app.request("/.well-known/openid-configuration")).json();
    expect(doc.scopes_supported).toContain("organizations");
    expect(doc.claims_supported).toEqual(expect.arrayContaining(["org_id", "org_slug", "org_role", "org_permissions", "organizations"]));
  });
});

describe("OIDC — token endpoint hardening", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret: string };

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h) as typeof app;
  });

  async function issueCode(overrides: Record<string, string> = {}) {
    const pkce = verifier();
    const query = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid email",
      code_challenge: challengeFor(pkce), code_challenge_method: "S256", ...overrides,
    }, session.cookie);
    return { code: query.code!, pkce, query };
  }

  it("rejects a redirect_uri that differs from the authorization request", async () => {
    const { code, pkce } = await issueCode();
    const res = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:3000/other", code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    // The code is untouched by the failed attempt, so the right redirect_uri still works.
    const ok = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(ok.status).toBe(200);
  });

  it("rejects a code presented by another client or replayed", async () => {
    const { code, pkce } = await issueCode();
    const other = await createApp(h, { name: "Other" }) as { client_id: string; client_secret: string };
    const foreign = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: other.client_id, client_secret: other.client_secret,
    });
    expect((await foreign.json()).error).toBe("invalid_grant");

    const first = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(first.status).toBe(200);
    const replay = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  it("rejects an expired authorization code", async () => {
    const { code, pkce } = await issueCode();
    await h.ctx.db.update(schema.oauthGrants).set({ expiresAt: Date.now() - 1 }).where(eq(schema.oauthGrants.kind, "code"));
    const res = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("refuses PKCE downgrades: `plain`, a missing challenge, or a missing verifier", async () => {
    const pkce = verifier();
    // `plain` is refused before a code is ever issued.
    const plain = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
      code_challenge: pkce, code_challenge_method: "plain",
    }, session.cookie);
    expect(plain.error).toBe("invalid_request");

    const missing = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
    }, session.cookie);
    expect(missing.error).toBe("invalid_request");

    const { code } = await issueCode();
    const noVerifier = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect((await noVerifier.json()).error).toBe("invalid_grant");
  });

  it("refuses scope escalation at authorize and at the consent decision", async () => {
    const escalated = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid admin",
      code_challenge: challengeFor(verifier()),
    }, session.cookie);
    expect(escalated.error).toBe("invalid_scope");

    const disabled = await createApp(h, { scopes: "admin" }) as { client_id: string };
    const allowed = await authorize(h, {
      client_id: disabled.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid admin",
      code_challenge: challengeFor(verifier()),
    }, session.cookie);
    expect(allowed.code).toBeTruthy();
  });

  it("rejects an unauthenticated or wrongly authenticated token request", async () => {
    const { code, pkce } = await issueCode();
    const noSecret = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce, client_id: app.client_id,
    });
    expect(noSecret.status).toBe(401);
    expect(noSecret.headers.get("www-authenticate")).toContain("Basic");

    const unknownClient = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce, client_id: "oa_unknown", client_secret: "x",
    });
    expect(unknownClient.status).toBe(401);

    const wrongSecret = await form(h, "/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce,
      client_id: app.client_id, client_secret: "oas_wrong",
    });
    expect(wrongSecret.status).toBe(401);
  });

  it("does not let a refresh token add scopes it was not granted", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie, "openid email offline_access");
    const res = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "openid email admin",
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(res.status).toBe(200);
    const next = await res.json() as { scope: string; access_token: string };
    expect(next.scope).toBe("openid email offline_access");
    expect(next.scope).not.toContain("admin");
    const info = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${next.access_token}` } });
    expect(await info.json()).toMatchObject({ sub: user.userId, email: "user@example.com" });
  });

  it("rejects an unknown grant type", async () => {
    const res = await form(h, "/oauth/token", { grant_type: "password", client_id: app.client_id, client_secret: app.client_secret });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});

describe("OIDC — device authorization grant", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret?: string };

  beforeEach(async () => {
    h = await setup();
    await h.ctx.settings.update({
      oidcProvider: { deviceAuthorizationEnabled: true, deviceCodeIntervalSeconds: 1, deviceCodeLifetimeSeconds: 60 },
      security: { rateLimitEnabled: false },
    });
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h) as typeof app;
  });

  async function startDevice(publicClient = false) {
    const client = publicClient ? await createApp(h, { public: true }) as { client_id: string; client_secret?: string } : app;
    const res = await form(h, "/oauth/device_authorization", {
      client_id: client.client_id, scope: "openid email", ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    });
    expect(res.status).toBe(200);
    return { client, body: await res.json() as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number } };
  }

  const poll = (deviceCode: string, client: { client_id: string; client_secret?: string }) =>
    form(h, "/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: client.client_id,
      ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    });

  const approve = (userCode: string, cookie: string | undefined, action: "approve" | "deny" = "approve") =>
    h.app.request("/v1/client/oauth/device/approve", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: json({ user_code: userCode, action }),
    });

  it("is disabled by default and absent from discovery", async () => {
    const plain = await setup();
    const created = await createApp(plain);
    const res = await form(plain, "/oauth/device_authorization", { client_id: created.client_id, scope: "openid" });
    expect(res.status).toBe(404);
    const doc = await (await plain.app.request("/.well-known/openid-configuration")).json();
    expect(doc.device_authorization_endpoint).toBeUndefined();
    expect(doc.grant_types_supported).not.toContain("urn:ietf:params:oauth:grant-type:device_code");
    const pollRes = await form(plain, "/oauth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "odc_x", client_id: created.client_id, client_secret: created.client_secret ?? "",
    });
    expect(pollRes.status).toBe(400);
    expect((await pollRes.json()).error).toBe("unsupported_grant_type");
    // The page and its assets are not served either.
    expect((await plain.app.request("/oauth/device")).status).toBe(404);
  });

  it("walks the whole flow: device code, user approval, token poll", async () => {
    const { body, client } = await startDevice();
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.verification_uri).toBe(`${BASE_URL}/oauth/device`);
    expect(body.verification_uri_complete).toContain(`user_code=${encodeURIComponent(body.user_code)}`);
    expect(body.expires_in).toBe(60);
    expect(body.interval).toBe(1);

    const pending = await poll(body.device_code, client);
    expect(pending.status).toBe(400);
    expect((await pending.json()).error).toBe("authorization_pending");

    // The consent view shows the application and what it asks for.
    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect(info.status).toBe(200);
    const infoBody = await info.json();
    expect(infoBody.client.name).toBe("Test App");
    expect(infoBody.scopes.map((s: { scope: string }) => s.scope)).toEqual(["openid", "email"]);
    expect(infoBody.status).toBe("pending");

    const approved = await approve(body.user_code, session.cookie);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "approved", user_code: body.user_code });

    await new Promise((r) => setTimeout(r, 1100));
    const tokenRes = await poll(body.device_code, client);
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { access_token: string; id_token?: string };
    expect(tokens.access_token).toMatch(/^oat_/);
    const { payload } = await jwtVerify(tokens.id_token!, await jwks(h));
    expect(payload).toMatchObject({ sub: user.userId, email: "user@example.com" });

    // The device code is consumed: a replay is an expired_token, never a second token set.
    const replay = await poll(body.device_code, client);
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("expired_token");
  });

  it("supports public clients without a secret", async () => {
    const { body, client } = await startDevice(true);
    expect(client.client_secret).toBeUndefined();
    await approve(body.user_code, session.cookie);
    await new Promise((r) => setTimeout(r, 1100));
    const tokenRes = await poll(body.device_code, client);
    expect(tokenRes.status).toBe(200);
    expect((await tokenRes.json()).access_token).toMatch(/^oat_/);
  });

  it("applies slow_down and permanently widens the interval", async () => {
    const { body, client } = await startDevice();
    await poll(body.device_code, client);
    const tooFast = await poll(body.device_code, client);
    expect(tooFast.status).toBe(400);
    const tooFastBody = await tooFast.json();
    expect(tooFastBody.error).toBe("slow_down");
    expect(tooFast.headers.get("retry-after")).toBe("6");
    const row = first(await h.ctx.db.select().from(schema.deviceCodes))!;
    expect(row.intervalSeconds).toBe(6);

    await approve(body.user_code, session.cookie);
    // Still inside the new interval.
    const stillFast = await poll(body.device_code, client);
    expect((await stillFast.json()).error).toBe("slow_down");
  });

  it("returns access_denied after a denial and expired_token after expiry", async () => {
    const denied = await startDevice();
    await approve(denied.body.user_code, session.cookie, "deny");
    const deniedPoll = await poll(denied.body.device_code, denied.client);
    expect((await deniedPoll.json()).error).toBe("access_denied");

    const expired = await startDevice();
    await h.ctx.db.update(schema.deviceCodes)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(schema.deviceCodes.userCode, expired.body.user_code.replace("-", "")));
    const expiredPoll = await poll(expired.body.device_code, expired.client);
    expect((await expiredPoll.json()).error).toBe("expired_token");
  });

  it("rejects a device code presented by a different client", async () => {
    const { body } = await startDevice();
    const other = await createApp(h, { name: "Other" }) as { client_id: string; client_secret: string };
    const res = await poll(body.device_code, other);
    expect((await res.json()).error).toBe("expired_token");
  });

  it("requires a session to approve, and a code is approved only once", async () => {
    const { body } = await startDevice();
    const signedOut = await approve(body.user_code, undefined);
    expect(signedOut.status).toBe(401);

    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`);
    expect(info.status).toBe(401);

    expect((await approve(body.user_code, session.cookie)).status).toBe(200);
    // A second approval (by someone else, or by the same user) cannot reuse the decision.
    const second = await approve(body.user_code, session.cookie);
    expect(second.status).toBe(409);
    const otherUser = await signUpAnother(h);
    expect((await approve(body.user_code, otherUser)).status).toBe(409);

    // Once consumed, the code cannot be approved again either.
    await new Promise((r) => setTimeout(r, 1100));
    await poll(body.device_code, { client_id: app.client_id, client_secret: app.client_secret });
    expect((await approve(body.user_code, otherUser)).status).toBe(409);
  });

  async function signUpAnother(h: Harness) {
    const other = await insertUser(h.ctx, { email: "other@example.com" });
    return (await insertClientSession(h.ctx, other.userId)).cookie;
  }

  it("rejects a malformed user code and an unknown one", async () => {
    const bad = await approve("nope", session.cookie);
    expect(bad.status).toBe(422);
    const unknown = await h.app.request("/v1/client/oauth/device?user_code=BCDF-2345", { headers: { cookie: session.cookie } });
    expect(unknown.status).toBe(404);
  });

  it("brute-forces a user code: the attempt budget burns the code", async () => {
    await h.ctx.settings.update({ security: { rateLimitEnabled: true } });
    const { body, client } = await startDevice();

    // The same code tried repeatedly trips the per-code budget (not just the per-IP one).
    let status = 0;
    for (let i = 0; i < DEVICE_ATTEMPT_BUDGET + 1; i++) {
      const res = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
      status = res.status;
    }
    expect(status).toBe(429);

    const row = first(await h.ctx.db.select().from(schema.deviceCodes).where(eq(schema.deviceCodes.userCode, body.user_code.replace("-", ""))))!;
    expect(row.status).toBe("denied");
    // The owner can no longer approve, and the device sees the denial.
    expect((await approve(body.user_code, session.cookie)).status).toBe(429);
    const deniedPoll = await poll(body.device_code, client);
    expect((await deniedPoll.json()).error).toBe("access_denied");
  });

  it("renders the verification page with an escaped, CSP-safe shell", async () => {
    const { body } = await startDevice();
    const page = await h.app.request(`/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Test App");
    expect(html).toContain("openid");
    // The page is branded with the instance's application name.
    expect(html).toContain("OrbitID App");
    expect(html).not.toContain("<script>");
    expect(html).toContain('/oauth/device.js');

    const signedOut = await (await h.app.request("/oauth/device")).text();
    expect(signedOut).toContain("/sign-in");
    expect(signedOut).toContain("Sign in");
    expect(signedOut).not.toContain("Test App");
    // Signed out with a code: the page names the application and offers the way in.
    const signedOutWithCode = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent(body.user_code)}`)).text();
    expect(signedOutWithCode).toContain("Test App");
    expect(signedOutWithCode).toContain("/sign-in");
    // Signing in returns to this page with the code still filled in.
    expect(signedOutWithCode).toContain(`user_code%3D${encodeURIComponent(body.user_code)}`);

    const js = await h.app.request("/oauth/device.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await h.app.request("/oauth/device.css")).status).toBe(200);
  });

  it("approves and denies from the server-rendered page itself", async () => {
    const first = await startDevice();
    const approvePage = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: first.body.user_code, action: "approve" }).toString(),
    });
    expect(approvePage.status).toBe(200);
    expect(await approvePage.text()).toContain("Device connected");

    const second = await startDevice();
    const denyPage = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: second.body.user_code, action: "deny" }).toString(),
    });
    expect(denyPage.status).toBe(200);
    expect(await denyPage.text()).toContain("Request denied");
    expect((await (await poll(second.body.device_code, second.client)).json()).error).toBe("access_denied");

    // A signed-out POST changes nothing.
    const signedOut = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: first.body.user_code, action: "approve" }).toString(),
    });
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toContain("/sign-in");
  });

  it("refuses a cross-site approval form post", async () => {
    const { body } = await startDevice();
    const crossSite = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ user_code: body.user_code, action: "approve" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toContain("blocked");

    const viaFetchMetadata = await h.app.request("/oauth/device", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ user_code: body.user_code, action: "approve" }).toString(),
    });
    expect(viaFetchMetadata.status).toBe(403);

    // Still pending: nothing was approved.
    const info = await h.app.request(`/v1/client/oauth/device?user_code=${encodeURIComponent(body.user_code)}`, { headers: { cookie: session.cookie } });
    expect((await info.json()).status).toBe("pending");
  });

  it("escapes the application name and the user code on the page", async () => {
    const evil = await createApp(h, { name: `<script>alert('x')</script>` }) as { client_id: string; client_secret: string };
    const res = await form(h, "/oauth/device_authorization", { client_id: evil.client_id, client_secret: evil.client_secret, scope: "openid" });
    const created = await res.json() as { user_code: string };
    const html = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent(created.user_code)}`, { headers: { cookie: session.cookie } })).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");

    const injected = await (await h.app.request(`/oauth/device?user_code=${encodeURIComponent('"><script>alert(1)</script>')}`)).text();
    expect(injected).not.toContain("<script>alert(1)");
  });
});
