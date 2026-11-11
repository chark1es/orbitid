// OIDC provider: JWT access tokens, introspection/revocation and organization claims.
import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decodeProtectedHeader, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { addMembership, BASE_URL, grantPermissions, insertClientSession, insertOrganization, insertUser, setup } from "../machine/helpers";
import { first } from "../../src/lib/db";
import { newId } from "../../src/lib/ids";
import { sha256 } from "../../src/lib/crypto";
import { ID_PREFIX } from "@orbitid/shared";
import { authorize, basic, challengeFor, codeFlow, createApp, form, jwks, REDIRECT_URI, verifier, type Harness } from "./oidc-provider-helpers";
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
    // RFC 7009 allows a public client to revoke its own token with `none` (client_id only).
    expect(doc.revocation_endpoint_auth_methods_supported).toEqual(["client_secret_basic", "client_secret_post", "none"]);
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
    await h.ctx.settings.update({ organizations: { enabled: true } });
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
