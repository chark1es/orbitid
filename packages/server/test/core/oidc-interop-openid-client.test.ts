// Interop: the certified `openid-client` package is the relying party against a real HTTP OrbitID server.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as oidc from "openid-client";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { createApplication, getApplication } from "../../src/services/oidc";
import { addMembership, grantPermissions, insertClientSession, insertOrganization, insertUser } from "../machine/helpers";
import { startOidcServer, type OidcTestServer } from "../support/oidc-server";

const REDIRECT_URI = "http://localhost:3000/callback";
const POST_LOGOUT_URI = "http://localhost:3000/signed-out";
const SCOPES = "openid profile email phone groups organizations offline_access";

describe("OIDC interop — openid-client relying party", () => {
  let s: OidcTestServer;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { client_id: string; clientSecret: string; id: string };

  beforeEach(async () => {
    s = await startOidcServer();
    user = await insertUser(s.ctx, { username: "ada", firstName: "Ada", lastName: "Lovelace" });
    const now = Date.now();
    await s.ctx.db.update(schema.users).set({ publicMetadata: { locale: "en-GB" } }).where(eq(schema.users.id, user.userId));
    await s.ctx.db.insert(schema.phoneNumbers).values({ id: "phone_interop", userId: user.userId, phone: "+15555550123", verified: true, verifiedAt: now, reservedForSecondFactor: false, defaultSecondFactor: false, createdAt: now, updatedAt: now });
    await s.ctx.db.update(schema.users).set({ primaryPhoneNumberId: "phone_interop" }).where(eq(schema.users.id, user.userId));
    session = await insertClientSession(s.ctx, user.userId);
    const created = await createApplication(s.ctx, {
      name: "OpenID Client",
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: [POST_LOGOUT_URI],
      scopes: SCOPES,
      // This RP asks for the groups scope, so it must also opt into a groups-claim mode (new apps default to none).
      groupsClaim: "all",
      consentScreenEnabled: false,
      pkceRequired: false,
    });
    app = { client_id: created.row.clientId, clientSecret: created.clientSecret!, id: created.row.id };
  });

  afterEach(async () => {
    await s.close();
  });

  /** Runs discovery + authorize + token through openid-client and returns everything a client would keep. */
  async function signIn(scopes = SCOPES) {
    // The loopback test server is plain HTTP; production OrbitID issuers are HTTPS.
    const config = await oidc.discovery(new URL(s.baseUrl), app.client_id, app.clientSecret, undefined, {
      execute: [oidc.allowInsecureRequests],
    });
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authorizationUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const response = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie: session.cookie } });
    expect(response.status).toBe(302);
    const callbackUrl = new URL(response.headers.get("location")!);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(REDIRECT_URI);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    return { config, tokens, authorizationUrl };
  }

  it("completes discovery → code + PKCE → token → userinfo → refresh → revoke → logout", async () => {
    const { config, tokens } = await signIn();
    expect(tokens.token_type?.toLowerCase()).toBe("bearer");
    // New applications issue short-lived access tokens by default (<= 5 minutes).
    expect(tokens.expires_in).toBe(300);
    expect(tokens.scope).toBe(SCOPES);
    expect(tokens.refresh_token).toMatch(/^ort_/);
    expect(tokens.id_token).toBeTruthy();

    const claims = tokens.claims()!;
    expect(claims).toMatchObject({
      iss: s.baseUrl,
      sub: user.userId,
      aud: app.client_id,
      azp: app.client_id,
      email: "user@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      preferred_username: "ada",
      locale: "en-GB",
      phone_number: "+15555550123",
      phone_number_verified: true,
      sid: session.sessionId,
    });
    expect(typeof claims.iat).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(typeof claims.auth_time).toBe("number");
    expect(typeof claims.at_hash).toBe("string");

    const userinfo = await oidc.fetchUserInfo(config, tokens.access_token, user.userId);
    expect(userinfo).toMatchObject({
      sub: user.userId,
      email: "user@example.com",
      preferred_username: "ada",
      name: "Ada Lovelace",
    });

    const refreshed = await oidc.refreshTokenGrant(config, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect(refreshed.scope).toBe(SCOPES);

    await oidc.tokenRevocation(config, tokens.access_token, { token_type_hint: "access_token" });
    const denied = await fetch(`${s.baseUrl}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");

    const logout = oidc.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: POST_LOGOUT_URI,
      state: "logout-state",
    });
    const logoutResponse = await fetch(logout, { redirect: "manual" });
    expect(logoutResponse.status).toBe(302);
    const target = new URL(logoutResponse.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(POST_LOGOUT_URI);
    expect(target.searchParams.get("state")).toBe("logout-state");

    const ended = (await s.ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, session.sessionId)))[0]!;
    expect(ended.status).toBe("ended");
    const revoked = await fetch(`${s.baseUrl}/oauth/userinfo`, { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(revoked.status).toBe(401);
  });

  it("publishes RFC-compliant metadata and CORS for browser clients", async () => {
    const response = await fetch(`${s.baseUrl}/.well-known/openid-configuration`);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const doc = await response.json() as Record<string, unknown>;
    expect(doc.issuer).toBe(s.baseUrl);
    for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri", "revocation_endpoint", "introspection_endpoint", "end_session_endpoint"]) {
      expect(String(doc[key])).toMatch(new RegExp(`^${s.baseUrl}/`));
    }
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.response_modes_supported).toEqual(expect.arrayContaining(["query", "form_post"]));
    expect(doc.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(["client_secret_basic", "client_secret_post", "none"]));
    expect(doc.scopes_supported).toEqual(expect.arrayContaining(["openid", "profile", "email", "phone", "groups", "offline_access", "organizations"]));
    expect(doc.claims_supported).toEqual(expect.arrayContaining(["auth_time", "at_hash", "azp", "sid", "groups", "phone_number"]));
    expect(doc.request_parameter_supported).toBe(false);

    const authServer = await fetch(`${s.baseUrl}/.well-known/oauth-authorization-server`);
    expect(authServer.status).toBe(200);
    expect((await authServer.json() as Record<string, unknown>).issuer).toBe(s.baseUrl);

    const jwks = await fetch(`${s.baseUrl}/oauth/jwks`);
    expect(jwks.headers.get("access-control-allow-origin")).toBe("*");
    const key = (await jwks.json() as { keys: Record<string, unknown>[] }).keys[0]!;
    expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(typeof key.kid).toBe("string");
  });

  it("issues groups and organization claims, and lets the app choose the groups value", async () => {
    await s.ctx.settings.update({ organizations: { enabled: true } });
    const org = await insertOrganization(s.ctx, "Acme");
    await grantPermissions(s.ctx, "org:admin", ["org:sys_memberships:manage"]);
    await addMembership(s.ctx, org.orgId, user.userId, "org:admin");
    await s.ctx.db.update(schema.sessions).set({ lastActiveOrganizationId: org.orgId }).where(eq(schema.sessions.id, session.sessionId));
    await s.ctx.db.insert(schema.roles).values({ id: "role_instance_reviewer", key: "app:reviewer", name: "Reviewer", description: "", isCreatorEligible: false, isSystem: false, createdAt: Date.now(), updatedAt: Date.now() });
    await s.ctx.db.insert(schema.userRoles).values({ userId: user.userId, roleKey: "app:reviewer", createdAt: Date.now(), updatedAt: Date.now() });

    const { tokens } = await signIn("openid profile email groups organizations");
    const claims = tokens.claims()!;
    expect(claims.org_id).toBe(org.orgId);
    expect(claims.org_role).toBe("org:admin");
    expect(claims.groups).toEqual(expect.arrayContaining(["org:admin", "app:reviewer"]));
    const orgs = claims.organizations as { name: string }[];
    expect(orgs.map((entry) => entry.name)).toContain("Acme");

    const row = (await getApplication(s.ctx, app.id))!;
    await s.ctx.db.update(schema.oauthApplications).set({ groupsClaim: "organizations" }).where(eq(schema.oauthApplications.id, row.id));
    const scoped = await signIn("openid email groups");
    const scopedGroups = scoped.tokens.claims()!.groups as unknown[];
    expect(typeof scopedGroups[0]).toBe("string");
  });

  it("honours the per-application token lifetimes", async () => {
    const tuned = await createApplication(s.ctx, {
      name: "Short lived", redirectUris: [REDIRECT_URI], scopes: "openid profile",
      consentScreenEnabled: false, accessTokenLifetimeSeconds: 120, idTokenLifetimeSeconds: 300,
    });
    const config = await oidc.discovery(new URL(s.baseUrl), tuned.row.clientId, tuned.clientSecret!, undefined, {
      execute: [oidc.allowInsecureRequests],
    });
    const authorizationUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: REDIRECT_URI, scope: "openid profile", state: "ttl" });
    const response = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie: session.cookie } });
    const tokens = await oidc.authorizationCodeGrant(config, new URL(response.headers.get("location")!), { expectedState: "ttl" });
    expect(tokens.expires_in).toBe(120);
    const claims = tokens.claims()!;
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(tokens.scope).toBe("openid profile");
  });

  it("supports a public client with PKCE and no client secret", async () => {
    const publicApp = await createApplication(s.ctx, {
      name: "SPA", redirectUris: [REDIRECT_URI], scopes: "openid profile email", consentScreenEnabled: false, isPublic: true,
    });
    const config = await oidc.discovery(new URL(s.baseUrl), publicApp.row.clientId, undefined, undefined, {
      execute: [oidc.allowInsecureRequests],
    });
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const authorizationUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI, scope: "openid profile email", state,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
    });
    const response = await fetch(authorizationUrl, { redirect: "manual", headers: { cookie: session.cookie } });
    const tokens = await oidc.authorizationCodeGrant(config, new URL(response.headers.get("location")!), { pkceCodeVerifier: verifier, expectedState: state });
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toBeUndefined();
  });
});
