// Interop: hand-rolled relying parties that mimic Tinyauth, Authentik's OAuth source and oauth2-proxy.
// These intentionally avoid openid-client so they exercise the wire format the real products use.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { createApplication } from "../../src/services/oidc";
import { sha256 } from "../../src/lib/crypto";
import { addMembership, insertClientSession, insertOrganization, insertUser } from "../machine/helpers";
import { startOidcServer, type OidcTestServer } from "../support/oidc-server";

const REDIRECT_URI = "http://localhost:3000/callback";
const verifier = () => randomBytes(32).toString("base64url");
const challengeFor = (value: string) => createHash("sha256").update(value).digest("base64url");
const basic = (clientId: string, secret: string, encode = false) => {
  const id = encode ? encodeURIComponent(clientId) : clientId;
  const key = encode ? encodeURIComponent(secret) : secret;
  return `Basic ${Buffer.from(`${id}:${key}`).toString("base64")}`;
};
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
  });

async function authorizeUrl(s: OidcTestServer, params: Record<string, string>, cookie?: string) {
  const response = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams(params)}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
  if (response.status === 302) return { status: response.status, location: new URL(response.headers.get("location")!), response };
  return { status: response.status, location: null, response };
}

describe("OIDC interop — hand-rolled relying parties", () => {
  let s: OidcTestServer;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;

  beforeEach(async () => {
    s = await startOidcServer();
    user = await insertUser(s.ctx, { username: "ada", firstName: "Ada", lastName: "Lovelace" });
    session = await insertClientSession(s.ctx, user.userId);
  });

  afterEach(async () => {
    await s.close();
  });

  it("works like Tinyauth: static endpoints, no PKCE, client_secret_post, userinfo only", async () => {
    await s.ctx.settings.update({ organizations: { enabled: true } });
    const org = await insertOrganization(s.ctx, "Acme");
    await addMembership(s.ctx, org.orgId, user.userId, "org:admin");
    const app = await createApplication(s.ctx, {
      name: "Tinyauth", redirectUris: [REDIRECT_URI], scopes: "openid profile email groups", groupsClaim: "all", consentScreenEnabled: false,
    });
    const discovery = await (await fetch(`${s.baseUrl}/.well-known/openid-configuration`)).json() as Record<string, string>;

    const auth = await authorizeUrl(s, {
      client_id: app.row.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile email groups",
      state: "tinyauth-state",
    }, session.cookie);
    expect(auth.status).toBe(302);
    expect(auth.location!.searchParams.get("state")).toBe("tinyauth-state");
    const code = auth.location!.searchParams.get("code")!;

    // Tinyauth's custom-provider path posts the credentials in the body and does not send PKCE.
    const tokenResponse = await post(discovery.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: app.row.clientId,
      client_secret: app.clientSecret!,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, string>;

    // It maps the profile from userinfo, so that endpoint must return every standard claim.
    const userinfo = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(userinfo.status).toBe(200);
    expect(userinfo.headers.get("content-type")).toContain("application/json");
    const claims = await userinfo.json() as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: user.userId,
      email: "user@example.com",
      email_verified: true,
      name: "Ada Lovelace",
      preferred_username: "ada",
    });
    expect(claims.groups).toEqual(expect.arrayContaining(["org:admin"]));
  });

  it("works like an Authentik OAuth/OpenID source: basic auth, no id_token reliance, preferred_username mapping", async () => {
    const app = await createApplication(s.ctx, {
      name: "Authentik source", redirectUris: [REDIRECT_URI], scopes: "openid profile email", consentScreenEnabled: false,
    });
    const auth = await authorizeUrl(s, {
      client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid profile email",
    }, session.cookie);
    const code = auth.location!.searchParams.get("code")!;

    const tokenResponse = await post(`${s.baseUrl}/oauth/token`, {
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
    }, { authorization: basic(app.row.clientId, app.clientSecret!) });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as Record<string, string>;
    expect(tokens.id_token).toBeTruthy();

    const profile = await fetch(`${s.baseUrl}/oauth/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const claims = await profile.json() as Record<string, unknown>;
    expect(claims.sub).toBe(user.userId);
    expect(claims.preferred_username).toBe("ada");
    expect(claims.email).toBe("user@example.com");
  });

  it("accepts RFC 6749 form-encoded Basic credentials and the unencoded common mistake", async () => {
    const app = await createApplication(s.ctx, {
      name: "Encoded", redirectUris: [REDIRECT_URI], scopes: "openid", consentScreenEnabled: false,
    });
    const secret = "s3cret with space:and-colon";
    await s.ctx.db.update(schema.oauthApplications).set({ clientSecretHash: sha256(secret) }).where(eq(schema.oauthApplications.id, app.row.id));

    const codeFor = async () => {
      const auth = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid" }, session.cookie);
      return auth.location!.searchParams.get("code")!;
    };
    for (const encoded of [true, false]) {
      const response = await post(`${s.baseUrl}/oauth/token`, {
        grant_type: "authorization_code", code: await codeFor(), redirect_uri: REDIRECT_URI,
      }, { authorization: basic(app.row.clientId, secret, encoded) });
      expect(response.status).toBe(200);
    }
  });

  it("works like oauth2-proxy: discovery, cookie-held tokens, refresh, then end_session", async () => {
    const app = await createApplication(s.ctx, {
      name: "oauth2-proxy",
      redirectUris: [REDIRECT_URI],
      postLogoutRedirectUris: ["http://localhost:3000/oauth2/sign_out"],
      scopes: "openid profile email offline_access",
      consentScreenEnabled: false,
    });
    const discovery = await (await fetch(`${s.baseUrl}/.well-known/openid-configuration`)).json() as Record<string, string>;
    const state = randomBytes(8).toString("hex");
    const nonce = randomBytes(8).toString("hex");
    const auth = await authorizeUrl(s, {
      client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code",
      scope: "openid profile email offline_access", state, nonce,
    }, session.cookie);
    expect(auth.location!.searchParams.get("state")).toBe(state);
    const tokens = await (await post(discovery.token_endpoint, {
      grant_type: "authorization_code", code: auth.location!.searchParams.get("code")!, redirect_uri: REDIRECT_URI,
    }, { authorization: basic(app.row.clientId, app.clientSecret!) })).json() as Record<string, string>;
    expect(decodeJwt(tokens.id_token).nonce).toBe(nonce);

    const refreshed = await (await post(discovery.token_endpoint, {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token!,
    }, { authorization: basic(app.row.clientId, app.clientSecret!) })).json() as Record<string, string>;
    expect(refreshed.access_token).not.toBe(tokens.access_token);

    const logout = await fetch(`${discovery.end_session_endpoint}?${new URLSearchParams({
      id_token_hint: tokens.id_token,
      post_logout_redirect_uri: "http://localhost:3000/oauth2/sign_out",
      state: "bye",
    })}`, { redirect: "manual" });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toContain("state=bye");
  });

  it("returns spec errors and refuses unsafe redirect/logout URIs", async () => {
    const app = await createApplication(s.ctx, {
      name: "Strict", redirectUris: [REDIRECT_URI], postLogoutRedirectUris: ["http://localhost:3000/bye"], scopes: "openid", consentScreenEnabled: false,
    });
    const badRedirect = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams({
      client_id: app.row.clientId, redirect_uri: "https://evil.example/cb", response_type: "code", scope: "openid",
    })}`, { redirect: "manual" });
    expect(badRedirect.status).toBe(400);
    expect((await badRedirect.json() as Record<string, string>).error).toBe("invalid_request");

    const signedOut = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", prompt: "none" });
    expect(signedOut.location!.searchParams.get("error")).toBe("login_required");

    // Silent SSO with an existing session.
    const silent = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", prompt: "none" }, session.cookie);
    expect(silent.location!.searchParams.get("code")).toBeTruthy();

    // A stale session cannot satisfy max_age; a non-none prompt goes to sign-in without looping.
    await s.ctx.db.update(schema.sessions).set({ firstFactorVerifiedAt: Date.now() - 10 * 60_000 }).where(eq(schema.sessions.id, session.sessionId));
    const staleSilent = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", prompt: "none", max_age: "60" }, session.cookie);
    expect(staleSilent.location!.searchParams.get("error")).toBe("login_required");
    const staleInteractive = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", max_age: "60" }, session.cookie);
    expect(staleInteractive.location!.pathname).toBe("/sign-in");
    expect(new URL(staleInteractive.location!.searchParams.get("redirect_url")!).searchParams.get("max_age")).toBeNull();

    // login_hint for another real account is not a silent SSO.
    await insertUser(s.ctx, { email: "other-hint@example.com", username: "other-hint" });
    const hint = await authorizeUrl(s, { client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", prompt: "none", login_hint: "other-hint@example.com" }, session.cookie);
    expect(hint.location!.searchParams.get("error")).toBe("login_required");

    const badLogout = await fetch(`${s.baseUrl}/oauth/end_session?${new URLSearchParams({
      client_id: app.row.clientId, post_logout_redirect_uri: "https://evil.example/bye",
    })}`, { redirect: "manual" });
    expect(badLogout.status).toBe(400);
    expect((await badLogout.json() as Record<string, string>).error).toBe("invalid_request");

    const badHint = await fetch(`${s.baseUrl}/oauth/end_session?${new URLSearchParams({
      id_token_hint: "not-a-token", post_logout_redirect_uri: "http://localhost:3000/bye",
    })}`, { redirect: "manual" });
    expect(badHint.status).toBe(400);
  });

  it("supports response_mode=form_post and prompt=login/max_age without a redirect loop", async () => {
    const app = await createApplication(s.ctx, {
      name: "Form post", redirectUris: [REDIRECT_URI], scopes: "openid profile", consentScreenEnabled: false,
    });
    const formPost = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams({
      client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", state: "fp", response_mode: "form_post",
    })}`, { redirect: "manual", headers: { cookie: session.cookie } });
    expect(formPost.status).toBe(200);
    expect(formPost.headers.get("content-security-policy")).toContain("form-action http://localhost:3000");
    const html = await formPost.text();
    expect(html).toContain(`action="${REDIRECT_URI}"`);
    expect(html).toContain('name="code"');
    expect(html).toContain('name="state" value="fp"');

    const forced = await authorizeUrl(s, {
      client_id: app.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid", prompt: "login", max_age: "0",
    }, session.cookie);
    expect(forced.status).toBe(302);
    expect(forced.location!.origin + forced.location!.pathname).toBe("http://localhost:3000/sign-in");
    const returnUrl = new URL(forced.location!.searchParams.get("redirect_url")!);
    expect(returnUrl.searchParams.get("prompt")).toBeNull();
    expect(returnUrl.searchParams.get("max_age")).toBeNull();
  });

  it("accepts any loopback port for native clients but not a changed host or path", async () => {
    const app = await createApplication(s.ctx, {
      name: "Native", redirectUris: ["http://127.0.0.1/callback"], scopes: "openid", consentScreenEnabled: false, pkceRequired: true,
    });
    const ok = await authorizeUrl(s, {
      client_id: app.row.clientId, redirect_uri: "http://127.0.0.1:53121/callback", response_type: "code", scope: "openid",
      code_challenge: challengeFor(verifier()), code_challenge_method: "S256",
    }, session.cookie);
    expect(ok.location!.searchParams.get("code")).toMatch(/^oac_/);

    for (const redirect of ["http://localhost:53121/callback", "http://127.0.0.1:53121/other"]) {
      const rejected = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams({
        client_id: app.row.clientId, redirect_uri: redirect, response_type: "code", scope: "openid",
      })}`, { redirect: "manual", headers: { cookie: session.cookie } });
      expect(rejected.status).toBe(400);
    }
  });

  it("requires PKCE only when the application asks for it", async () => {
    const plain = await createApplication(s.ctx, {
      name: "No PKCE", redirectUris: [REDIRECT_URI], scopes: "openid", consentScreenEnabled: false,
    });
    const allowed = await authorizeUrl(s, { client_id: plain.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid" }, session.cookie);
    expect(allowed.location!.searchParams.get("code")).toBeTruthy();

    const strict = await createApplication(s.ctx, {
      name: "PKCE required", redirectUris: [REDIRECT_URI], scopes: "openid", consentScreenEnabled: false, pkceRequired: true,
    });
    const refused = await authorizeUrl(s, { client_id: strict.row.clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid" }, session.cookie);
    expect(refused.location!.searchParams.get("error")).toBe("invalid_request");
  });
});
