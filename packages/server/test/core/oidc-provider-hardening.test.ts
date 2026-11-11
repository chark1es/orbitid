// OIDC provider: token endpoint hardening (redirect_uri, replay, PKCE, client auth, scope escalation).
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { insertClientSession, insertUser, setup } from "../machine/helpers";
import { authorize, challengeFor, codeFlow, createApp, form, REDIRECT_URI, verifier, type Harness } from "./oidc-provider-helpers";
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

  it("enforces PKCE when configured and allows confidential clients without it by default", async () => {
    // The default is interop-friendly: Tinyauth, Authentik sources and oauth2-proxy send no challenge.
    const optional = await authorize(h, {
      client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
    }, session.cookie);
    expect(optional.code).toBeTruthy();

    const strict = await createApp(h, { name: "Strict", pkce_required: true }) as { client_id: string };
    const pkce = verifier();
    // `plain` is refused before a code is ever issued.
    const plain = await authorize(h, {
      client_id: strict.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
      code_challenge: pkce, code_challenge_method: "plain",
    }, session.cookie);
    expect(plain.error).toBe("invalid_request");

    const missing = await authorize(h, {
      client_id: strict.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: "openid",
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

  it("refuses refresh scope escalation but accepts a narrower requested scope", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie, "openid email offline_access");
    const escalated = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "openid email admin",
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(escalated.status).toBe(400);
    expect((await escalated.json()).error).toBe("invalid_scope");

    const narrowed = await form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "openid email",
      client_id: app.client_id, client_secret: app.client_secret,
    });
    expect(narrowed.status).toBe(200);
    const next = await narrowed.json() as { scope: string; access_token: string };
    expect(next.scope).toBe("openid email");
    const info = await h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${next.access_token}` } });
    expect(await info.json()).toMatchObject({ sub: user.userId, email: "user@example.com" });
  });

  it("rejects an unknown grant type", async () => {
    const res = await form(h, "/oauth/token", { grant_type: "password", client_id: app.client_id, client_secret: app.client_secret });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
